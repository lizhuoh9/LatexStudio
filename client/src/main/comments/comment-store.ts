import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { COMMENT_DIRECTORY, COMMENT_FILE_NAME, COMMENT_LIMITS, isCommentDevice, parseCommentEvent,
  serializeCommentEvent, type CommentEvent } from '../../shared/comment-contracts'
import { code, failure, inside, SafeProject } from '../local/paths'
import { withProjectWriteLock } from '../local/write-lock'

export interface CommentFileRead { events: CommentEvent[]; unreadable: number }
const UNSAFE = '评论目录包含符号链接或特殊文件，未读取或写入评论。'
const FULL = '本机的评论文件已达到大小上限，未写入新评论。'
const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

/** Reads every device's comment log and appends to this device's own log, inside one project folder.
 * Comment files are deliberately outside the editor's file list and compile copy; they are reached only here,
 * with the same no-link, stay-inside-the-project rules as other project files.
 */
export class CommentStore {
  private readonly project: SafeProject
  private initialized = false
  constructor(root: string) { this.project = new SafeProject(root) }

  async list(): Promise<CommentFileRead> {
    const directory = await this.directory(false)
    if (!directory) return { events: [], unreadable: 0 }
    const names: string[] = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      if (COMMENT_FILE_NAME.test(entry.name)) names.push(entry.name)
      if (names.length > COMMENT_LIMITS.files) break
    }
    const result: CommentFileRead = { events: [], unreadable: Math.max(0, names.length - COMMENT_LIMITS.files) }
    let budget = COMMENT_LIMITS.totalBytes
    for (const name of names.sort().slice(0, COMMENT_LIMITS.files)) {
      // A file removed by a concurrent checkout reads as empty; the next refresh sees the new state.
      const bytes = await this.readFile(join(directory, name), Math.min(budget, COMMENT_LIMITS.fileBytes), true)
      if (!bytes) { result.unreadable += 1; continue }
      budget -= bytes.length
      this.parse(bytes, result)
    }
    return result
  }

  async append(device: string, event: CommentEvent): Promise<void> {
    if (!isCommentDevice(device)) throw failure('本机评论身份无效，未写入评论。')
    const line = Buffer.from(`${serializeCommentEvent(event)}\n`, 'utf8')
    await this.ready()
    await withProjectWriteLock(this.project, async () => {
      const directory = (await this.directory(true))!, target = join(directory, `${device}.jsonl`)
      const before = await this.readFile(target, COMMENT_LIMITS.fileBytes, true)
      if (before === null) throw failure('本机的评论文件无法安全读取，未写入新评论。')
      const prefix = before.length && before[before.length - 1] !== 0x0a ? Buffer.from('\n') : Buffer.alloc(0)
      const after = Buffer.concat([before, prefix, line])
      if (after.length > COMMENT_LIMITS.fileBytes) throw failure(FULL)
      await this.replace(directory, target, before, after)
    })
  }

  private async ready(): Promise<void> {
    if (!this.initialized) { await this.project.initialize(); this.initialized = true }
    await this.project.verifyRoot()
  }

  /** `.latexstudio/comments`, checked one level at a time; created only for a write. */
  private async directory(create: boolean): Promise<string | null> {
    await this.ready()
    const root = await realpath(this.project.root)
    let current = this.project.root, expected = root
    for (const part of COMMENT_DIRECTORY.split('/')) {
      current = join(current, part); expected = join(expected, part)
      let info: Stats | null = await lstat(current).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error; return null })
      if (!info) {
        if (!create) return null
        await mkdir(current).catch((error: unknown) => { if (code(error) !== 'EEXIST') throw error })
        info = await lstat(current)
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw failure(UNSAFE)
      const canonical = await realpath(current)
      if (!inside(root, canonical) || pathKey(canonical) !== pathKey(expected)) throw failure(UNSAFE)
    }
    await this.project.verifyRoot()
    return current
  }

  /** Bounded, no-link read of one regular file; null when it is not one or exceeds `limit`. */
  private async readFile(path: string, limit: number, allowMissing = false): Promise<Buffer | null> {
    const info = await lstat(path).catch((error: unknown) => { if (code(error) === 'ENOENT' && allowMissing) return null; throw error })
    if (!info) return Buffer.alloc(0)
    if (info.isSymbolicLink() || !info.isFile() || info.size > limit) return null
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > limit) return null
      const bytes = Buffer.alloc(opened.size + 1)
      let total = 0
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
        if (!bytesRead) break
        total += bytesRead
      }
      const after = await handle.stat()
      if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return null
      return bytes.subarray(0, total)
    } finally { await handle.close() }
  }

  private parse(bytes: Buffer, result: CommentFileRead): void {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { result.unreadable += 1; return }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      if (result.events.length >= COMMENT_LIMITS.events) { result.unreadable += 1; continue }
      let value: unknown = null
      try { if (Buffer.byteLength(line) <= COMMENT_LIMITS.lineBytes) value = JSON.parse(line) } catch { value = null }
      const event = parseCommentEvent(value)
      if (event) result.events.push(event); else result.unreadable += 1
    }
  }

  /** Atomic replace with the same checks as ordinary saves: unchanged before rename, exact bytes after. */
  private async replace(directory: string, target: string, before: Buffer, after: Buffer): Promise<void> {
    const temporary = join(directory, `.paperstudio-comment-${randomUUID()}.tmp`)
    let created = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      created = true
      try { await handle.writeFile(after); await handle.sync() } finally { await handle.close() }
      const current = await this.readFile(target, COMMENT_LIMITS.fileBytes, true)
      if (!current || !current.equals(before)) throw failure('评论文件在写入期间被其他程序修改，未写入新评论；请重试。')
      await this.project.verifyRoot()
      await rename(temporary, target); created = false
      const saved = await this.readFile(target, COMMENT_LIMITS.fileBytes, true)
      if (!saved || !saved.equals(after)) throw failure('写入后评论文件内容不一致，请检查后重试。')
    } finally {
      if (created) await unlink(temporary).catch((error: unknown) => { if (code(error) !== 'ENOENT') throw error })
    }
  }
}
