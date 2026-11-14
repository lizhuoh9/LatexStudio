/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudProject, CollaborationApi, CollaborationState } from '../src/shared/collaboration-contracts'

interface NodeMock { disabled: boolean; hidden: boolean; open: boolean; textContent: string; children: NodeMock[]; append(...nodes: NodeMock[]): void; replaceChildren(): void }
const dom = vi.hoisted(() => {
  const nodes = new Map<string, NodeMock>()
  const make = (): NodeMock => ({ disabled: false, hidden: false, open: false, textContent: '', children: [],
    append(...items) { this.children.push(...items) }, replaceChildren() { this.children = [] } })
  const get = (id: string): NodeMock => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id)! }
  return { nodes, make, get, handlers: new Map<string, () => void>(), text: vi.fn() }
})
vi.mock('../src/renderer/dom', () => ({ button: (id: string, handler: () => void) => dom.handlers.set(id, handler),
  element: dom.get, text: (id: string, value: string) => { dom.get(id).textContent = value; dom.text(id, value) } }))
import { CollaborationPanel } from '../src/renderer/collaboration-panel'
import { VERIFICATION_URI } from '../src/renderer/collaboration-model'

const state = (extra: Partial<CollaborationState> = {}): CollaborationState => ({ phase: 'signed-out', message: 'Synthetic state',
  account: null, authorization: null, expiresAt: null, sessionOnly: true, ...extra })
const signedIn = () => state({ phase: 'signed-in', account: { id: 7, login: 'fixture-user', name: null }, expiresAt: 100000 })
const authorizing = () => state({ phase: 'authorizing', authorization: { userCode: 'ABCD-EFGH', verificationUri: VERIFICATION_URI, expiresAt: 10000 } })
const project: CloudProject = { id: 4, installationId: 2, owner: 'fixture-user', name: 'synthetic-paper', private: true }
let api: CollaborationApi
let receive: (state: CollaborationState) => void
let now: number
const panels: CollaborationPanel[] = []
beforeEach(() => {
  vi.useFakeTimers(); now = 1000; dom.nodes.clear(); dom.handlers.clear(); dom.text.mockClear()
  vi.stubGlobal('document', { createElement: dom.make })
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  api = { status: vi.fn().mockResolvedValue(state()), startLogin: vi.fn().mockResolvedValue(authorizing()),
    cancelLogin: vi.fn().mockResolvedValue(state()), logout: vi.fn().mockResolvedValue(state()),
    openVerification: vi.fn().mockResolvedValue(undefined), projects: vi.fn().mockResolvedValue([project]),
    onState: vi.fn((listener) => { receive = listener; return vi.fn() }) }
})
afterEach(() => { for (const panel of panels.splice(0)) panel.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })
function create(bridge: CollaborationApi | undefined = api): CollaborationPanel {
  const panel = new CollaborationPanel(bridge, () => now); panels.push(panel); panel.initialize(); return panel
}
function child(node: NodeMock, index: number): NodeMock {
  const value = node.children[index]
  if (!value) throw new Error('Expected rendered child node')
  return value
}
async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
async function click(action: string): Promise<void> { dom.handlers.get(`collaboration-${action}`)!(); await settle() }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}

describe('initialization performs status only, never authorization or project discovery', () => {
  it('handles a missing optional API without an unhandled request', async () => {
    const panel = new CollaborationPanel(undefined, () => now); panels.push(panel); panel.initialize()
    await click('login'); await click('verify'); await click('projects')
    expect(api.status).not.toHaveBeenCalled(); expect(dom.get('collaboration-state').textContent).toBe('GitHub 登录不可用')
    expect(dom.get('collaboration-login').disabled).toBe(true)
  })
  it('exposes the existing guarded login action for a startup choice, not a separate auth path', async () => {
    const panel = create(); await settle(); panel.startLogin(); panel.startLogin(); await settle()
    expect(api.startLogin).toHaveBeenCalledOnce(); expect(api.openVerification).not.toHaveBeenCalled()
    panel.dispose(); panel.startLogin(); expect(api.startLogin).toHaveBeenCalledOnce()
  })
  it('notifies the startup view after state changes without triggering login', async () => {
    const changed = vi.fn(), panel = new CollaborationPanel(api, () => now, changed)
    panels.push(panel); panel.initialize(); await settle(); const before = changed.mock.calls.length
    receive(state({ phase: 'unconfigured' })); expect(changed.mock.calls.length).toBeGreaterThan(before)
    panel.startLogin(); expect(api.startLogin).not.toHaveBeenCalled()
  })
  it('only subscribes and queries status once on initialization', async () => {
    const panel = create(); await settle(); panel.initialize()
    expect(api.status).toHaveBeenCalledOnce(); expect(api.onState).toHaveBeenCalledOnce()
    expect(api.startLogin).not.toHaveBeenCalled(); expect(api.openVerification).not.toHaveBeenCalled(); expect(api.projects).not.toHaveBeenCalled()
  })
  it('makes an unconfigured publisher visibly unavailable rather than pretending to log in', async () => {
    vi.mocked(api.status).mockResolvedValue(state({ phase: 'unconfigured' }))
    create(); await settle(); await click('login')
    expect(api.startLogin).not.toHaveBeenCalled(); expect(dom.get('collaboration-state').textContent).toBe('GitHub 登录未配置')
    expect(dom.get('collaboration-code').textContent).toBe('')
  })
  it('offers an explicit retry after an initial Main error but never retries automatically', async () => {
    vi.mocked(api.status).mockResolvedValue(state({ phase: 'error' }))
    create(); await settle()
    expect(api.startLogin).not.toHaveBeenCalled(); expect(api.openVerification).not.toHaveBeenCalled()
    expect(dom.get('collaboration-login').disabled).toBe(false)
    await click('login'); expect(api.startLogin).toHaveBeenCalledOnce()
    expect(dom.get('collaboration-code').textContent).toBe('ABCD-EFGH')
  })
  it('does not let a delayed initial status response overwrite a newer event', async () => {
    const pending = deferred<CollaborationState>(); vi.mocked(api.status).mockReturnValue(pending.promise)
    create(); receive(state({ phase: 'unconfigured' })); pending.resolve(signedIn()); await settle()
    expect(dom.get('collaboration-state').textContent).toContain('未配置')
    expect(dom.get('collaboration-projects').disabled).toBe(true)
  })
})

describe('explicit short-lived device authorization', () => {
  it('keeps Renderer retry explicit without duplicating Main automatic browser opening', async () => {
    create(); await settle(); await click('login')
    expect(dom.get('collaboration-code').textContent).toBe('ABCD-EFGH'); expect(api.openVerification).not.toHaveBeenCalled()
    await click('verify'); expect(api.openVerification).toHaveBeenCalledExactlyOnceWith()
    expect(dom.get('collaboration-verification').textContent).toBe(VERIFICATION_URI)
  })
  it('keeps the required code visible and only the optional address collapsed', async () => {
    create(); await settle(); await click('login')
    expect(dom.get('collaboration-authorization').hidden).toBe(false)
    expect(dom.get('collaboration-code').textContent).toBe('ABCD-EFGH')
    expect(dom.get('collaboration-copy').disabled).toBe(false)
    expect(dom.get('collaboration-fallback').open).toBe(false); expect(dom.get('collaboration-verify').hidden).toBe(false)
    dom.get('collaboration-fallback').open = true; vi.advanceTimersByTime(1000)
    expect(dom.get('collaboration-fallback').open).toBe(true)
    receive(state({ phase: 'authorizing', authorization: { userCode: 'WXYZ-1234', verificationUri: VERIFICATION_URI, expiresAt: 20000 } }))
    expect(dom.get('collaboration-fallback').open).toBe(false); expect(api.openVerification).not.toHaveBeenCalled()
    expect(dom.get('collaboration-expiry').textContent).toContain('秒')
  })
  it('copies only the current user code on an explicit click, never automatically', async () => {
    create(); await settle(); await click('login'); expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    await click('copy'); expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH')
    expect(dom.get('collaboration-copy').textContent).toBe('已复制')
    now = 11000; vi.advanceTimersByTime(1000); await click('copy')
    expect(dom.get('collaboration-copy').disabled).toBe(true); expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1)
  })
  it('keeps clipboard errors generic and ignores completion after cancellation', async () => {
    const pending = deferred<void>(); vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('CANARY_PRIVATE'))
    create(); await settle(); await click('login'); await click('copy')
    expect(dom.get('collaboration-copy').textContent).toBe('复制失败，重试')
    expect(JSON.stringify(dom.text.mock.calls)).not.toContain('CANARY_PRIVATE')
    vi.mocked(navigator.clipboard.writeText).mockReturnValue(pending.promise); await click('copy'); await click('cancel')
    pending.resolve(); await settle()
    expect(dom.get('collaboration-copy').disabled).toBe(true); expect(dom.get('collaboration-copy').textContent).toBe('复制验证码')
  })
  it('surfaces browser-launch failure without hiding the current code or retry', async () => {
    create(); await settle(); await click('login')
    receive({ ...authorizing(), message: '无法打开浏览器，请重试打开授权页。' })
    expect(dom.get('collaboration-detail').hidden).toBe(false)
    expect(dom.get('collaboration-detail').textContent).toContain('无法打开浏览器')
    expect(dom.get('collaboration-code').textContent).toBe('ABCD-EFGH'); expect(dom.get('collaboration-verify').hidden).toBe(false)
  })
  it('clears the visible code as soon as cancellation is requested', async () => {
    const pending = deferred<CollaborationState>(); vi.mocked(api.cancelLogin).mockReturnValue(pending.promise)
    create(); await settle(); await click('login'); await click('cancel')
    expect(dom.get('collaboration-code').textContent).toBe(''); expect(dom.get('collaboration-authorization').hidden).toBe(true)
    pending.resolve(state()); await settle(); expect(dom.get('collaboration-login').disabled).toBe(false)
  })
  it('uses a local expiry timer without logging in or refreshing automatically', async () => {
    create(); await settle(); await click('login'); now = 11000; vi.advanceTimersByTime(1000)
    expect(dom.get('collaboration-code').textContent).toBe(''); expect(dom.get('collaboration-state').textContent).toContain('到期')
    expect(api.status).toHaveBeenCalledOnce(); expect(api.startLogin).toHaveBeenCalledOnce(); expect(api.projects).not.toHaveBeenCalled()
  })
  it('keeps the last true phase on failure without echoing exception secrets', async () => {
    vi.mocked(api.startLogin).mockRejectedValue(new Error('ghp_syntheticfixture ABCD-EFGH'))
    const panel = create(); await settle(); await click('login')
    expect(panel.model.state?.phase).toBe('signed-out'); expect(dom.get('collaboration-error').textContent).toContain('请求未完成')
    expect(JSON.stringify(dom.text.mock.calls)).not.toContain('ghp_syntheticfixture')
    expect(JSON.stringify(dom.text.mock.calls)).not.toContain('ABCD-EFGH')
  })
})

describe('compact account presentation', () => {
  it('shows only active actions without adding healthy-state helper paragraphs', async () => {
    create(); await settle()
    expect(dom.get('collaboration-state').textContent).toBe('未登录'); expect(dom.get('collaboration-detail').hidden).toBe(true)
    expect(dom.get('collaboration-login').hidden).toBe(false); expect(dom.get('collaboration-login').disabled).toBe(false)
    for (const action of ['cancel', 'logout', 'projects', 'status']) expect(dom.get(`collaboration-${action}`).hidden).toBe(true)
    expect(dom.get('collaboration-project-area').hidden).toBe(true)
    receive(signedIn())
    expect(dom.get('collaboration-state').textContent).toBe('fixture-user')
    expect(dom.get('collaboration-login').hidden).toBe(true); expect(dom.get('collaboration-logout').hidden).toBe(false)
    expect(dom.get('collaboration-project-area').hidden).toBe(false)
    expect(dom.get('collaboration-session-expiry').hidden).toBe(false); expect(dom.get('collaboration-session-expiry').textContent).toContain('到期')
  })
  it('keeps actual errors and retry visible without exposing secrets', async () => {
    vi.mocked(api.status).mockResolvedValue(state({ phase: 'error', message: '本次授权失败，请重试。' }))
    create(); await settle()
    expect(dom.get('collaboration-detail').hidden).toBe(false); expect(dom.get('collaboration-detail').textContent).toContain('失败')
    expect(dom.get('collaboration-status').hidden).toBe(false); expect(dom.get('collaboration-status').disabled).toBe(false)
    expect(api.startLogin).not.toHaveBeenCalled()
  })
})

describe('read-only project discovery stays independent of local history', () => {
  it('does not fetch project metadata automatically after a signed-in event', async () => {
    create(); await settle(); receive(signedIn())
    expect(api.projects).not.toHaveBeenCalled(); await click('projects')
    expect(api.projects).toHaveBeenCalledOnce(); expect(child(child(dom.get('collaboration-project-list'), 0), 0).textContent).toBe('fixture-user/synthetic-paper')
  })
  it('renders project names as text, not links or HTML', async () => {
    vi.mocked(api.projects).mockResolvedValue([{ ...project, name: '<img src=x>' }])
    create(); await settle(); receive(signedIn()); await click('projects')
    const name = child(child(dom.get('collaboration-project-list'), 0), 0)
    expect(name.textContent).toBe('fixture-user/<img src=x>'); expect(name).not.toHaveProperty('innerHTML')
  })
  it('clears account metadata and old project names immediately on device logout', async () => {
    create(); await settle(); receive(signedIn()); await click('projects'); await click('logout')
    expect(dom.get('collaboration-state').textContent).toBe('未登录')
    expect(child(dom.get('collaboration-project-list'), 0).textContent).not.toContain('synthetic-paper')
    expect(dom.get('collaboration-code').textContent).toBe('')
  })
})

describe('settled cancellation and stale rejected requests', () => {
  it('recovers Main through a fresh user status request without accepting an old login failure', async () => {
    let rejectLogin!: (error: Error) => void
    vi.mocked(api.startLogin).mockReturnValue(new Promise<CollaborationState>((_resolve, reject) => { rejectLogin = reject }))
    vi.mocked(api.cancelLogin).mockResolvedValue(signedIn())
    const panel = create(); await settle(); await click('login'); receive(authorizing()); await click('cancel')
    expect(panel.model.account).toBeNull(); vi.mocked(api.status).mockResolvedValue(signedIn())
    await click('status'); expect(panel.model.account?.id).toBe(7)
    rejectLogin(new Error('obsolete synthetic login failure')); await settle()
    expect(dom.get('collaboration-error').textContent).toBe('')
    expect(dom.get('collaboration-state').textContent).toBe('fixture-user')
    expect(dom.get('collaboration-projects').disabled).toBe(false)
  })
  it('does not publish a queued old failure over a newer state after close cancellation', async () => {
    let rejectStatus!: (error: Error) => void
    vi.mocked(api.status).mockReturnValue(new Promise<CollaborationState>((_resolve, reject) => { rejectStatus = reject }))
    const panel = create(); panel.setClosing(true)
    rejectStatus(new Error('obsolete synthetic status failure')); await settle()
    expect(dom.get('collaboration-error').textContent).toBe('')
    receive(state({ phase: 'unconfigured' })); panel.setClosing(false)
    expect(dom.get('collaboration-error').textContent).toBe('')
    expect(dom.get('collaboration-state').textContent).toContain('未配置')
  })
})

describe('close cancellation queues state and metadata, not new actions', () => {
  it('blocks actions and withholds a late prompt until a valid thaw', async () => {
    const panel = create(); await settle(); const before = dom.get('collaboration-state').textContent
    panel.setClosing(true); receive(authorizing()); await click('login'); await click('verify'); await click('status')
    expect(dom.get('collaboration-state').textContent).toBe(before); expect(dom.get('collaboration-code').textContent).toBe('')
    expect(api.startLogin).not.toHaveBeenCalled(); expect(api.status).toHaveBeenCalledOnce()
    panel.setClosing(false); expect(dom.get('collaboration-code').textContent).toBe('ABCD-EFGH')
    expect(api.openVerification).not.toHaveBeenCalled()
  })
  it('withholds a project reply while closing and drops it after a queued sign-out', async () => {
    const pending = deferred<CloudProject[]>(); vi.mocked(api.projects).mockReturnValue(pending.promise)
    const panel = create(); await settle(); receive(signedIn()); await click('projects')
    panel.setClosing(true); pending.resolve([project]); await settle()
    expect(panel.model.projects).toEqual([]); receive(state()); panel.setClosing(false)
    expect(panel.model.projects).toEqual([]); expect(dom.get('collaboration-projects').disabled).toBe(true)
  })
  it('does not reveal an expired prompt or start a new login after closing is canceled', async () => {
    const panel = create(); await settle(); await click('login'); panel.setClosing(true)
    now = 11000; vi.advanceTimersByTime(1000); panel.setClosing(false)
    expect(dom.get('collaboration-code').textContent).toBe(''); expect(api.startLogin).toHaveBeenCalledOnce()
  })
  it('disposes listeners, timers and sensitive UI without network cleanup calls', async () => {
    const panel = create(); await settle(); await click('login'); panel.dispose(); panels.splice(panels.indexOf(panel), 1)
    vi.advanceTimersByTime(2000); expect(dom.get('collaboration-code').textContent).toBe('')
    expect(api.cancelLogin).not.toHaveBeenCalled(); expect(api.logout).not.toHaveBeenCalled()
  })
})
