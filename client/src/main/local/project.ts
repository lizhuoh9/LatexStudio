import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DocumentSnapshot, ProjectFile, ProjectInfo } from '../../shared/workspace-contracts'
import { code, decodeText, digest, encodeText, failure, LIMITS, SafeProject } from './paths'
import { withProjectWriteLock } from './write-lock'

export interface ProjectWrite {
  path: string
  before: Buffer | null
  after: Buffer
  kind?: 'save' | 'create' | 'restore'
  summary?: string
}
export interface ProjectWriteReceipt { commit(): Promise<void>; abort(): Promise<void> }
export interface ProjectServiceOptions {
  /** Runs under the shared project lock; callbacks must not reacquire that lock. */
  beforeWrite?: (project: SafeProject, change: ProjectWrite) => Promise<ProjectWriteReceipt | void>
}
export interface SaveOptions { kind?: 'save' | 'restore'; summary?: string }

export class ProjectService {
  private readonly project: SafeProject
  private listeners = new Set<(paths: string[]) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private fingerprints = new Map<string, string>()
  private polling = false
  private disposed = false
  private pending: Promise<unknown> = Promise.resolve()

  constructor(root: string, private readonly options: ProjectServiceOptions = {}) { this.project = new SafeProject(root) }
  async initialize(): Promise<ProjectInfo> {
    this.assertActive()
    await this.project.initialize()
    const files = await this.list()
    this.fingerprints = await this.scan(files)
    const tex = files.filter((file) => file.kind === 'text' && /\.tex$/i.test(file.path))
    const main = tex.find((file) => /(^|\/)(main|document|paper)\.tex$/i.test(file.path)) ?? tex[0]
    return { id: createHash('sha256').update(this.project.root).digest('hex'),
      name: basename(this.project.root), root: this.project.root, files, defaultMain: main?.path ?? null }
  }
  async list(): Promise<ProjectFile[]> {
    this.assertActive()
    return this.project.list(true)
  }
  async read(path: string): Promise<DocumentSnapshot> {
    this.assertActive()
    const bytes = await this.project.readBytes(path, LIMITS.text)
    return { path, content: decodeText(bytes), revision: digest(bytes) }
  }
  save(path: string, content: string, revision: string, options: SaveOptions = {}): Promise<DocumentSnapshot> {
    return this.serial(async () => withProjectWriteLock(this.project, async () => {
      this.assertActive()
      if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw failure('文件版本无效，请重新读取')
      const bytes = encodeText(content)
      const original = await this.project.readBytes(path, LIMITS.text)
      decodeText(original)
      if (digest(original) !== revision) throw failure('文件已被外部程序修改，保存冲突；请重新读取后处理')
      return this.transaction({ path, before: original, after: bytes, kind: options.kind ?? 'save', summary: options.summary },
        () => this.replace(path, bytes, revision))
    }))
  }
  create(path: string, content: string): Promise<DocumentSnapshot> {
    return this.serial(async () => withProjectWriteLock(this.project, async () => {
      this.assertActive()
      const bytes = encodeText(content), target = await this.project.resolve(path, true)
      const existing = await lstat(target).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error; return null })
      if (existing) throw failure('文件已存在，不能覆盖')
      return this.transaction({ path, before: null, after: bytes, kind: 'create' }, async () => {
        const handle = await open(target, 'wx', 0o600).catch((error: unknown) => {
          if (code(error) === 'EEXIST') throw failure('文件已存在，不能覆盖')
          throw error
        })
        try { await handle.writeFile(bytes); await handle.sync() }
        finally { await handle.close() }
      })
    }))
  }
  private async transaction(change: ProjectWrite, write: () => Promise<void>): Promise<DocumentSnapshot> {
    const receipt = await this.options.beforeWrite?.(this.project,
      { ...change, before: change.before && Buffer.from(change.before), after: Buffer.from(change.after) })
    try {
      await write()
      const saved = await this.project.readBytes(change.path, LIMITS.text)
      if (!saved.equals(change.after)) throw failure('写入后文件或连接状态已变化，保存未确认；请保留草稿并重新读取比较。')
      await receipt?.commit()
      return { path: change.path, content: decodeText(saved), revision: digest(saved) }
    } catch (error) {
      try { await receipt?.abort() } catch (cleanup) {
        throw new AggregateError([error, cleanup], `${error instanceof Error ? error.message : '保存失败'}；历史事务恢复未确认，请保留草稿。`)
      }
      throw error
    }
  }
  /** `intervalMs`: 500 ms locally; shared (SMB) folders poll less often because every scan is many round-trips. */
  watch(listener: (paths: string[]) => void, intervalMs = 500): () => void {
    this.assertActive()
    this.listeners.add(listener)
    if (!this.timer) {
      this.timer = setInterval(() => { void this.poll() }, intervalMs)
      this.timer.unref()
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = undefined }
    }
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }
  private assertActive(): void { if (this.disposed) throw failure('项目已关闭') }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => { this.assertActive(); return operation() })
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }
  private async replace(path: string, bytes: Buffer, revision: string): Promise<void> {
    const target = await this.project.resolve(path)
    const info = await lstat(target)
    const temporary = join(dirname(target), `.paperstudio-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', info.mode & 0o777)
    let primary: unknown, failed = false
    try {
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      const latest = await this.project.readBytes(path, LIMITS.text)
      const current = await lstat(await this.project.resolve(path))
      if (digest(latest) !== revision || current.ino !== info.ino || current.dev !== info.dev)
        throw failure('文件在保存期间被外部程序修改，保存已取消')
      await rename(temporary, target)
    } catch (error) { failed = true; primary = error }
    try {
      await handle.close()
      await this.project.verifyRoot()
      await unlink(temporary).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error })
    } catch (cleanup) {
      if (failed) throw new AggregateError([primary, cleanup], `${primary instanceof Error ? primary.message : '保存失败'}；临时文件清理未确认。`)
      throw cleanup
    }
    if (failed) throw primary
  }
  private async scan(files?: ProjectFile[]): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const file of files ?? await this.list()) {
      const info = await lstat(await this.project.resolve(file.path))
      result.set(file.path, `${file.kind}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    }
    return result
  }
  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return
    this.polling = true
    try {
      const next = await this.scan()
      const paths = [...new Set([...next.keys(), ...this.fingerprints.keys()])]
        .filter((path) => next.get(path) !== this.fingerprints.get(path))
      this.fingerprints = next
      if (paths.length) this.emit(paths)
    } catch { this.emit(['']) } // Empty path asks the UI to rescan, including an unavailable/replaced root.
    finally { this.polling = false }
  }
  private emit(paths: string[]): void {
    if (this.disposed) return
    for (const listener of this.listeners) {
      try { listener(paths) }
      catch { process.emitWarning('项目文件变更监听器失败') }
    }
  }
}
