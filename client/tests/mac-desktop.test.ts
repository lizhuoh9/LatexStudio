import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ build: vi.fn(), set: vi.fn(), find: vi.fn(), prepare: vi.fn(), bundle: vi.fn() }))
vi.mock('electron', () => ({ Menu: { buildFromTemplate: state.build, setApplicationMenu: state.set }, ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/tex/prepare', () => ({ findPreparedTex: state.find, prepareNativeTex: state.prepare }))
vi.mock('../src/main/tex/bundled-runtime', () => ({ findBundledTexArchive: state.bundle }))
import { installWorkspaceMenu } from '../src/main/workspace/menu'
import { TexSetupController } from '../src/main/tex/controller'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { vi.clearAllMocks(); state.build.mockReturnValue({ native: true }) })
afterEach(() => { Object.defineProperty(process, 'platform', platform) })

describe('macOS editing contracts (not a real Mac execution test)', () => {
  it('provides native app/Edit/Window roles and a normal window-close action', () => {
    installWorkspaceMenu('darwin')
    expect(state.build).toHaveBeenCalledWith([
      { label: 'LatexStudio', submenu: [{ role: 'about', label: '关于 LatexStudio' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide', label: '隐藏 LatexStudio' },
        { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit', label: '退出 LatexStudio' }] },
      { label: '文件', submenu: [{ role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' }] },
      { role: 'editMenu' }, { role: 'windowMenu' }
    ])
    expect(state.set).toHaveBeenCalledWith({ native: true })
    // No custom click handler, process.exit, direct write or clipboard IPC bypasses the existing close handshake.
    expect(JSON.stringify(state.build.mock.calls)).not.toContain('click')
  })
  it.each(['win32', 'linux'] as const)('preserves the existing menu policy on %s', value => {
    installWorkspaceMenu(value); expect(state.set).toHaveBeenCalledWith(null); expect(state.build).not.toHaveBeenCalled()
  })
  it('uses the host platform when no override is supplied', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    installWorkspaceMenu(); expect(state.build).toHaveBeenCalledOnce()
  })
  it.each(['darwin', 'linux'] as const)('never prepares or trusts a Windows TeX runtime on %s', async value => {
    Object.defineProperty(process, 'platform', { ...platform, value })
    const send = vi.fn(), window = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow
    const controller = new TexSetupController(window, 'file:///workspace.html', '/fixture', { get: state.find }, state.prepare)
    for (const result of [await controller.status(), await controller.initialize(), await controller.prepare(), await controller.cancelAndWait()]) {
      expect(result).toMatchObject({ supported: false, compileVerified: false, phase: 'required' })
      expect(result.message).toContain('仍可新建、打开、编辑和保存论文')
    }
    expect(state.find).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled(); expect(state.bundle).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalled()
  })
})
