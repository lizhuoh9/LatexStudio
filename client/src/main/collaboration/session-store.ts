import { safeStorage } from 'electron'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validStoredSession, type AccountSessionStore, type StoredSession } from './session-policy'
export { validStoredSession, type AccountSessionStore, type StoredSession } from './session-policy'

const MAX_FILE = 64 * 1024
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export interface SessionEncryption {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
interface Envelope { version: 1; id: string; ciphertext: string }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const fail = (): Error => new Error('无法安全读取或保存登录会话，请重新登录。')
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail()
  return value as Record<string, unknown>
}
function envelope(value: unknown): Envelope {
  const item = object(value)
  if (Object.keys(item).length !== 3 || item.version !== 1 || typeof item.id !== 'string' || !UUID.test(item.id) ||
    typeof item.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.ciphertext) || item.ciphertext.length > MAX_FILE - 256) throw fail()
  const bytes = Buffer.from(item.ciphertext, 'base64')
  if (!bytes.length || bytes.toString('base64') !== item.ciphertext) throw fail()
  return { version: 1, id: item.id, ciphertext: item.ciphertext }
}
async function parents(path: string): Promise<void> {
  for (let current = resolve(path); current !== dirname(current); current = dirname(current)) {
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw fail() }
    catch (error) { if (!missing(error)) throw error }
  }
}

/** Dedicated App-session file. Never imports or writes the legacy PAT CredentialVault. */
export class EncryptedSessionStore implements AccountSessionStore {
  private pending: Promise<unknown> = Promise.resolve()
  private readonly directory: string
  private readonly file: string
  constructor(dataRoot: string, private encryption: SessionEncryption = safeStorage, private platform: NodeJS.Platform = process.platform) {
    this.directory = resolve(dataRoot, 'collaboration'); this.file = join(this.directory, 'account-session.json')
  }
  private secure(): boolean {
    try {
      if (!this.encryption.isEncryptionAvailable()) return false
      const backend = this.encryption.getSelectedStorageBackend?.()
      return backend !== 'basic_text' && (this.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend ?? ''))
    } catch { return false }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(action); this.pending = task.catch(() => undefined); return task
  }
  private async directoryCheck(): Promise<void> {
    await parents(this.directory)
    const canonical = await realpath(this.directory)
    if ((this.platform === 'win32' ? canonical.toLowerCase() : canonical) !== (this.platform === 'win32' ? this.directory.toLowerCase() : this.directory)) throw fail()
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || this.platform !== 'win32' && ((info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid())) throw fail()
  }
  private async fileInfo(): Promise<BigIntStats | null> {
    try {
      await this.directoryCheck(); const info = await lstat(this.file, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(MAX_FILE) ||
        this.platform !== 'win32' && ((info.mode & 0o077n) !== 0n || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid()))) throw fail()
      return info
    } catch (error) { if (missing(error)) return null; throw fail() }
  }
  private async read(): Promise<{ value: Envelope; info: BigIntStats } | null> {
    const before = await this.fileInfo()
    if (!before) return null
    const file = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (!same(before, await file.stat({ bigint: true }))) throw fail()
      const bytes = Buffer.alloc(MAX_FILE + 1)
      let total = 0
      while (total < bytes.length) {
        const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
        if (!bytesRead) break
        total += bytesRead
      }
      const current = await this.fileInfo()
      if (total > MAX_FILE || BigInt(total) !== before.size || !same(before, await file.stat({ bigint: true })) || !current || !same(before, current)) throw fail()
      return { value: envelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)))), info: before }
    } catch { throw fail() } finally { await file.close() }
  }
  load(clientId: string, now: number, signal?: AbortSignal): Promise<StoredSession | null> {
    return this.serial(async () => {
      signal?.throwIfAborted()
      if (!this.secure()) return null
      const saved = await this.read(); if (!saved) return null
      let credential: StoredSession
      try {
        const plaintext = this.encryption.decryptString(Buffer.from(saved.value.ciphertext, 'base64'))
        if (Buffer.byteLength(plaintext, 'utf8') > MAX_FILE) throw fail()
        credential = validStoredSession(JSON.parse(plaintext), now)
      } catch { throw fail() }
      signal?.throwIfAborted()
      if (credential.id !== saved.value.id) throw fail()
      if (credential.expiresAt <= now || credential.clientId !== clientId) { await this.remove(credential.id); return null }
      return credential
    })
  }
  save(value: StoredSession, signal?: AbortSignal): Promise<boolean> {
    let record: StoredSession
    try { record = validStoredSession(value, value.issuedAt) } catch { return Promise.reject(fail()) }
    return this.serial(async () => {
      signal?.throwIfAborted()
      if (!this.secure()) return false
      await parents(this.directory); await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.directoryCheck()
      await this.fileInfo()
      let ciphertext: string
      try { ciphertext = this.encryption.encryptString(JSON.stringify(record)).toString('base64') } catch { throw fail() }
      const bytes = Buffer.from(JSON.stringify(envelope({ version: 1, id: record.id, ciphertext })))
      if (bytes.length > MAX_FILE) throw fail()
      return this.replace(bytes, record, signal)
    })
  }
  private async replace(bytes: Buffer, value: StoredSession, signal?: AbortSignal): Promise<boolean> {
    const temporary = join(this.directory, `.account-session-${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    let renamed = false
    try {
      await file.writeFile(bytes); await file.sync(); await file.close()
      signal?.throwIfAborted(); await this.directoryCheck(); await this.fileInfo()
      await rename(temporary, this.file); renamed = true
      if (signal?.aborted) { await this.remove(value.id); signal.throwIfAborted() }
      return true
    } finally {
      await file.close().catch(() => undefined)
      if (!renamed) await unlink(temporary).catch(error => { if (!missing(error)) throw fail() })
    }
  }
  clear(expected?: StoredSession): Promise<void> {
    const id = expected?.id
    if (id !== undefined && !UUID.test(id)) return Promise.reject(fail())
    return this.serial(() => this.remove(id))
  }
  private async remove(expectedId?: string): Promise<void> {
    const info = await this.fileInfo(); if (!info) return
    if (expectedId && (await this.read())?.value.id !== expectedId) return
    const current = await this.fileInfo()
    if (!current || !same(info, current)) throw fail()
    try { await unlink(this.file) } catch (error) { if (!missing(error)) throw fail() }
  }
}
