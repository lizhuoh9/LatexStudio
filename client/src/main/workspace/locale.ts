import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getLocale, setLocale, translate, type UiLocale } from '../../shared/i18n'
import { isUiLocale, PREFERENCES_CHANNELS as C, type PreferencesState } from '../../shared/locale-contracts'
import { SafeProject } from '../local/paths'
import { withProjectWriteLock } from '../local/write-lock'
import { isTrustedSettingsSender } from '../url-policy'

const NAME = 'ui-language.json', MAX_BYTES = 256
const invalid = (): Error => new Error(translate('无法确认语言设置已保存，请重试；论文文件未修改。'))
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const identity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino
const rootKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return identity(a, b) && b.isFile() && !b.isSymbolicLink() && b.nlink === 1n &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function decode(bytes: Buffer): UiLocale {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'locale')) throw invalid()
  const record = value as { version: unknown; locale: unknown }
  if (record.version !== 1 || !isUiLocale(record.locale)) throw invalid()
  return record.locale
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
interface Snapshot { locale: UiLocale; revision: string | null }

/** Fixed, bounded enum-only metadata; failures never repair/delete an unknown record or link. */
export class LocalePreferences {
  private readonly directory: SafeProject
  private rootIdentity: BigIntStats | undefined
  private pending: Promise<unknown> = Promise.resolve()
  constructor(dataRoot: string) { this.directory = new SafeProject(dataRoot) }

  async load(): Promise<PreferencesState> {
    try { return { locale: (await this.serial(() => this.read())).locale } }
    catch { return { locale: 'zh-CN' } }
  }
  save(locale: UiLocale): Promise<PreferencesState> {
    if (!isUiLocale(locale)) return Promise.reject(invalid())
    return this.serial(async () => {
      await this.ensureDirectory(true)
      return withProjectWriteLock(this.directory, async () => {
        const before = await this.read()
        await this.write(locale, before.revision)
        return { locale }
      })
    })
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action).catch(() => { throw invalid() })
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
    if (!await this.ensureDirectory()) return { locale: 'zh-CN', revision: null }
    const path = join(this.directory.root, NAME)
    let before: BigIntStats
    try { before = await lstat(path, { bigint: true }) } catch (error) {
      if (!missing(error)) throw error
      await this.verifyDirectory(); return { locale: 'zh-CN', revision: null }
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
      return { locale: decode(body), revision: hash(body) }
    } finally { await file.close() }
  }
  private async write(locale: UiLocale, revision: string | null): Promise<void> {
    const root = this.directory.root, path = join(root, NAME), temporary = join(root, `.paperstudio-language-${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify({ version: 1, locale }) + '\n')
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

/** Each queued operation rechecks the current window, main frame and exact application URL. */
export class LocalePreferencesController {
  private blocked = false
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private window: BrowserWindow, private url: string,
    private store: Pick<LocalePreferences, 'save'>, private changed: () => void) {}

  register(): void {
    ipcMain.handle(C.get, (event, ...args: unknown[]) => {
      this.requireTrusted(event)
      if (args.length) throw new Error(translate('语言设置请求无效。'))
      return { locale: getLocale() }
    })
    ipcMain.handle(C.set, (event, ...args: unknown[]) => {
      this.requireTrusted(event)
      if (this.blocked || args.length !== 1 || !isUiLocale(args[0])) throw new Error(translate('语言设置请求无效。'))
      const locale = args[0]
      const result = this.pending.then(async () => {
        this.requireTrusted(event)
        // Work admitted before close is drained; new requests remain blocked until cancellation.
        const state = await this.store.save(locale)
        setLocale(state.locale)
        this.changed()
        if (!this.window.isDestroyed()) this.window.webContents.send(C.changed, { locale: state.locale })
        return { locale: state.locale }
      }).catch(() => { throw invalid() })
      this.pending = result.catch(() => undefined)
      return result
    })
  }
  private requireTrusted(event: IpcMainInvokeEvent): void {
    if (this.window.isDestroyed() || !isTrustedSettingsSender(event.sender.id, this.window.webContents.id,
      event.senderFrame === this.window.webContents.mainFrame, event.senderFrame?.url ?? '', this.url)) {
      throw new Error(translate('此页面不能访问语言设置。'))
    }
  }
  async blockAndWait(): Promise<void> { this.blocked = true; await this.pending }
  resumeActions(): void { this.blocked = false }
}
