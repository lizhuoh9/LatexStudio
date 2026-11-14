import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectInfo } from '../../shared/workspace-contracts'
import type { ProjectLibraryEntry } from '../../shared/project-library-contracts'
import { SafeProject } from '../local/paths'
import { withProjectWriteLock } from '../local/write-lock'

const NAME = 'project-library.json', MAX_BYTES = 1024 * 1024, MAX_PROJECTS = 50
const ID = /^[a-f0-9]{32}$/
class LibraryError extends Error {}
const invalid = (): LibraryError => new LibraryError('项目列表无法安全读取或保存；原记录和项目文件未删除，请检查应用数据目录。')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
// Windows file IDs can exceed Number's exact range; retain bigint identities for roots and metadata files.
const identity = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino
function normalizedRoot(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 16 * 1024 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw invalid()
  try { return new SafeProject(value).root } catch { throw invalid() }
}
function rootKey(root: string): string { return process.platform === 'win32' ? root.toLowerCase() : root }
/** Stable opaque metadata ID, not an authorization capability. Windows path casing does not duplicate projects. */
export function projectIdForRoot(root: string): string { return hash(rootKey(normalizedRoot(root))).slice(0, 32) }
function checkedName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw invalid()
  return value
}
function record(value: unknown, fields: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length &&
    fields.every(key => Object.hasOwn(value, key))
}
function checkedEntry(value: unknown): ProjectLibraryEntry {
  if (!record(value, ['id', 'name', 'root', 'lastOpenedAt'])) throw invalid()
  const root = normalizedRoot(value.root), stamp = value.lastOpenedAt
  if (value.root !== root || value.id !== projectIdForRoot(root) || typeof stamp !== 'string' || stamp.length !== 24 ||
    !Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) throw invalid()
  return { id: value.id as string, name: checkedName(value.name), root, lastOpenedAt: stamp }
}
function checkedEntries(bytes: Buffer): ProjectLibraryEntry[] {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  if (!record(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_PROJECTS) throw invalid()
  const entries = value.entries.map(checkedEntry), ids = new Set(entries.map(entry => entry.id))
  if (ids.size !== entries.length) throw invalid()
  return entries.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.id.localeCompare(b.id))
}
async function privateParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
    } catch (error) { if (!missing(error)) throw error }
    if (current === dirname(current)) return
  }
}
async function verifiedProject(root: string): Promise<void> {
  try {
    await privateParents(root)
    const project = new SafeProject(root)
    await project.initialize()
    if (rootKey(await realpath(root)) !== rootKey(root)) throw invalid()
    await project.verifyRoot()
  } catch { throw new LibraryError('项目目录已不可用、被替换或经过链接；请重新打开，或仅从列表移除此项。') }
}
interface Snapshot { entries: ProjectLibraryEntry[]; revision: string | null }
function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return identity(before, after) && after.isFile() && !after.isSymbolicLink() && after.nlink === 1n && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

/** Only local folder metadata is persisted. Contents, GitHub routing and credentials remain per-project elsewhere. */
export class ProjectLibrary {
  private readonly directory: SafeProject
  private initialized = false
  private rootIdentity: BigIntStats | undefined
  private pending: Promise<unknown> = Promise.resolve()
  constructor(dataRoot: string) { this.directory = new SafeProject(dataRoot) }

  list(): Promise<ProjectLibraryEntry[]> { return this.serial(async () => (await this.read()).entries) }
  remember(info: ProjectInfo): Promise<string> {
    let value: { root: string; name: string }
    try { value = { root: normalizedRoot(info.root), name: checkedName(info.name) } } catch { return Promise.reject(invalid()) }
    return this.change(async before => {
      await verifiedProject(value.root)
      const id = projectIdForRoot(value.root), entries = before.entries.filter(entry => entry.id !== id)
      if (entries.length >= MAX_PROJECTS) throw new LibraryError('项目列表已达 50 个；请先移除不需要的列表项，不会删除项目文件。')
      entries.unshift({ id, name: value.name, root: value.root, lastOpenedAt: new Date(Date.now()).toISOString() })
      await this.write(entries, before.revision)
      return id
    })
  }
  resolve(id: string): Promise<ProjectLibraryEntry> {
    return this.serial(async () => {
      const target = this.checkedId(id)
      const entry = (await this.read()).entries.find(value => value.id === target)
      if (!entry) throw new LibraryError('项目不在已保存列表中；请通过“打开项目”明确选择目录。')
      await verifiedProject(entry.root)
      return entry
    })
  }
  forget(id: string): Promise<void> {
    return this.change(async before => {
      this.checkedId(id)
      const entries = before.entries.filter(entry => entry.id !== id)
      if (entries.length === before.entries.length) throw new LibraryError('项目不在已保存列表中，未修改列表。')
      await this.write(entries, before.revision) // Never opens, deletes or edits the remembered project directory.
    })
  }
  private checkedId(id: unknown): string { if (typeof id !== 'string' || !ID.test(id)) throw invalid(); return id }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action).catch((error: unknown) => { throw error instanceof LibraryError ? error : invalid() })
    this.pending = result.catch(() => undefined)
    return result
  }
  private change<T>(action: (before: Snapshot) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.ensureDirectory(true)
      return withProjectWriteLock(this.directory, async () => action(await this.read()))
    })
  }
  private async ensureDirectory(create = false): Promise<boolean> {
    const root = this.directory.root
    await privateParents(root)
    if (this.initialized) await this.verifyDirectory()
    if (create) await mkdir(root, { recursive: true, mode: 0o700 })
    try { await lstat(root) } catch (error) { if (!create && !this.initialized && missing(error)) return false; throw error }
    if (rootKey(await realpath(root)) !== rootKey(root)) throw invalid()
    if (!this.initialized) {
      await this.directory.initialize()
      this.rootIdentity = await lstat(root, { bigint: true })
      this.initialized = true
    }
    await this.verifyDirectory()
    return true
  }
  private async verifyDirectory(): Promise<void> {
    await this.directory.verifyRoot()
    const current = await lstat(this.directory.root, { bigint: true })
    if (!current.isDirectory() || current.isSymbolicLink() || !this.rootIdentity || !identity(this.rootIdentity, current)) throw invalid()
  }
  private async read(): Promise<Snapshot> {
    if (!await this.ensureDirectory()) return { entries: [], revision: null }
    const path = join(this.directory.root, NAME)
    let before: BigIntStats
    try { before = await lstat(path, { bigint: true }) } catch (error) {
      if (!missing(error)) throw error
      await this.verifyDirectory(); return { entries: [], revision: null }
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES) ||
      (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n)) throw invalid()
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!sameFile(before, await file.stat({ bigint: true }))) throw invalid()
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let total = 0
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
        if (!bytesRead) break
        total += bytesRead
      }
      if (BigInt(total) !== before.size || total > MAX_BYTES || !sameFile(before, await file.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))) throw invalid()
      await this.verifyDirectory()
      const bytes = buffer.subarray(0, total)
      return { entries: checkedEntries(bytes), revision: hash(bytes) }
    } finally { await file.close() }
  }
  private async write(entries: ProjectLibraryEntry[], revision: string | null): Promise<void> {
    const root = this.directory.root, path = join(root, NAME), temporary = join(root, `.paperstudio-library-${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify({ version: 1, entries }) + '\n')
    if (bytes.length > MAX_BYTES) throw invalid()
    let created: BigIntStats | undefined
    try {
      const file = await open(temporary, 'wx', 0o600)
      try { created = await file.stat({ bigint: true }); await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await this.verifyDirectory()
      if ((await this.read()).revision !== revision) throw new LibraryError('项目列表已被其他程序更改；未覆盖，请重新读取。')
      await rename(temporary, path); created = undefined
      await this.verifyDirectory()
      if ((await this.read()).revision !== hash(bytes)) throw invalid()
    } finally {
      if (created) {
        await this.verifyDirectory()
        const current = await lstat(temporary, { bigint: true })
        if (!identity(created, current) || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) throw invalid()
        await unlink(temporary)
      }
    }
  }
}
