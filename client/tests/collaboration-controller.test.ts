import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { COLLABORATION_CHANNELS as C, type CollaborationState, type DevicePrompt } from '../src/shared/collaboration-contracts'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  status: vi.fn<() => CollaborationState>(), restore: vi.fn<() => Promise<CollaborationState>>(), start: vi.fn<() => CollaborationState>(),
  cancel: vi.fn<() => Promise<CollaborationState>>(), logout: vi.fn<() => Promise<CollaborationState>>(),
  projects: vi.fn<() => Promise<unknown[]>>(), open: vi.fn<(url: string) => Promise<void>>(),
  onState: null as ((state: CollaborationState) => void) | null,
  authorize: null as ((prompt: DevicePrompt, signal: AbortSignal) => Promise<void>) | null,
  closed: null as (() => void) | null
}))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: typeof mocks.handlers extends Map<string, infer H> ? H : never) => mocks.handlers.set(name, handler) },
  shell: { openExternal: mocks.open } }))
vi.mock('../src/main/collaboration/service', () => ({ GitHubAccountService: class {
  status = mocks.status; restoreSession = mocks.restore; startLogin = mocks.start; cancelAndWait = mocks.cancel; logout = mocks.logout; projects = mocks.projects
  constructor(options: { onState: (state: CollaborationState) => void; openAuthorization: typeof mocks.authorize }) {
    mocks.onState = options.onState; mocks.authorize = options.openAuthorization
  }
} }))
import { CollaborationController } from '../src/main/collaboration/controller'

const URL = 'file:///fixture/index.html', frame = { url: URL }
const window = { isDestroyed: vi.fn(() => false), once: (_name: string, handler: () => void) => { mocks.closed = handler },
  webContents: { id: 17, mainFrame: frame, send: vi.fn() } }
let event: { sender: { id: number }; senderFrame: { url: string } }, controller: CollaborationController
function state(phase: CollaborationState['phase'] = 'signed-out'): CollaborationState {
  return { phase, message: 'fixture', account: null, authorization: null, expiresAt: null, sessionOnly: true }
}
function authorization(): CollaborationState {
  return { ...state('authorizing'), authorization: { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 60000 } }
}
function invoke(channel: string, ...args: unknown[]): Promise<unknown> { return mocks.handlers.get(channel)!(event, ...args) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve }
}
function prompt(): DevicePrompt {
  const current = authorization(); mocks.status.mockReturnValue(current); mocks.onState!(current)
  return current.authorization!
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.handlers.clear(); window.isDestroyed.mockReturnValue(false)
  event = { sender: { id: 17 }, senderFrame: frame }; mocks.status.mockReturnValue(state())
  mocks.restore.mockImplementation(async () => mocks.status())
  mocks.start.mockImplementation(() => { const value = state('authorizing'); mocks.status.mockReturnValue(value); return value })
  mocks.cancel.mockImplementation(async () => { mocks.status.mockReturnValue(state()); return state() })
  mocks.logout.mockResolvedValue(state()); mocks.projects.mockResolvedValue([]); mocks.open.mockResolvedValue()
  controller = new CollaborationController(window as unknown as BrowserWindow, URL, 'Iv1.fixture-client'); controller.register()
})

describe('collaboration local IPC sender boundary', () => {
  it('restores on a trusted read while still not starting authorization, browser or discovery', async () => {
    expect(await invoke(C.status)).toEqual(state()); expect(mocks.restore).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.projects).not.toHaveBeenCalled()
  })
  it.each(['window', 'subframe', 'url', 'extra'])('rejects forged %s without invoking service', async kind => {
    if (kind === 'window') event.sender.id = 999
    if (kind === 'subframe') event.senderFrame = { url: URL }
    if (kind === 'url') frame.url = 'https://untrusted.invalid/'
    try { await expect(invoke(C.login, ...(kind === 'extra' ? ['unexpected'] : []))).rejects.toThrow('此页面不能') }
    finally { frame.url = URL }
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
  })
  it('rejects destroyed senders', async () => {
    window.isDestroyed.mockReturnValue(true); await expect(invoke(C.status)).rejects.toThrow('此页面不能')
  })
  it('whitelists status and event fields', async () => {
    const internal = Object.assign(state(), { privateMarker: 'CANARY_PRIVATE' }); mocks.status.mockReturnValue(internal)
    expect(JSON.stringify(await invoke(C.status))).not.toContain('CANARY_PRIVATE'); mocks.onState!(internal)
    expect(JSON.stringify(window.webContents.send.mock.calls)).not.toContain('CANARY_PRIVATE')
  })
})
describe('explicit login opens the official authorization page automatically', () => {
  it.each(['unconfigured', 'authorizing', 'signed-in'] as const)('does not restart %s sessions', async phase => {
    mocks.status.mockReturnValue(state(phase)); expect(await invoke(C.login)).toEqual(state(phase))
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled()
  })
  it('starts directly on an explicit login and opens only after the fresh validated prompt', async () => {
    await invoke(C.login); expect(mocks.start).toHaveBeenCalledTimes(1); expect(mocks.open).not.toHaveBeenCalled()
    await mocks.authorize!(prompt(), new AbortController().signal)
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('https://github.com/login/device')
  })
  it('does not open on state events, timers, refreshes or an unarmed callback', async () => {
    const current = prompt(); await invoke(C.status)
    await expect(mocks.authorize!(current, new AbortController().signal)).rejects.toThrow()
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('coalesces an in-flight automatic open and explicit retry', async () => {
    await invoke(C.login); const current = prompt(), opening = deferred<void>(); mocks.open.mockReturnValue(opening.promise)
    const automatic = mocks.authorize!(current, new AbortController().signal), retry = invoke(C.openVerification)
    await Promise.resolve(); expect(mocks.open).toHaveBeenCalledTimes(1)
    opening.resolve(); await Promise.all([automatic, retry])
  })
  it('rechecks cancellation before a queued browser launch', async () => {
    await invoke(C.login); const automatic = mocks.authorize!(prompt(), new AbortController().signal)
    const cancelled = invoke(C.cancel)
    await expect(automatic).rejects.toThrow(); await cancelled; expect(mocks.open).not.toHaveBeenCalled()
  })
  it('refuses aborted and replaced prompts', async () => {
    await invoke(C.login); const current = prompt(), abort = new AbortController(); abort.abort()
    await expect(mocks.authorize!(current, abort.signal)).rejects.toThrow()
    const replaced = { ...current, userCode: 'WXYZ-1234' }
    await expect(mocks.authorize!(replaced, new AbortController().signal)).rejects.toThrow()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
describe('retry and project boundaries', () => {
  it('an explicit retry opens only the fixed official page, never a URL/code supplied by the renderer', async () => {
    prompt(); await invoke(C.openVerification)
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('https://github.com/login/device')
    await expect(invoke(C.openVerification, 'https://untrusted.invalid/')).rejects.toThrow('此页面不能')
  })
  it.each(['missing', 'expired', 'external', 'malformed'] as const)('refuses %s verification targets', async kind => {
    const current = authorization()
    if (kind === 'missing') current.authorization = null
    if (kind === 'expired') current.authorization!.expiresAt = 0
    if (kind === 'external') Object.assign(current.authorization!, { verificationUri: 'https://untrusted.invalid/' })
    if (kind === 'malformed') current.authorization!.userCode = 'not-a-code'
    mocks.status.mockReturnValue(current); await expect(invoke(C.openVerification)).rejects.toThrow('协作请求未完成')
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('redacts browser errors and never automatically retries them', async () => {
    prompt(); mocks.open.mockRejectedValue(new Error('CANARY_PRIVATE'))
    await expect(invoke(C.openVerification)).rejects.not.toThrow('CANARY_PRIVATE'); expect(mocks.open).toHaveBeenCalledTimes(1)
  })
  it('returns only whitelisted discovered metadata and redacts provider failures', async () => {
    mocks.projects.mockResolvedValue([{ id: 3, installationId: 2, owner: 'fixture', name: 'paper', private: true, accessToken: 'CANARY_PRIVATE' }])
    expect(await invoke(C.projects)).toEqual([{ id: 3, installationId: 2, owner: 'fixture', name: 'paper', private: true }])
    mocks.projects.mockRejectedValue(new Error('CANARY_PRIVATE')); await expect(invoke(C.projects)).rejects.not.toThrow('CANARY_PRIVATE')
  })
})
describe('collaboration close and local logout', () => {
  it('blocks new IPC while closing and resumes without automatic login', async () => {
    controller.blockNewActions(); await expect(invoke(C.login)).rejects.toThrow('正在安全关闭')
    await expect(invoke(C.projects)).rejects.toThrow('正在安全关闭'); await invoke(C.cancel)
    controller.resumeActions(); await invoke(C.status); expect(mocks.start).not.toHaveBeenCalled()
  })
  it('closing prevents a late callback and waits for an already-dispatched browser action', async () => {
    await invoke(C.login); const current = prompt(), opening = deferred<void>(); mocks.open.mockReturnValue(opening.promise)
    const automatic = mocks.authorize!(current, new AbortController().signal); await Promise.resolve()
    controller.blockNewActions(); const closed = controller.cancelAndWait(); let drained = false; void closed.then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false); opening.resolve(); await automatic; await closed
    await expect(mocks.authorize!(current, new AbortController().signal)).rejects.toThrow()
    expect(mocks.open).toHaveBeenCalledTimes(1)
  })
  it('explicit logout delegates local-only logout without opening a browser', async () => {
    await invoke(C.logout); expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.logout).toHaveBeenCalledTimes(1)
    expect(mocks.open).not.toHaveBeenCalled()
  })
  it('starts local logout immediately but still waits for an outstanding browser request to drain', async () => {
    await invoke(C.login); const current = prompt(), opening = deferred<void>(); mocks.open.mockReturnValue(opening.promise)
    const automatic = mocks.authorize!(current, new AbortController().signal); await Promise.resolve()
    let ended = false; const logout = invoke(C.logout).then(() => { ended = true })
    await Promise.resolve(); expect(mocks.logout).toHaveBeenCalledOnce(); expect(ended).toBe(false)
    opening.resolve(); await automatic; await logout
    expect(ended).toBe(true); expect(mocks.open).toHaveBeenCalledTimes(1)
  })
  it('destroyed windows neither publish nor leave the service running', async () => {
    window.isDestroyed.mockReturnValue(true); mocks.closed!(); mocks.onState!(state()); await Promise.resolve(); await Promise.resolve()
    expect(window.webContents.send).not.toHaveBeenCalled(); expect(mocks.cancel).toHaveBeenCalled()
  })
})
