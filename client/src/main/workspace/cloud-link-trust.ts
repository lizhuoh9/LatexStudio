import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CloudBinding } from '../github/cloud-binding'
import { SafeProject } from '../local/paths'
import { withProjectWriteLock } from '../local/write-lock'

const NAME = 'cloud-links.json', MAX_BYTES = 1024 * 1024, MAX_LINKS = 200, MAX_ROOT_BYTES = 16 * 1024
const FIELDS = ['projectId', 'owner', 'name', 'branch', 'accountId'] as const
const KEYS = ['root', ...FIELDS]
interface Link extends CloudBinding { root: string }
interface Snapshot { links: Link[]; revision: string | null }
const invalid = (): Error => new Error('cloud link record unavailable')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const identity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino
const rootKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 &&
  !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && b.isFile() && !b.isSymbolicLink() && b.nlink === 1n &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function normalizedRoot(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_ROOT_BYTES ||
    /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)) throw invalid()
  try { return new SafeProject(value).root } catch { throw invalid() }
}
function checkedLink(value: unknown): Link {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== KEYS.length ||
    KEYS.some(key => !Object.hasOwn(value, key))) throw invalid()
  const data = value as Record<string, unknown>
  if (!positive(data.projectId) || !positive(data.accountId) || !text(data.owner) || !text(data.name) || !text(data.branch) ||
    data.root !== normalizedRoot(data.root)) throw invalid()
  return { root: data.root as string, projectId: data.projectId, owner: data.owner, name: data.name,
    branch: data.branch, accountId: data.accountId }
}
function decode(bytes: Buffer): Link[] {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'links')) throw invalid()
  const data = value as { version: unknown; links: unknown }
  if (data.version !== 1 || !Array.isArray(data.links) || data.links.length > MAX_LINKS) throw invalid()
  return data.links.map(checkedLink)
}
const matches = (link: Link, root: string, binding: CloudBinding): boolean =>
  rootKey(link.root) === rootKey(root) && FIELDS.every(key => link[key] === binding[key])
async function privateParents(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    try {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
    } catch (error) { if (!missing(error)) throw error }
    if (current === dirname(current)) return
  }
}

/** Device-side record of which folder-to-repository links the user established or confirmed in this app.
 * The link file inside a paper folder travels with that folder and can be written by anyone who prepares it,
 * so it only routes; this record, kept in the app's own data directory, decides whether a sync may start
 * without asking. It holds no credential and grants no repository access: every sync still obtains fresh
 * authorization. An unreadable record is never repaired or replaced and simply confirms nothing.
 * A folder is matched by its resolved path (letter case ignored on Windows only); another spelling of the same
 * folder, such as a junction, a short name or a mapped drive, is asked once more rather than assumed equal.
 */
export class CloudLinkTrust {
  private readonly directory: SafeProject
  private rootIdentity: BigIntStats | undefined
  private pending: Promise<unknown> = Promise.resolve()
  /** Links confirmed or found confirmed during this run. A record that cannot be saved, or that is briefly
   * unreadable later (antivirus or a sync client holding the file), then does not ask again before restart.
   */
  private readonly confirmedThisRun: Link[] = []
  constructor(dataRoot: string) { this.directory = new SafeProject(dataRoot) }

  /** Never rejects: anything that cannot be verified is unconfirmed. */
  async has(root: string, binding: CloudBinding): Promise<boolean> {
    let folder: string
    try { folder = normalizedRoot(root) } catch { return false }
    if (this.confirmedThisRun.some(link => matches(link, folder, binding))) return true
    try {
      const found = (await this.serial(() => this.read())).links.find(link => matches(link, folder, binding))
      if (found) this.keep(found)
      return found !== undefined
    } catch { return false }
  }

  /** Resolves false when the confirmation holds for this run only because it could not be saved. */
  async remember(root: string, binding: CloudBinding): Promise<boolean> {
    let link: Link
    try { link = checkedLink({ root: normalizedRoot(root), ...Object.fromEntries(FIELDS.map(key => [key, binding[key]])) }) }
    catch { return false }
    this.keep(link)
    try {
      await this.serial(async () => {
        await this.ensureDirectory(true)
        await withProjectWriteLock(this.directory, async () => {
          const before = await this.read()
          const kept = before.links.filter(value => rootKey(value.root) !== rootKey(link.root))
          await this.write([link, ...kept].slice(0, MAX_LINKS), before.revision)
        })
      })
      return true
    } catch { return false }
  }

  private keep(link: Link): void {
    const others = this.confirmedThisRun.filter(value => rootKey(value.root) !== rootKey(link.root))
    this.confirmedThisRun.splice(0, this.confirmedThisRun.length, link, ...others.slice(0, MAX_LINKS - 1))
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
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
  private async read(): Promise<Snapshot> {
    if (!await this.ensureDirectory()) return { links: [], revision: null }
    const path = join(this.directory.root, NAME)
    let before: BigIntStats
    try { before = await lstat(path, { bigint: true }) } catch (error) {
      if (!missing(error)) throw error
      await this.verifyDirectory(); return { links: [], revision: null }
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_BYTES) ||
      (process.platform !== 'win32' && (before.mode & 0o077n) !== 0n)) throw invalid()
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      if (!sameFile(before, await file.stat({ bigint: true }))) throw invalid()
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let total = 0
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
        if (!bytesRead) break
        total += bytesRead
      }
      if (total > MAX_BYTES || BigInt(total) !== before.size || !sameFile(before, await file.stat({ bigint: true })) ||
        !sameFile(before, await lstat(path, { bigint: true }))) throw invalid()
      await this.verifyDirectory()
      const body = bytes.subarray(0, total)
      return { links: decode(body), revision: hash(body) }
    } finally { await file.close() }
  }
  private async write(links: Link[], revision: string | null): Promise<void> {
    const root = this.directory.root, path = join(root, NAME), temporary = join(root, `.paperstudio-links-${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify({ version: 1, links }) + '\n')
    if (bytes.length > MAX_BYTES) throw invalid()
    let created: BigIntStats | undefined
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        created = await file.stat({ bigint: true })
        await file.writeFile(bytes); await file.sync()
        created = await file.stat({ bigint: true })
      } finally { await file.close() }
      await this.verifyDirectory()
      if ((await this.read()).revision !== revision || !created || !sameFile(created, await lstat(temporary, { bigint: true }))) throw invalid()
      await rename(temporary, path); created = undefined
      await this.verifyDirectory()
      if ((await this.read()).revision !== hash(bytes)) throw invalid()
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
