import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_LINKS_CHANNELS as C, type DesktopLinksApi } from '../src/shared/desktop-links-contracts'
import { setLocale } from '../src/shared/i18n'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const st = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(), events: new Map<string, (...args: unknown[]) => void>(),
  exposed: new Map<string, unknown>(), rendererEvents: new Map<string, Handler>(),
  invoke: vi.fn(), removeListener: vi.fn(), protocol: vi.fn().mockReturnValue(true), packaged: false
}))
vi.mock('electron', () => ({
  app: { get isPackaged() { return st.packaged }, setAsDefaultProtocolClient: st.protocol,
    on: (name: string, callback: (...args: unknown[]) => void) => st.events.set(name, callback) },
  ipcMain: { handle: (name: string, callback: Handler) => st.handlers.set(name, callback) },
  contextBridge: { exposeInMainWorld: (name: string, value: unknown) => st.exposed.set(name, value) },
  ipcRenderer: { invoke: st.invoke, on: (name: string, callback: Handler) => st.rendererEvents.set(name, callback),
    removeListener: st.removeListener }
}))
import { DesktopLinksController, registerDesktopLinkEvents, registerProjectProtocol } from '../src/main/desktop-links'

const url = 'file:///fixture/renderer/index.html'
const first = 'latexstudio://join/alice/paper.git', second = 'latexstudio://join/bob/second'
function fixture(ready = true) {
  const events = new Map<string, () => void>(), contentsEvents = new Map<string, () => void>()
  const contents = { id: 17, mainFrame: { url: ready ? url : '' }, send: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false), getURL: vi.fn().mockReturnValue(ready ? url : ''),
    on: (name: string, callback: () => void) => contentsEvents.set(name, callback) }
  const window = { webContents: contents, isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false), restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    once: (name: string, callback: () => void) => events.set(name, callback) }
  const links = new DesktopLinksController()
  const attach = () => links.attach(window as unknown as BrowserWindow, url)
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame })
  const invoke = (channel: string, ...args: unknown[]) => st.handlers.get(channel)!(event(), ...args)
  const finishLoad = () => { contents.getURL.mockReturnValue(url); contents.mainFrame = { url }; contentsEvents.get('did-finish-load')!() }
  return { links, window, contents, events, attach, event, invoke, finishLoad }
}

beforeEach(() => {
  st.handlers.clear(); st.events.clear(); st.exposed.clear(); st.rendererEvents.clear()
  st.invoke.mockReset(); st.removeListener.mockReset(); st.protocol.mockReset().mockReturnValue(true)
  st.packaged = false; setLocale('zh-CN')
  vi.stubEnv('PORTABLE_EXECUTABLE_DIR', ''); vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '')
})
afterEach(() => { vi.unstubAllEnvs(); setLocale('zh-CN') })

describe('bounded desktop invitation delivery, not remote authority', () => {
  it('retains only the latest valid cold link and delivers after the trusted main frame loads', () => {
    const f = fixture(false)
    expect(f.links.receive(first)).toBe(true)
    f.attach()
    expect(f.contents.send).not.toHaveBeenCalled(); expect(f.window.focus).not.toHaveBeenCalled()
    expect(f.links.receive(second)).toBe(true)
    expect(f.links.receive('latexstudio://join/alice/paper?token=PRIVATE')).toBe(false)
    f.finishLoad()
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(C.link, second)
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.invoke(C.pending)).toBe(second)
  })

  it('matches acknowledgements exactly and never clears a newer link with a stale acknowledgement', () => {
    const f = fixture(); f.attach(); f.links.receive(first); f.links.receive(second)
    f.invoke(C.acknowledge, first); expect(f.invoke(C.pending)).toBe(second)
    f.invoke(C.acknowledge, second); expect(f.invoke(C.pending)).toBeNull()
    f.invoke(C.acknowledge, second); expect(f.invoke(C.pending)).toBeNull()
  })

  it.each([[], [null], [false], [{}], [first, 'extra'], ['https://github.com/alice/paper.git'],
    [`${first}/`], ['latexstudio://join/alice/paper?x=1'], ['x'.repeat(10000)]].map(args => ({ args })))('rejects malformed ack args $args', ({ args }) => {
    const f = fixture(); f.attach(); f.links.receive(first)
    expect(() => f.invoke(C.acknowledge, ...args)).toThrow('项目链接请求无效')
    expect(f.invoke(C.pending)).toBe(first)
  })

  it('rejects extra pending args without consuming the invitation', () => {
    const f = fixture(); f.attach(); f.links.receive(first)
    expect(() => f.invoke(C.pending, null)).toThrow('项目链接请求无效')
    expect(f.invoke(C.pending)).toBe(first)
  })

  it.each(['foreign-sender', 'same-id-object', 'subframe', 'query', 'hash', 'navigated-window',
    'navigated-mainframe', 'replaced-mainframe', 'destroyed-window', 'destroyed-contents'] as const)('freshly rejects %s', kind => {
    const f = fixture(); f.attach(); f.links.receive(first)
    const event = f.event()
    if (kind === 'foreign-sender') event.sender = { ...f.contents, id: 99 }
    if (kind === 'same-id-object') event.sender = { ...f.contents }
    if (kind === 'subframe') event.senderFrame = { url }
    if (kind === 'query') event.senderFrame = { url: `${url}?x=1` }
    if (kind === 'hash') event.senderFrame = { url: `${url}#x` }
    if (kind === 'navigated-window') f.contents.getURL.mockReturnValue('https://evil.example')
    if (kind === 'navigated-mainframe') f.contents.mainFrame.url = 'https://evil.example'
    if (kind === 'replaced-mainframe') f.contents.mainFrame = { url }
    if (kind === 'destroyed-window') f.window.isDestroyed.mockReturnValue(true)
    if (kind === 'destroyed-contents') f.contents.isDestroyed.mockReturnValue(true)
    expect(() => st.handlers.get(C.pending)!(event)).toThrow('此页面不能访问项目链接')
    expect(() => st.handlers.get(C.acknowledge)!(event, first)).toThrow('此页面不能访问项目链接')
  })

  it('does not broadcast to a navigated page and recovers only at the exact app URL', () => {
    const f = fixture(); f.attach(); f.contents.getURL.mockReturnValue(`${url}#foreign`)
    f.links.receive(first)
    expect(f.contents.send).not.toHaveBeenCalled(); expect(f.window.focus).not.toHaveBeenCalled()
    f.finishLoad(); expect(f.contents.send).toHaveBeenCalledWith(C.link, first)
  })

  it('gates get/ack/notify/focus during close and resumes the latest invitation after canceled close', () => {
    const f = fixture(); f.attach(); f.links.receive(first)
    f.contents.send.mockClear(); f.window.focus.mockClear(); f.window.show.mockClear()
    f.links.blockNewActions(); f.links.receive(second); f.links.focus()
    expect(() => f.invoke(C.pending)).toThrow('此页面不能访问项目链接')
    expect(() => f.invoke(C.acknowledge, first)).toThrow('此页面不能访问项目链接')
    expect(f.contents.send).not.toHaveBeenCalled(); expect(f.window.focus).not.toHaveBeenCalled()
    f.links.resumeActions()
    expect(f.invoke(C.pending)).toBe(second)
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(C.link, second)
    expect(f.window.focus).toHaveBeenCalledOnce()
  })

  it('never resumes a closed window or stores more invitations after disposal', () => {
    const f = fixture(); f.attach(); f.links.receive(first); f.events.get('closed')!()
    f.contents.send.mockClear(); f.window.focus.mockClear()
    expect(f.links.receive(second)).toBe(false)
    f.links.resumeActions(); f.links.focus()
    expect(f.contents.send).not.toHaveBeenCalled(); expect(f.window.focus).not.toHaveBeenCalled()
    expect(() => f.invoke(C.pending)).toThrow('此页面不能访问项目链接')
  })

  it('restores a minimized app only for a safe invitation', () => {
    const f = fixture(); f.attach(); f.window.isMinimized.mockReturnValue(true)
    expect(f.links.receive('https://github.com/alice/paper')).toBe(false)
    expect(f.links.receive('file:///private')).toBe(false)
    expect(f.window.restore).not.toHaveBeenCalled()
    f.links.receive(first); expect(f.window.restore).toHaveBeenCalledOnce()
  })
})

describe('OS entrypoints and protocol registration', () => {
  it('handles cold argv, second instance and mac open-url as prefill only, ignoring unrelated args and URLs', () => {
    const f = fixture(); registerDesktopLinkEvents(f.links, ['app.exe', '--PRIVATE', first]); f.attach()
    expect(f.invoke(C.pending)).toBe(first)
    st.events.get('second-instance')!({}, ['app.exe', 'https://github.com/evil/repo', second], '/untrusted/cwd', {})
    expect(f.invoke(C.pending)).toBe(second)
    const event = { preventDefault: vi.fn() }
    st.events.get('open-url')!(event, first)
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(f.invoke(C.pending)).toBe(first)
    st.events.get('open-url')!(event, 'latexstudio://join/alice/paper?secret=PRIVATE')
    expect(f.invoke(C.pending)).toBe(first)
    const before = f.window.focus.mock.calls.length
    st.events.get('second-instance')!({}, ['app.exe'])
    expect(f.window.focus).toHaveBeenCalledTimes(before + 1)
  })

  it('registers mac listeners before readiness and delivers a pre-window open-url later', () => {
    const f = fixture(false); registerDesktopLinkEvents(f.links, [])
    st.events.get('open-url')!({ preventDefault: vi.fn() }, first)
    f.attach(); expect(f.contents.send).not.toHaveBeenCalled()
    f.finishLoad(); expect(f.invoke(C.pending)).toBe(first)
  })

  it('bounds argv inspection and publishes only the last valid link in the admitted batch', () => {
    const f = fixture(); f.attach()
    const args = Array.from({ length: 129 }, () => '--not-a-link')
    args[1] = first; args[127] = second; args[128] = 'latexstudio://join/not/admitted'
    f.links.receiveArguments(args)
    expect(f.invoke(C.pending)).toBe(second)
    expect(f.contents.send).toHaveBeenCalledExactlyOnceWith(C.link, second)
    expect(f.links.receiveArguments(['latexstudio://join/alice/' + 'x'.repeat(10000)])).toBe(false)
    expect(f.invoke(C.pending)).toBe(second)
  })

  it('does not register dev Electron or either portable launch variant as a default handler', () => {
    registerProjectProtocol(); expect(st.protocol).not.toHaveBeenCalled()
    st.packaged = true; vi.stubEnv('PORTABLE_EXECUTABLE_DIR', '/portable')
    registerProjectProtocol(); expect(st.protocol).not.toHaveBeenCalled()
    vi.stubEnv('PORTABLE_EXECUTABLE_DIR', ''); vi.stubEnv('PORTABLE_EXECUTABLE_FILE', '/portable.exe')
    registerProjectProtocol(); expect(st.protocol).not.toHaveBeenCalled()
    vi.stubEnv('PORTABLE_EXECUTABLE_FILE', ''); registerProjectProtocol()
    expect(st.protocol).toHaveBeenCalledExactlyOnceWith('latexstudio')
  })

  it('does not prevent local startup or claim successful registration if the OS refuses', () => {
    st.packaged = true; st.protocol.mockReturnValueOnce(false)
    expect(registerProjectProtocol()).toBe(false)
    st.protocol.mockImplementationOnce(() => { throw new Error('OS denied') })
    expect(registerProjectProtocol()).toBe(false)
  })
})

describe('narrow, removable preload subscription', () => {
  it('exposes only pending, matching acknowledgement and validated URI notifications', async () => {
    await import('../src/preload/index')
    const api = st.exposed.get('paperstudioDesktopLinks') as DesktopLinksApi
    expect(Object.keys(api).sort()).toEqual(['acknowledge', 'onLink', 'pending'])
    st.invoke.mockResolvedValueOnce(first)
    expect(await api.pending()).toBe(first); expect(st.invoke).toHaveBeenLastCalledWith(C.pending)
    await api.acknowledge(first); expect(st.invoke).toHaveBeenLastCalledWith(C.acknowledge, first)
    const listener = vi.fn(), unsubscribe = api.onLink(listener), handler = st.rendererEvents.get(C.link)!
    handler({}, { appUrl: first }); handler({}, 'https://github.com/alice/paper.git')
    handler({}, first + '?token=PRIVATE'); handler({}, first + '/'); handler({}, first)
    expect(listener).toHaveBeenCalledExactlyOnceWith(first)
    unsubscribe(); expect(st.removeListener).toHaveBeenCalledWith(C.link, handler)
  })
})
