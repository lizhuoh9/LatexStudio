import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ build: vi.fn(), set: vi.fn(), find: vi.fn(), prepare: vi.fn(), bundle: vi.fn() }))
vi.mock('electron', () => ({ Menu: { buildFromTemplate: state.build, setApplicationMenu: state.set }, ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/tex/prepare', () => ({ findPreparedTex: state.find, prepareNativeTex: state.prepare }))
vi.mock('../src/main/tex/bundled-runtime', () => ({ findBundledTexArchive: state.bundle }))
import { installWorkspaceMenu } from '../src/main/workspace/menu'
import { TexSetupController } from '../src/main/tex/controller'
import { setLocale, translate } from '../src/shared/i18n'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { vi.clearAllMocks(); setLocale('zh-CN'); state.build.mockReturnValue({ native: true }) })
afterEach(() => { setLocale('zh-CN'); Object.defineProperty(process, 'platform', platform) })

describe('macOS editing contracts (not a real Mac execution test)', () => {
  it('provides native app/Edit/Window roles and a normal window-close action', () => {
    installWorkspaceMenu('darwin')
    expect(state.build).toHaveBeenCalledWith([
      { label: 'LatexStudio', submenu: expect.arrayContaining([
        { role: 'about', label: '关于 LatexStudio' }, { role: 'services', label: '服务' },
        { role: 'hide', label: '隐藏 LatexStudio' }, { role: 'quit', label: '退出 LatexStudio' }
      ]) },
      { label: '文件', submenu: [{ role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+W' }] },
      { role: 'editMenu', label: '编辑', submenu: expect.arrayContaining([
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }
      ]) },
      { role: 'windowMenu', label: '窗口', submenu: expect.arrayContaining([
        { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }, { role: 'front', label: '全部置于顶层' }
      ]) }
    ])
    expect(state.set).toHaveBeenCalledWith({ native: true })
    // No custom click handler, process.exit, direct write or clipboard IPC bypasses the existing close handshake.
    expect(JSON.stringify(state.build.mock.calls)).not.toContain('click')
  })
  it.each(['en', 'ko'] as const)('rebuilds native menu labels in %s without custom close/quit handlers', locale => {
    setLocale(locale); installWorkspaceMenu('darwin')
    expect(translate('文件')).not.toBe('文件')
    expect(state.build).toHaveBeenCalledWith(expect.arrayContaining([
      { label: translate('文件'), submenu: [{ role: 'close', label: translate('关闭窗口'), accelerator: 'CmdOrCtrl+W' }] },
      expect.objectContaining({ role: 'editMenu', label: translate('编辑') }),
      expect.objectContaining({ role: 'windowMenu', label: translate('窗口') })
    ]))
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
