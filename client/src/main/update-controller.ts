import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import { UPDATE_CHANNELS as C, type UpdateState } from '../shared/update-contracts'
import { isTrustedSettingsSender } from './url-policy'

export const SOFTWARE_RELEASES = 'https://github.com/lizhuoh9/LatexStudio/releases/latest'
type UpdateEvent = 'error' | 'update-available' | 'update-not-available'
const version = (value: unknown): value is string => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)

/** Public software releases are independent from paper/GitHub-account permissions.
 * Current artifacts are unsigned: never download or run an installer automatically.
 * A future signed-install path requires its own publisher/certificate acceptance, not an env bypass.
 */
export class UpdateController {
  private state: UpdateState
  private pending: Promise<UpdateState> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private handlers: { event: UpdateEvent; listener: (value: unknown) => void }[] = []

  constructor(private window: BrowserWindow, private url: string, private updater: AppUpdater = autoUpdater,
    private packaged = app.isPackaged, currentVersion = app.getVersion()) {
    this.state = { phase: packaged ? 'idle' : 'development', currentVersion, latestVersion: null,
      manualInstallOnly: true, message: packaged ? '自动检查正式发布的新版本。' : '本地开发版不会自动联网检查更新。' }
    updater.autoDownload = false; updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false; updater.allowDowngrade = false; updater.disableWebInstaller = true
    updater.forceDevUpdateConfig = false; updater.logger = null
    updater.setFeedURL({ provider: 'github', owner: 'lizhuoh9', repo: 'LatexStudio', private: false })
    this.listen('update-available', info => {
      const offered = info && typeof info === 'object' && 'version' in info ? info.version : null
      if (version(offered)) this.publish({ phase: 'available', latestVersion: offered,
        message: '发现新版本。当前为未签名开发版，请保存论文后手动下载安装。' })
      else this.publish({ phase: 'error', message: '版本信息无效，请到官方发布页查看。' })
    })
    this.listen('update-not-available', () => this.publish({ phase: 'current', latestVersion: null, message: '当前已是最新正式发布版本。' }))
    this.listen('error', () => this.publish({ phase: 'error', message: '暂时无法检查更新，或尚无正式发布版本。可稍后重试。' }))
    window.once('closed', () => this.dispose())
  }

  private listen(event: UpdateEvent, listener: (value: unknown) => void): void {
    const guarded = (value: unknown): void => { if (!this.disposed) listener(value) }
    this.updater.on(event, guarded)
    this.handlers.push({ event, listener: guarded })
  }
  private publish(update: Partial<UpdateState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...update, manualInstallOnly: true }
    if (!this.window.isDestroyed()) this.window.webContents.send(C.state, this.status())
  }
  status(): UpdateState { return { ...this.state } }
  register(): void {
    this.handle(C.status, async () => this.status())
    this.handle(C.check, () => this.check())
    this.handle(C.releases, async () => { await shell.openExternal(SOFTWARE_RELEASES) })
  }
  private handle(channel: string, operation: () => Promise<unknown>): void {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (this.disposed || args.length || this.window.isDestroyed() || !isTrustedSettingsSender(event.sender.id,
        this.window.webContents.id, event.senderFrame === this.window.webContents.mainFrame, event.senderFrame?.url ?? '', this.url)) {
        throw new Error('此页面不能管理软件更新。')
      }
      try { return await operation() } catch { throw new Error('软件更新请求未完成，请重试。') }
    })
  }
  initialize(): void {
    if (!this.packaged || this.disposed || this.timer !== null) return
    // Quiet first check; never prompt, download, quit or modify a project on startup.
    this.timer = setTimeout(() => { this.timer = null; void this.check() }, 20_000)
    this.timer.unref?.()
  }
  check(): Promise<UpdateState> {
    if (this.disposed || !this.packaged) return Promise.resolve(this.status())
    if (this.pending) return this.pending
    this.publish({ phase: 'checking', message: '正在检查 GitHub 正式发布版本…' })
    this.pending = this.updater.checkForUpdates().then(() => this.status()).catch(() => {
      this.publish({ phase: 'error', message: '暂时无法检查更新，或尚无正式发布版本。可到官方发布页查看。' })
      return this.status()
    }).finally(() => { this.pending = null })
    return this.pending
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    const remove = (): void => {
      for (const { event, listener } of this.handlers.splice(0)) this.updater.removeListener(event, listener)
    }
    if (this.pending) void this.pending.then(remove, remove)
    else remove()
    this.timer = null
  }
}
