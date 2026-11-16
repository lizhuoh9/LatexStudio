import { Menu, type MenuItemConstructorOptions } from 'electron'
import { translate } from '../../shared/i18n'

/** Native roles retain editing shortcuts, accessibility and the existing draft/IPC close handshake. */
export function installWorkspaceMenu(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') { Menu.setApplicationMenu(null); return }
  const template: MenuItemConstructorOptions[] = [
    { label: 'LatexStudio', submenu: [{ role: 'about', label: translate('关于 LatexStudio') }, { type: 'separator' },
      { role: 'services', label: translate('服务') }, { type: 'separator' }, { role: 'hide', label: translate('隐藏 LatexStudio') },
      { role: 'hideOthers', label: translate('隐藏其他应用') }, { role: 'unhide', label: translate('显示全部') },
      { type: 'separator' }, { role: 'quit', label: translate('退出 LatexStudio') }] },
    { label: translate('文件'), submenu: [{ role: 'close', label: translate('关闭窗口'), accelerator: 'CmdOrCtrl+W' }] },
    { role: 'editMenu', label: translate('编辑'), submenu: [
      { role: 'undo', label: translate('撤销') }, { role: 'redo', label: translate('重做') }, { type: 'separator' },
      { role: 'cut', label: translate('剪切') }, { role: 'copy', label: translate('复制') },
      { role: 'paste', label: translate('粘贴') }, { role: 'pasteAndMatchStyle', label: translate('粘贴并匹配样式') },
      { role: 'delete', label: translate('删除') }, { role: 'selectAll', label: translate('全选') }, { type: 'separator' },
      { role: 'startSpeaking', label: translate('开始朗读') }, { role: 'stopSpeaking', label: translate('停止朗读') }
    ] },
    { role: 'windowMenu', label: translate('窗口'), submenu: [
      { role: 'minimize', label: translate('最小化') }, { role: 'zoom', label: translate('缩放') },
      { type: 'separator' }, { role: 'front', label: translate('全部置于顶层') }
    ] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
