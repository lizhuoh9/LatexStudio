import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  packaged: false, empty: false, image: { isEmpty: () => state.empty },
  imagePath: vi.fn(), options: [] as Array<Record<string, unknown>>,
  listeners: new Map<string, (event: { preventDefault(): void }) => void>(),
  open: null as (() => { action: string }) | null
}))
vi.mock('electron', () => ({
  app: { get isPackaged() { return state.packaged } },
  nativeImage: { createFromPath: (path: string) => { state.imagePath(path); return state.image } },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) { state.options.push(options) }
    webContents = {
      on: (name: string, action: (event: { preventDefault(): void }) => void) => { state.listeners.set(name, action) },
      setWindowOpenHandler: (action: () => { action: string }) => { state.open = action }
    }
  }
}))
import { createWorkspaceWindow, workspaceUrl } from '../src/main/workspace/window'

beforeEach(() => {
  vi.unstubAllEnvs(); state.packaged = false; state.empty = false; state.imagePath.mockClear()
  state.options.length = 0; state.listeners.clear(); state.open = null
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('native workbench window identity and security', () => {
  it('uses the original application icon rather than the generic Electron icon', () => {
    createWorkspaceWindow()
    expect(String(state.imagePath.mock.calls[0]?.[0]).replaceAll('\\', '/')).toMatch(/\/resources\/icons\/paperstudio-256\.png$/)
    expect(state.options[0]?.icon).toBe(state.image)
    expect(state.options[0]?.title).toBe('LatexStudio · 本地论文工作台')
  })
  it('looks only inside packaged resources for the installed icon', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    try {
      Object.defineProperty(process, 'resourcesPath', { value: 'C:/PaperStudio/resources', configurable: true })
      state.packaged = true; createWorkspaceWindow()
      expect(String(state.imagePath.mock.calls[0]?.[0]).replaceAll('\\', '/')).toBe('C:/PaperStudio/resources/icons/paperstudio-256.png')
    } finally {
      if (descriptor) Object.defineProperty(process, 'resourcesPath', descriptor)
      else Reflect.deleteProperty(process, 'resourcesPath')
    }
  })
  it('does not make an optional missing decorative icon a data-access bypass', () => {
    state.empty = true; createWorkspaceWindow()
    expect(state.options[0]?.icon).toBeUndefined()
    expect(state.options[0]?.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false })
  })
  it('denies in-app navigation, redirect, frame and webview attachment and new windows', () => {
    createWorkspaceWindow()
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview']) {
      const preventDefault = vi.fn(); state.listeners.get(name)!({ preventDefault })
      expect(preventDefault).toHaveBeenCalledOnce()
    }
    expect(state.open?.()).toEqual({ action: 'deny' })
  })
  it('accepts only the local development origin or the built application URL', () => {
    expect(workspaceUrl()).toMatch(/^file:/)
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173/')
    expect(workspaceUrl()).toBe('http://127.0.0.1:5173/')
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://example.invalid/')
    expect(() => workspaceUrl()).toThrow('本机 HTTP')
  })
})
