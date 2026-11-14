import { Menu, type MenuItemConstructorOptions } from 'electron'

/** Native roles keep editing shortcuts in both CodeMirror and ordinary macOS form inputs.
 * Close/quit remain native Electron actions and go through the existing draft/IPC close handshake.
 */
export function installWorkspaceMenu(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const template: MenuItemConstructorOptions[] = [
    { label: 'LatexStudio', submenu: [{ role: 'about', label: '关于 LatexStudio' }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' }, { role: 'hide', label: '隐藏 LatexStudio' },
      { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: '退出 LatexStudio' }] },
    { label: '文件', submenu: [{ role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' }] },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
