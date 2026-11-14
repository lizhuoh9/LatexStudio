import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEX_SETUP_CHANNELS as C } from '../src/shared/tex-setup-contracts'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  frame: { url: 'file:///app/workspace.html' }, send: vi.fn(), consent: vi.fn(),
  find: vi.fn(), prepare: vi.fn(), bundle: vi.fn(), destroyed: false
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => state.handlers.set(name, handler) },
  dialog: { showMessageBox: state.consent }
}))
vi.mock('../src/main/tex/prepare', () => ({ findPreparedTex: state.find, prepareNativeTex: state.prepare }))
vi.mock('../src/main/tex/bundled-runtime', () => ({ findBundledTexArchive: state.bundle }))
import { TexSetupController } from '../src/main/tex/controller'

const PREPARED = { root: 'fixture', manifest: {} }
const ARCHIVE = 'C:/application/resources/tex-runtime/pinned.zip'
function controller(): TexSetupController {
  const window = { isDestroyed: () => state.destroyed, webContents: { id: 7, mainFrame: state.frame, send: state.send } } as unknown as BrowserWindow
  const instance = new TexSetupController(window, state.frame.url, 'C:/fixture/PaperStudio',
    { get: (dataRoot: string, signal?: AbortSignal) => state.find(`${dataRoot}/tex/runtimes`, 'win32', signal) })
  instance.register(); return instance
}
function sender() { return { sender: { id: 7 }, senderFrame: state.frame } }
function invoke(name: string, event = sender(), ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(name)
  if (!handler) throw new Error('Missing fixture handler')
  return handler(event, ...args)
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function publishedReady(): boolean { return state.send.mock.calls.some(call => call[1]?.phase === 'prepared') }
beforeEach(() => {
  vi.clearAllMocks(); state.handlers.clear(); state.frame.url = 'file:///app/workspace.html'; state.destroyed = false
  state.find.mockReset().mockResolvedValue(null)
  state.bundle.mockReset().mockResolvedValue(ARCHIVE)
  state.prepare.mockReset().mockImplementation(async () => { state.find.mockResolvedValue(PREPARED); return PREPARED })
  state.consent.mockReset()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Runtime must not access the network')))
})
afterEach(() => vi.unstubAllGlobals())

describe.skipIf(process.platform !== 'win32')('automatic offline TeX setup controller', () => {
  it('keeps status read-only and marks only a trusted runtime as prepared', async () => {
    controller()
    expect(await invoke(C.status)).toMatchObject({ phase: 'required', compileVerified: false, supported: true })
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.bundle).not.toHaveBeenCalled()
    state.find.mockResolvedValue(PREPARED)
    expect(await invoke(C.status)).toMatchObject({ phase: 'prepared', compileVerified: true })
  })
  it('reports background checking, not unconfigured or configuring, while the initial trusted lookup is pending', async () => {
    const found = deferred<unknown>(); state.find.mockReturnValue(found.promise)
    const instance = controller(), initializing = instance.initialize()
    expect(await instance.status()).toMatchObject({ phase: 'checking', compileVerified: false, supported: true,
      message: expect.stringContaining('后台验证') })
    expect(JSON.stringify(state.send.mock.calls)).not.toContain('正在配置')
    expect(JSON.stringify(state.send.mock.calls)).not.toContain('尚未配置')
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.bundle).not.toHaveBeenCalled()
    found.resolve(PREPARED); expect(await initializing).toMatchObject({ phase: 'prepared', compileVerified: true })
    expect(state.find).toHaveBeenCalledOnce()
  })
  it('reuses one in-flight status detection when startup initialization overlaps it', async () => {
    const found = deferred<unknown>(); state.find.mockReturnValue(found.promise)
    const instance = controller(), detecting = instance.status(), initializing = instance.initialize()
    expect(await instance.status()).toMatchObject({ phase: 'checking', compileVerified: false,
      message: expect.stringContaining('可先编辑') })
    expect(publishedReady()).toBe(false); expect(state.find).toHaveBeenCalledOnce()
    found.resolve(PREPARED); await detecting
    expect(await initializing).toMatchObject({ phase: 'prepared', compileVerified: true })
    expect(state.find).toHaveBeenCalledOnce(); expect(state.prepare).not.toHaveBeenCalled()
    expect(state.bundle).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    await instance.status(); expect(state.find).toHaveBeenCalledTimes(2) // No persistent startup-ready shortcut.
  })
  it('reuses an in-flight missing-runtime result before preparation and still verifies the prepared runtime', async () => {
    const found = deferred<unknown>(); state.find.mockReturnValueOnce(found.promise)
    const instance = controller(), detecting = instance.status(), initializing = instance.initialize()
    found.resolve(null); await detecting
    expect(await initializing).toMatchObject({ phase: 'prepared', compileVerified: true })
    expect(state.find).toHaveBeenCalledTimes(2); expect(state.prepare).toHaveBeenCalledOnce()
    expect(state.bundle).toHaveBeenCalledOnce()
  })
  it('fails closed if an overlapping status detection fails rather than treating it as a trusted runtime', async () => {
    const found = deferred<void>()
    state.find.mockReturnValue(found.promise.then(() => { throw new Error('PRIVATE lookup failed') }))
    const instance = controller(), detecting = instance.status(), initializing = instance.initialize()
    // A failed lookup is distinct from the successfully checked absence of a runtime.
    found.resolve(); await detecting
    expect(await initializing).toMatchObject({ phase: 'error', compileVerified: false })
    expect(state.find).toHaveBeenCalledOnce(); expect(state.prepare).not.toHaveBeenCalled()
    expect(state.bundle).not.toHaveBeenCalled(); expect(publishedReady()).toBe(false); expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(state.send.mock.calls)).not.toContain('PRIVATE')
  })
  it('never publishes a late trusted overlap result after cancellation and still waits for lookup cleanup', async () => {
    const found = deferred<unknown>(); state.find.mockReturnValue(found.promise)
    const instance = controller(), detecting = instance.status(), initializing = instance.initialize()
    let ended = false; const cancel = instance.cancelAndWait().then(() => { ended = true })
    await Promise.resolve(); expect(ended).toBe(false)
    found.resolve(PREPARED); await cancel; await detecting
    expect(await initializing).toMatchObject({ phase: 'required', compileVerified: false })
    expect(state.find).toHaveBeenCalledOnce(); expect(publishedReady()).toBe(false)
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.bundle).not.toHaveBeenCalled()
  })
  it('initializes bundled components automatically without a download or consent dialog', async () => {
    const instance = controller()
    expect(await instance.initialize()).toMatchObject({ phase: 'prepared', compileVerified: true })
    expect(state.bundle).toHaveBeenCalledOnce()
    expect(state.prepare).toHaveBeenCalledWith('C:/fixture/PaperStudio', expect.objectContaining({ archivePath: ARCHIVE, signal: expect.any(AbortSignal) }))
    expect(state.consent).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('reuses an already trusted runtime even if no bundled archive needs opening', async () => {
    state.find.mockResolvedValue(PREPARED)
    expect(await controller().initialize()).toMatchObject({ phase: 'prepared', compileVerified: true })
    expect(state.bundle).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled()
  })
  it('rejects foreign windows, subframes, changed URLs and renderer-provided paths', async () => {
    controller()
    await expect(invoke(C.prepare, { ...sender(), sender: { id: 8 } })).rejects.toThrow('不能')
    await expect(invoke(C.status, { ...sender(), senderFrame: { url: state.frame.url } })).rejects.toThrow('不能')
    state.frame.url = 'https://remote.invalid/'
    await expect(invoke(C.status)).rejects.toThrow('不能')
    state.frame.url = 'file:///app/workspace.html'
    await expect(invoke(C.prepare, sender(), 'arbitrary path')).rejects.toThrow('不能')
    expect(state.prepare).not.toHaveBeenCalled(); expect(state.bundle).not.toHaveBeenCalled()
  })
  it('coalesces startup and retries into one real preparation task', async () => {
    const result = deferred<typeof PREPARED>()
    state.prepare.mockReturnValue(result.promise)
    const instance = controller(), first = instance.initialize(), second = instance.prepare()
    expect(first).toBe(second)
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce())
    state.find.mockResolvedValue(PREPARED); result.resolve(PREPARED)
    expect(await first).toMatchObject({ phase: 'prepared', compileVerified: true })
    await instance.prepare(); expect(state.prepare).toHaveBeenCalledOnce()
  })
  it('fails closed on missing bundled files, without silently downloading', async () => {
    state.bundle.mockRejectedValue(new Error('PRIVATE local path'))
    const instance = controller()
    expect(await instance.initialize()).toMatchObject({ phase: 'error', compileVerified: false })
    expect(state.prepare).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(state.send.mock.calls)).not.toContain('PRIVATE')
    state.bundle.mockResolvedValue(ARCHIVE)
    expect(await instance.prepare()).toMatchObject({ phase: 'prepared', compileVerified: true })
  })
  it('waits for actual preparation cleanup on cancel/close', async () => {
    const cleaning = deferred<void>(), started = deferred<void>()
    state.prepare.mockImplementation(async (_root: string, options: { signal: AbortSignal }) => {
      started.resolve(); await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }))
      await cleaning.promise; throw new Error('PRIVATE provider detail')
    })
    const instance = controller(), preparing = instance.initialize(); await started.promise
    instance.blockNewActions(); await expect(invoke(C.prepare)).rejects.toThrow('关闭')
    let closed = false; const close = instance.cancelAndWait().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    cleaning.resolve(); await close
    expect(await preparing).toMatchObject({ phase: 'required', compileVerified: false })
    expect(JSON.stringify(state.send.mock.calls)).not.toContain('PRIVATE')
  })
  it('does not begin preparation after a canceled bundled-file lookup resolves late', async () => {
    const bundle = deferred<string>(); state.bundle.mockReturnValue(bundle.promise)
    const instance = controller(), preparing = instance.initialize()
    await vi.waitFor(() => expect(state.bundle).toHaveBeenCalledOnce())
    const canceled = instance.cancelAndWait(); bundle.resolve(ARCHIVE)
    await canceled; await preparing
    expect(state.prepare).not.toHaveBeenCalled(); expect(publishedReady()).toBe(false)
  })
  it('never trusts a preparation progress event before the shared compile-runtime check', async () => {
    const verified = deferred<unknown>()
    state.find.mockResolvedValueOnce(null).mockReturnValueOnce(verified.promise)
    state.prepare.mockImplementation(async (_root: string, options: { onProgress: (value: unknown) => void }) => {
      options.onProgress({ phase: 'prepared', completed: 1, total: 1 }); return PREPARED
    })
    const instance = controller(), task = instance.initialize()
    await vi.waitFor(() => expect(state.find).toHaveBeenCalledTimes(2))
    expect(await instance.status()).toMatchObject({ phase: 'verifying', compileVerified: false })
    expect(publishedReady()).toBe(false)
    verified.resolve(PREPARED); expect(await task).toMatchObject({ phase: 'prepared', compileVerified: true })
  })
  it('refuses a runtime rejected after local extraction', async () => {
    state.prepare.mockResolvedValue(PREPARED)
    expect(await controller().initialize()).toMatchObject({ phase: 'error', compileVerified: false })
    expect(publishedReady()).toBe(false)
  })
  it('does not leak local provider details from detection or preparation', async () => {
    const instance = controller(); state.find.mockRejectedValue(new Error('secret=PRIVATE path=PRIVATE'))
    expect(JSON.stringify(await instance.status())).not.toContain('PRIVATE')
    state.find.mockResolvedValue(null); state.prepare.mockRejectedValue(new Error('token=PRIVATE'))
    expect(await instance.prepare()).toMatchObject({ phase: 'error', compileVerified: false })
    expect(JSON.stringify(state.send.mock.calls)).not.toContain('PRIVATE')
  })
  it('does not regress active progress when a startup status scan settles', async () => {
    const found = deferred<unknown>(); state.find.mockReturnValue(found.promise)
    const preparing = deferred<unknown>()
    state.prepare.mockImplementation((_root: string, options: { onProgress: (value: unknown) => void }) => {
      options.onProgress({ phase: 'extracting', completed: 5, total: 10 }); return preparing.promise
    })
    const instance = controller(), status = instance.status(), task = instance.initialize()
    state.find.mockResolvedValue(null); found.resolve(null); await status
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce())
    expect(await instance.status()).toMatchObject({ phase: 'extracting', completed: 5, total: 10 })
    state.find.mockResolvedValue(PREPARED); preparing.resolve(PREPARED); await task
  })
  it('never publishes ready for a verification result that arrives after cancellation', async () => {
    const started = deferred<void>(), late = deferred<unknown>()
    state.prepare.mockImplementation(() => { started.resolve(); return late.promise })
    const instance = controller(), preparing = instance.initialize(); await started.promise
    const cancel = instance.cancelAndWait(); state.find.mockResolvedValue(PREPARED); late.resolve(PREPARED)
    await cancel; expect(await preparing).toMatchObject({ phase: 'required', compileVerified: false })
    expect(publishedReady()).toBe(false)
  })
  it('aborts a startup scan and waits for the tracked lookup to finish', async () => {
    const cleanup = deferred<void>()
    state.find.mockImplementation((_base: string, _platform: string, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => { void cleanup.promise.then(() => reject(new Error('canceled'))) }, { once: true })))
    const instance = controller(), checking = instance.status()
    let ended = false; const cancel = instance.cancelAndWait().then(() => { ended = true })
    await Promise.resolve(); expect(ended).toBe(false)
    cleanup.resolve(); await cancel; expect(await checking).toMatchObject({ phase: 'required' })
    expect(state.prepare).not.toHaveBeenCalled()
  })
  it('revokes stale ready status when the compiler runtime disappears, without a network fallback', async () => {
    const instance = controller(); await instance.initialize()
    state.find.mockResolvedValue(null)
    expect(await instance.status()).toMatchObject({ phase: 'error', compileVerified: false })
    expect(state.prepare).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled()
    state.find.mockResolvedValue(PREPARED)
    expect(await instance.status()).toMatchObject({ phase: 'prepared', compileVerified: true })
  })
  it('does not initialize a destroyed or closing workspace', async () => {
    const instance = controller(); instance.blockNewActions(); await instance.initialize()
    instance.resumeActions(); state.destroyed = true; await instance.initialize()
    expect(state.find).not.toHaveBeenCalled(); expect(state.bundle).not.toHaveBeenCalled()
  })
})
