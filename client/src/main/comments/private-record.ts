import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { SafeProject } from '../local/paths'
import { withProjectWriteLock } from '../local/write-lock'

export interface PrivateRecordOptions<T> {
  /** File name inside the app's own data directory. */
  name: string
  maxBytes: number
  /** Throws for anything that is not exactly a valid record. */
  decode(value: unknown): T
}
interface Snapshot<T> { value: T | null; revision: string | null }

const invalid = (): Error => new Error('private record unavailable')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const identity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino
const rootKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && b.isFile() && !b.isSymbolicLink() && b.nlink === 1n &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
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

/** One small JSON record in the app's data directory, written the same way as the language and cloud-link records:
 * bounded no-link reads, private atomic replace with readback, serialized under the directory write lock.
 * An unreadable or unexpected record is never repaired, replaced or deleted; reads and updates then reject.
 */
export class PrivateRecord<T> {
  private readonly directory: SafeProject
  private rootIdentity: BigIntStats | undefined
  private pending: Promise<unknown> = Promise.resolve()
  constructor(dataRoot: string, private readonly options: PrivateRecordOptions<T>) { this.directory = new SafeProject(dataRoot) }

  read(): Promise<T | null> { return this.serial(async () => (await this.load()).value) }

  /** `change` returns the next value, or the current one unchanged to skip writing. */
  update(change: (current: T | null) => T): Promise<T> {
    return this.serial(async () => {
      await this.ensureDirectory(true)
      return withProjectWriteLock(this.directory, async () => {
        const before = await this.load()
        const next = change(before.value)
        if (next !== before.value) await this.write(next, before.revision)
        return next
      })
    })
  }

  private serial<R>(action: () => Promise<R>): Promise<R> {
    const result = this.pending.then(action)
    this.pending = result.catch(() => undefined)
    return result
  }
  private async ensureDirectory(create = false): Promise<boolean> {
    const root = this.directory.root
    await privateParents(root)
    if (this.rootIdentity) await this.verifyDirectory()
    if (create) await mkdir(root, { recursive: true, mode: 0o700 })
    try { await lstat(root) } catch (error) {
      if (!create && !this.rootIdentity && missing(error)) return false
      throw error
    }
    if (rootKey(await realpath(root)) !== rootKey(root)) throw invalid()
    if (!this.rootIdentity) {
      await this.directory.initialize()
      this.rootIdentity = await lstat(root, { bigint: true })
    }
    await this.verifyDirectory()
    return true
  }
  private async verifyDirectory(): Promise<void> {
    await privateParents(this.directory.root)
    await this.directory.verifyRoot()
    const info = await lstat(this.directory.root, { bigint: true })
    if (!this.rootIdentity || !info.isDirectory() || info.isSymbolicLink() || !identity(info, this.rootIdentity)) throw invalid()
  }
  private async load(): Promise<Snapshot<T>> {
    if (!await this.ensureDirectory()) return { value: null, revision: null }
    const path = join(this.directory.root, this.options.name), limit = this.options.maxBytes
    let before: BigIntStats
    try { before = await lstat(path, { bigint: true }) } catch (error) {
      if (!missing(error)) throw error
      await this.verifyDirectory(); return { value: null, revision: null }
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit) ||
      (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n)) throw invalid()
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!sameFile(before, await file.stat({ bigint: true }))) throw invalid()
      const bytes = Buffer.alloc(limit + 1)
      let total = 0
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
        if (!bytesRead) break
        total += bytesRead
      }
      if (total > limit || BigInt(total) !== before.size || !sameFile(before, await file.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))) throw invalid()
      await this.verifyDirectory()
      const body = bytes.subarray(0, total)
      const value = this.options.decode(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)))
      return { value, revision: hash(body) }
    } finally { await file.close() }
  }
  private async write(value: T, revision: string | null): Promise<void> {
    const root = this.directory.root, path = join(root, this.options.name)
    const temporary = join(root, `.paperstudio-record-${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify(value) + '\n')
    if (bytes.length > this.options.maxBytes) throw invalid()
    this.options.decode(JSON.parse(bytes.toString('utf8')))
    let created: BigIntStats | undefined
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        created = await file.stat({ bigint: true })
        await file.writeFile(bytes); await file.sync()
        created = await file.stat({ bigint: true })
      } finally { await file.close() }
      await this.verifyDirectory()
      if ((await this.load()).revision !== revision || !created || !sameFile(created, await lstat(temporary, { bigint: true }))) throw invalid()
      await rename(temporary, path); created = undefined
      await this.verifyDirectory()
      if ((await this.load()).revision !== hash(bytes)) throw invalid()
    } finally {
      if (created) {
        await this.verifyDirectory()
        const info = await lstat(temporary, { bigint: true })
        if (!identity(created, info) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw invalid()
        await unlink(temporary)
      }
    }
  }
}
