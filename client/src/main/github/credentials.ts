import { safeStorage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type VaultFile = { version: 1; entries: Record<string, string> }

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function secureStorage(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    const backend = safeStorage.getSelectedStorageBackend?.()
    if (backend === 'basic_text') return false
    return process.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend ?? '')
  } catch { return false }
}

/** Tokens never leave the main process. basic_text is NOT secure storage. */
export class CredentialVault {
  private readonly memory = new Map<string, string>()
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  get storageDescription(): string {
    return secureStorage() ? '凭据由操作系统安全加密保存。' :
      '系统安全加密不可用（包括 Linux basic_text）；凭据仅保留在内存，退出后需重新输入。'
  }

  load(key: string): Promise<string | null> {
    return this.serial(async () => {
      const cached = this.memory.get(key)
      if (cached !== undefined) return cached
      if (!secureStorage()) return null
      const value = (await this.read()).entries[this.hash(key)]
      if (!value) return null
      try {
        const token = safeStorage.decryptString(Buffer.from(value, 'base64'))
        this.memory.set(key, token)
        return token
      } catch {
        throw new Error('无法安全解密 GitHub 凭据，请重新输入。')
      }
    })
  }

  save(key: string, token: string): Promise<void> {
    return this.serial(async () => {
      if (!token || /[\r\n\0]/.test(token)) throw new Error('GitHub 凭据格式无效。')
      if (!secureStorage()) { this.memory.set(key, token); return }
      const data = await this.read()
      try {
        data.entries[this.hash(key)] = safeStorage.encryptString(token).toString('base64')
      } catch {
        throw new Error('无法安全加密 GitHub 凭据，未保存。')
      }
      await this.persist(data)
      this.memory.set(key, token)
    })
  }

  remove(key: string): Promise<void> {
    return this.serial(async () => {
      this.memory.delete(key)
      const data = await this.read()
      delete data.entries[this.hash(key)]
      if (Object.keys(data.entries).length) await this.persist(data)
      else await unlink(this.filePath).catch((error: unknown) => { if (!missing(error)) throw new Error('无法移除加密凭据文件。') })
    })
  }

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex')
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action)
    this.pending = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<VaultFile> {
    try {
      const stat = await lstat(this.filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error()
      const data: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!data || typeof data !== 'object') throw new Error()
      const value = data as VaultFile
      if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) ||
        Object.keys(value).some((key) => !['version', 'entries'].includes(key))) throw new Error()
      for (const [key, token] of Object.entries(value.entries)) {
        if (!/^[a-f0-9]{64}$/.test(key) || typeof token !== 'string' ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(token)) throw new Error()
      }
      return { version: 1, entries: { ...value.entries } }
    } catch (error) {
      if (missing(error)) return { version: 1, entries: {} }
      throw new Error('无法读取加密凭据文件；未使用不安全的替代存储。')
    }
  }

  private async persist(data: VaultFile): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
    } catch {
      throw new Error('无法保存加密凭据文件。')
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw new Error('无法清理加密凭据临时文件。') })
    }
  }
}
