import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UPDATE_CHANNELS as C } from '../src/shared/update-contracts'
const state = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(), open: vi.fn(), send: vi.fn(), loads: 0, lazy: null as unknown }))
vi.mock('electron', () => ({ app: { isPackaged: false, getVersion: () => '0.3.0' }, shell: { openExternal: state.open }, ipcMain: { handle: (key: string, handler: typeof state.handlers extends Map<string, infer H> ? H : never) => state.handlers.set(key, handler) } }))
vi.mock('electron-updater', () => ({ get autoUpdater() { state.loads++; return state.lazy } }))
import { UpdateController, SOFTWARE_RELEASES } from '../src/main/update-controller'
const url = 'file:///fixture/index.html', frame = { url }, event = { sender: { id: 8 }, senderFrame: frame }
let updater: ReturnType<typeof adapter>, controller: UpdateController
function adapter() { return Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(async () => null), setFeedURL: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(), autoDownload: true, autoInstallOnAppQuit: true, allowDowngrade: true, allowPrerelease: true, disableWebInstaller: false, forceDevUpdateConfig: true, logger: {} as unknown }) }
function make(packaged = true, injected = true) {
  updater = adapter(); state.lazy = updater
  const window = { isDestroyed: () => false, once: vi.fn(), webContents: { id: 8, mainFrame: frame, send: state.send } } as unknown as BrowserWindow
  controller = new UpdateController(window, url, injected ? updater as unknown as AppUpdater : undefined, packaged, '0.3.0'); controller.register(); return controller
}
const invoke = (channel: string, source: unknown = event, ...args: unknown[]) => state.handlers.get(channel)!(source, ...args)
beforeEach(() => { vi.clearAllMocks(); state.handlers.clear(); state.loads = 0; state.open.mockResolvedValue(undefined) })
afterEach(() => { controller?.dispose(); vi.useRealTimers() })
it('never checks, downloads, installs or opens a browser in development', async () => {
  make(false).initialize(); await controller.check(); expect(controller.status().phase).toBe('development')
  expect(updater.checkForUpdates).not.toHaveBeenCalled(); expect(state.open).not.toHaveBeenCalled()
})
it('pins the public software repo and disables unverified automatic installation', () => {
  make(); expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'lizhuoh9', repo: 'LatexStudio', private: false })
  expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, disableWebInstaller: true, forceDevUpdateConfig: false, logger: null })
})
it('quietly checks only after the packaged startup delay', async () => {
  vi.useFakeTimers(); make().initialize(); await vi.advanceTimersByTimeAsync(19999); expect(updater.checkForUpdates).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); expect(updater.checkForUpdates).toHaveBeenCalledOnce(); expect(state.open).not.toHaveBeenCalled()
})
it('coalesces checks and whitelists a numeric release version without release text or URLs', async () => {
  make(); let release!: (value: null) => void; updater.checkForUpdates.mockReturnValue(new Promise(done => { release = done }))
  const first = controller.check(), second = controller.check(); expect(first).toBe(second)
  updater.emit('update-available', { version: '0.3.1', releaseNotes: 'CANARY', url: 'https://evil.invalid/install' }); release(null); await first
  expect(controller.status()).toMatchObject({ phase: 'available', latestVersion: '0.3.1', manualInstallOnly: true })
  expect(JSON.stringify(controller.status())).not.toMatch(/CANARY|evil/)
  expect(updater.downloadUpdate).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled()
})
it('rejects malformed release labels without opening supplied destinations', () => {
  make(); updater.emit('update-available', { version: '<img src=x>' }); expect(controller.status().phase).toBe('error'); expect(state.open).not.toHaveBeenCalled()
})
it('redacts update provider failures', async () => {
  make(); updater.checkForUpdates.mockRejectedValue(new Error('CANARY_SECRET')); await controller.check()
  expect(controller.status().phase).toBe('error'); expect(JSON.stringify(controller.status())).not.toContain('CANARY')
})
it.each(['window', 'subframe', 'url', 'args'])('rejects forged %s IPC without update work', async kind => {
  make(); const source = kind === 'window' ? { ...event, sender: { id: 9 } } : kind === 'subframe' ? { ...event, senderFrame: { url } } : kind === 'url' ? { ...event, senderFrame: { url: 'https://evil.invalid' } } : event
  await expect(invoke(C.check, source, ...(kind === 'args' ? ['https://evil.invalid'] : []))).rejects.toThrow('不能管理')
  expect(updater.checkForUpdates).not.toHaveBeenCalled()
})
it('opens only the fixed official release page on an explicit action', async () => {
  make(); await invoke(C.releases); expect(state.open).toHaveBeenCalledExactlyOnceWith(SOFTWARE_RELEASES)
})
it('keeps a harmless error listener until a disposed pending request settles', async () => {
  make(); let release!: (value: null) => void; updater.checkForUpdates.mockReturnValue(new Promise(done => { release = done }))
  const pending = controller.check(); controller.dispose(); expect(() => updater.emit('error', new Error('late'))).not.toThrow()
  release(null); await pending; await Promise.resolve(); expect(updater.listenerCount('error')).toBe(0)
})
it('never loads or configures the updater module in development', async () => {
  make(false, false).initialize(); await controller.check(); expect(controller.status().phase).toBe('development')
  expect(state.loads).toBe(0); expect(updater.setFeedURL).not.toHaveBeenCalled(); expect(updater.checkForUpdates).not.toHaveBeenCalled()
})
it('loads the packaged updater on the first check only and pins it before checking', async () => {
  make(true, false).initialize(); expect(state.loads).toBe(0); expect(updater.setFeedURL).not.toHaveBeenCalled()
  updater.checkForUpdates.mockImplementation(async () => {
    expect(updater).toMatchObject({ autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, disableWebInstaller: true, forceDevUpdateConfig: false, logger: null })
    expect(updater.setFeedURL).toHaveBeenCalledExactlyOnceWith({ provider: 'github', owner: 'lizhuoh9', repo: 'LatexStudio', private: false })
    updater.emit('update-available', { version: '0.3.1' }); return null
  })
  const first = controller.check(); expect(controller.check()).toBe(first); await first
  expect(controller.status()).toMatchObject({ phase: 'available', latestVersion: '0.3.1', manualInstallOnly: true })
  await controller.check(); expect(state.loads).toBe(1); expect(updater.setFeedURL).toHaveBeenCalledOnce(); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  expect(updater.downloadUpdate).not.toHaveBeenCalled(); expect(updater.quitAndInstall).not.toHaveBeenCalled()
})
it('does not configure, listen to or check a lazily loaded updater after disposal', async () => {
  make(true, false); const pending = controller.check(); controller.dispose(); await pending
  expect(state.loads).toBe(0); expect(updater.setFeedURL).not.toHaveBeenCalled(); expect(updater.checkForUpdates).not.toHaveBeenCalled()
  expect(updater.listenerCount('error') + updater.listenerCount('update-available') + updater.listenerCount('update-not-available')).toBe(0)
})
