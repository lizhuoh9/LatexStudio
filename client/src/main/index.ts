import { app, BrowserWindow, dialog, session } from 'electron'
import { WorkspaceController } from './workspace/controller'
import { restrictSession } from './session'
import { SETTINGS_PARTITION } from './session-policy'
import { createWorkspaceWindow } from './workspace/window'
import { installWorkspaceMenu } from './workspace/menu'
import { TexSetupController } from './tex/controller'
import { CollaborationController } from './collaboration/controller'
import { forbiddenSwitch } from './startup-guard'
import { UpdateController } from './update-controller'

app.enableSandbox()
app.setAppUserModelId('org.paperstudio.desktop')
app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
  event.preventDefault()
  callback(false)
})

function guardQuit(window: BrowserWindow, controller: { requestClose(): Promise<boolean> }): void {
  let quitting = false
  let pending = false
  const request = async (): Promise<void> => {
    if (pending) return
    pending = true
    try {
      if (await controller.requestClose()) { quitting = true; app.quit() }
    } catch {
      await dialog.showMessageBox(window, { type: 'error', message: '无法安全关闭页面，请先保存内容后重试。' })
    } finally { pending = false }
  }
  window.on('close', (event) => {
    if (!quitting) { event.preventDefault(); void request() }
  })
  app.on('before-quit', (event) => {
    if (!quitting) { event.preventDefault(); void request() }
  })
}

async function start(): Promise<void> {
  installWorkspaceMenu()
  app.setAboutPanelOptions({ applicationName: 'LatexStudio', applicationVersion: app.getVersion() })
  restrictSession(session.fromPartition(SETTINGS_PARTITION))
  const { window, url } = createWorkspaceWindow()
  const dataRoot = app.getPath('userData')
  const setup = new TexSetupController(window, url, dataRoot)
  const collaboration = new CollaborationController(window, url, undefined, dataRoot)
  const controller = new WorkspaceController(window, url, dataRoot, async () => {
    await Promise.all([setup.cancelAndWait(), collaboration.cancelAndWait()])
  }, collaboration.service)
  setup.register()
  collaboration.register()
  const updates = new UpdateController(window, url)
  updates.register()
  guardQuit(window, { requestClose: async () => {
    setup.blockNewActions()
    collaboration.blockNewActions()
    let accepted = false
    try { accepted = await controller.requestClose(); return accepted }
    finally { if (!accepted) { setup.resumeActions(); collaboration.resumeActions() } }
  } })
  await controller.initialize()
  // Bundled components initialize in the background; editing never waits for a download decision.
  void setup.initialize()
  updates.initialize()
}

if (app.isPackaged && forbiddenSwitch(name => app.commandLine.hasSwitch(name))) app.exit(1) // before any window exists
else if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
  })
  void app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('LatexStudio 无法启动', '无法载入本地工作台。请重新安装或检查应用目录权限。')
    app.exit(1)
  })
}
app.on('window-all-closed', () => app.quit())
