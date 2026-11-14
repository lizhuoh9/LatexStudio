import type { Session } from 'electron'

export function restrictSession(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  target.setPermissionCheckHandler(() => false)
  target.setDevicePermissionHandler(() => false)
  target.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: '保存 LatexStudio 下载文件' })
  })
}
