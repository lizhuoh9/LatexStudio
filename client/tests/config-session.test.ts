import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { restrictSession } from '../src/main/session'
import { SETTINGS_PARTITION, SETTINGS_WEB_PREFERENCES } from '../src/main/session-policy'

describe('isolated local workspace session', () => {
  it('keeps the workspace partition ephemeral and every renderer security preference enabled', () => {
    expect(SETTINGS_PARTITION).toBe('settings-v1')
    expect(SETTINGS_PARTITION.startsWith('persist:')).toBe(false)
    expect(SETTINGS_WEB_PREFERENCES).not.toHaveProperty('preload')
    expect(SETTINGS_WEB_PREFERENCES).toEqual({ partition: SETTINGS_PARTITION,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false,
      navigateOnDragDrop: false })
  })
  it('denies all permissions by default', () => {
    const request = vi.fn(); const check = vi.fn(); const device = vi.fn()
    const target = { setPermissionRequestHandler: request, setPermissionCheckHandler: check,
      setDevicePermissionHandler: device, on: vi.fn() } as unknown as Session
    restrictSession(target)
    const reply = vi.fn()
    request.mock.calls[0]?.[0](null, 'camera', reply)
    expect(reply).toHaveBeenCalledWith(false)
    expect(check.mock.calls[0]?.[0]()).toBe(false)
    expect(device.mock.calls[0]?.[0]()).toBe(false)
  })
})
