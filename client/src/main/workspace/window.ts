import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SETTINGS_WEB_PREFERENCES } from '../session-policy'
import { translate } from '../../shared/i18n'

export function workspaceUrl(): string {
  const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (!dev) return pathToFileURL(join(__dirname, '../renderer/index.html')).href
  const url = new URL(dev)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('开发工作台必须来自本机 HTTP 服务。')
  }
  return url.href
}

function workspaceIcon(): NativeImage | undefined {
  const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  const icon = nativeImage.createFromPath(join(resources, 'icons', 'paperstudio-256.png'))
  return icon.isEmpty() ? undefined : icon
}

export function createWorkspaceWindow(): { window: BrowserWindow; url: string } {
  const url = workspaceUrl()
  const window = new BrowserWindow({
    width: 1500, height: 960, minWidth: 1080, minHeight: 700,
    title: translate('LatexStudio · 本地论文工作台'), autoHideMenuBar: true, icon: workspaceIcon(),
    webPreferences: { ...SETTINGS_WEB_PREFERENCES, preload: join(__dirname, '../preload/index.js') }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.on('will-redirect', event => event.preventDefault())
  window.webContents.on('will-frame-navigate', event => event.preventDefault())
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return { window, url }
}
