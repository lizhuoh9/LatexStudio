export const SETTINGS_PARTITION = 'settings-v1'

export const SETTINGS_WEB_PREFERENCES = {
  partition: SETTINGS_PARTITION,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false
} as const
