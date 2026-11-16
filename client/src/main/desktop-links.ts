import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { DESKTOP_LINKS_CHANNELS as C } from '../shared/desktop-links-contracts'
import { parseProjectLink } from '../shared/project-links'
import { translate } from '../shared/i18n'
import { isTrustedSettingsSender } from './url-policy'

function applicationLink(value: unknown): string | null {
  if (typeof value !== 'string' || !/^latexstudio:\/\/join\//i.test(value)) return null
  try { return parseProjectLink(value).appUrl } catch { return null }
}

/** One bounded, secret-free invitation, never a command, credential or repository capability. */
export class DesktopLinksController {
  private current: string | null = null
  private window: BrowserWindow | null = null
  private url = ''
  private blocked = false
  private disposed = false

  attach(window: BrowserWindow, url: string): void {
    this.window = window; this.url = url
    ipcMain.handle(C.pending, (event, ...args: unknown[]) => {
      this.requireTrusted(event)
      if (args.length) throw new Error(translate('项目链接请求无效。'))
      return this.current
    })
    ipcMain.handle(C.acknowledge, (event, ...args: unknown[]) => {
      this.requireTrusted(event)
      if (args.length !== 1 || typeof args[0] !== 'string' || applicationLink(args[0]) !== args[0]) throw new Error(translate('项目链接请求无效。'))
      // A slow renderer acknowledging an older invitation must not discard a newer one.
      if (this.current === args[0]) this.current = null
    })
    window.webContents.on('did-finish-load', () => this.publish())
    window.once('closed', () => { this.disposed = true; this.blocked = true; this.current = null })
    this.publish()
  }

  receive(value: unknown): boolean {
    const link = applicationLink(value)
    if (!link || this.disposed) return false
    this.current = link
    this.publish()
    return true
  }

  receiveArguments(argv: readonly unknown[]): boolean {
    let latest: string | null = null
    // Do not inspect files, flags, environment assignments or arbitrarily large argument lists.
    for (let i = 0; i < Math.min(argv.length, 128); i++) {
      const link = applicationLink(argv[i])
      if (link) latest = link
    }
    return latest !== null && this.receive(latest)
  }

  private liveWindow(): BrowserWindow | null {
    const window = this.window
    if (this.disposed || this.blocked || !window || window.isDestroyed() || window.webContents.isDestroyed() ||
      window.webContents.getURL() !== this.url || window.webContents.mainFrame.url !== this.url) return null
    return window
  }

  focus(): void {
    const window = this.liveWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
  }

  private publish(): void {
    const window = this.liveWindow()
    if (!window || !this.current) return
    window.webContents.send(C.link, this.current)
    this.focus()
  }

  private requireTrusted(event: IpcMainInvokeEvent): void {
    const window = this.liveWindow()
    if (!window || event.sender !== window.webContents || !isTrustedSettingsSender(event.sender.id,
      window.webContents.id, event.senderFrame === window.webContents.mainFrame, event.senderFrame?.url ?? '', this.url)) {
      throw new Error(translate('此页面不能访问项目链接。'))
    }
  }

  blockNewActions(): void { this.blocked = true }
  resumeActions(): void { if (!this.disposed) { this.blocked = false; this.publish() } }
}

/** Register before ready so macOS open-url events and cold argv are not lost during initialization. */
export function registerDesktopLinkEvents(links: DesktopLinksController, argv: readonly string[] = process.argv): void {
  links.receiveArguments(argv)
  app.on('second-instance', (_event, arguments_) => {
    if (!links.receiveArguments(arguments_)) links.focus()
  })
  app.on('open-url', (event, url) => { event.preventDefault(); links.receive(url) })
}

/** Only an installed/packaged, non-portable build may claim the OS scheme. Never point it at dev Electron. */
export function registerProjectProtocol(): boolean {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE) return false
  // OS association failure must not prevent account-free local editing; never report it as registered.
  try { return app.setAsDefaultProtocolClient('latexstudio') } catch { return false }
}
