/// <reference lib="dom" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CollaborationState } from '../src/shared/collaboration-contracts'

interface NodeMock {
  open: boolean; disabled: boolean; hidden: boolean; textContent: string; returnValue: string
  handlers: Map<string, (event: Event) => void>
  showModal: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>
  addEventListener(type: string, listener: (event: Event) => void): void
}
const dom = vi.hoisted(() => {
  const nodes = new Map<string, NodeMock>(), buttons = new Map<string, () => void>()
  const get = (id: string): NodeMock => {
    if (!nodes.has(id)) {
      const node: NodeMock = { open: false, disabled: false, hidden: false, textContent: '', returnValue: '', handlers: new Map(),
        showModal: vi.fn(), close: vi.fn(), addEventListener(type, listener) { this.handlers.set(type, listener) } }
      node.showModal.mockImplementation(() => { node.open = true })
      node.close.mockImplementation((reason = '') => { node.open = false; node.returnValue = reason; node.handlers.get('close')?.(new Event('close')) })
      nodes.set(id, node)
    }
    return nodes.get(id)!
  }
  return { nodes, buttons, get }
})
vi.mock('../src/renderer/dom', () => ({ element: dom.get, text: (id: string, value: string) => { dom.get(id).textContent = value },
  button: (id: string, handler: () => void) => dom.buttons.set(id, handler) }))
import { CollaborationModel } from '../src/renderer/collaboration-model'
import { StartupDialog } from '../src/renderer/startup-dialog'
const state = (extra: Partial<CollaborationState> = {}): CollaborationState => ({ phase: 'signed-out', message: '',
  account: null, authorization: null, expiresAt: null, sessionOnly: true, ...extra })
const signedIn = () => state({ phase: 'signed-in', account: { id: 7, login: 'fixture-user', name: null }, expiresAt: 100000 })
let model: CollaborationModel, login: Mock<() => void>, dialog: StartupDialog
const click = (id: string) => dom.buttons.get(id)!()
const modal = () => dom.get('startup-dialog')
beforeEach(() => { dom.nodes.clear(); dom.buttons.clear(); model = new CollaborationModel(true, () => 1000); login = vi.fn() })
afterEach(() => dialog?.dispose())
function create(): StartupDialog { dialog = new StartupDialog(model, login); return dialog }

describe('startup login or offline choice', () => {
  it('shows once immediately without waiting for account status, but never starts login', () => {
    create().open(); dialog.open(); dialog.update()
    expect(modal().showModal).toHaveBeenCalledOnce(); expect(modal().open).toBe(true)
    expect(dom.get('startup-login').disabled).toBe(true); expect(dom.get('startup-offline').disabled).toBe(false)
    expect(dom.get('startup-status').textContent).toBe('正在连接 GitHub…')
    expect(dom.get('startup-status').hidden).toBe(false); expect(login).not.toHaveBeenCalled()
  })
  it('lets offline dismiss pending status and never reopens after a late state or error', () => {
    create().open(); click('startup-offline')
    expect(modal().returnValue).toBe('offline'); expect(modal().open).toBe(false)
    model.receive(state()); dialog.update(); model.receive(state({ phase: 'error' })); dialog.update(); dialog.open()
    expect(modal().showModal).toHaveBeenCalledOnce(); expect(login).not.toHaveBeenCalled()
    expect(model.allowed('login')).toBe(true) // Later manual login remains available.
  })
  it('treats Escape as offline without authorizing or reopening', () => {
    create().open(); const cancel = new Event('cancel', { cancelable: true })
    modal().handlers.get('cancel')!(cancel); dialog.open()
    expect(cancel.defaultPrevented).toBe(true); expect(modal().returnValue).toBe('offline')
    expect(modal().showModal).toHaveBeenCalledOnce(); expect(login).not.toHaveBeenCalled()
  })
  it.each([false, true])('keeps offline available when the bridge is missing or unconfigured (%s)', available => {
    model = new CollaborationModel(available, () => 1000)
    if (available) model.receive(state({ phase: 'unconfigured' }))
    create().open(); click('startup-login')
    expect(dom.get('startup-login').disabled).toBe(true); expect(modal().open).toBe(true)
    click('startup-offline'); expect(modal().open).toBe(false); expect(login).not.toHaveBeenCalled()
  })
  it('uses no ready-state instruction and only shows status for actual pending or unavailable states', () => {
    model.receive(state()); create().open()
    expect(dom.get('startup-status').textContent).toBe(''); expect(dom.get('startup-status').hidden).toBe(true)
    model.receive(state({ phase: 'error' })); dialog.update()
    expect(dom.get('startup-status').textContent).toBe('暂时无法登录'); expect(dom.get('startup-status').hidden).toBe(false)
    model.receive(state()); dialog.update(); expect(dom.get('startup-status').hidden).toBe(true)
    expect(login).not.toHaveBeenCalled()
  })
  it('starts the existing flow exactly once only after an explicit allowed login choice', () => {
    model.receive(state()); create().open()
    login.mockImplementation(() => expect(modal().open).toBe(false))
    expect(dom.get('startup-login').disabled).toBe(false)
    click('startup-login'); click('startup-login'); click('startup-offline'); dialog.open()
    expect(modal().returnValue).toBe('login'); expect(login).toHaveBeenCalledOnce()
    expect(modal().showModal).toHaveBeenCalledOnce()
  })
  it('rechecks permission at click time instead of trusting a previously enabled button', () => {
    model.receive(state()); create().open(); model.receive(state({ phase: 'unconfigured' }))
    click('startup-login'); expect(login).not.toHaveBeenCalled(); expect(modal().open).toBe(true)
  })
  it('does not interrupt an already signed-in renderer', () => {
    model.receive(signedIn()); create().open(); expect(modal().showModal).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
  })
  it('dismisses if an existing session arrives while the choice is open', () => {
    create().open(); model.receive(signedIn()); dialog.update(); dialog.open()
    expect(modal().open).toBe(false); expect(modal().returnValue).toBe('signed-in')
    expect(modal().showModal).toHaveBeenCalledOnce(); expect(login).not.toHaveBeenCalled()
  })
  it('freezes both choices and Escape during close handshake, then restores on cancellation', () => {
    model.receive(state()); create().open(); dialog.setClosing(true)
    expect(dom.get('startup-login').disabled).toBe(true); expect(dom.get('startup-offline').disabled).toBe(true)
    click('startup-login'); click('startup-offline'); modal().handlers.get('cancel')!(new Event('cancel', { cancelable: true }))
    expect(modal().open).toBe(true); expect(login).not.toHaveBeenCalled()
    dialog.setClosing(false); expect(dom.get('startup-offline').disabled).toBe(false)
    click('startup-offline'); expect(modal().open).toBe(false)
  })
  it('ignores queued clicks and status after disposal', () => {
    model.receive(state()); create().open(); dialog.dispose(); click('startup-login'); dialog.update(); dialog.open()
    expect(modal().open).toBe(false); expect(login).not.toHaveBeenCalled(); expect(modal().showModal).toHaveBeenCalledOnce()
  })
  it('keeps an accessible native dialog, visible offline choice and no implicit form authorization', () => {
    const html = readFileSync('src/renderer/index.html', 'utf8')
    const markup = html.slice(html.indexOf('<dialog id="startup-dialog"'), html.indexOf('<dialog id="setup-dialog"'))
    expect(markup).toContain('aria-labelledby="startup-title"'); expect(markup).toContain('aria-describedby="startup-status"')
    expect(markup).toContain('id="startup-title">LatexStudio</h2>')
    expect(markup).toContain('id="startup-login" disabled>GitHub登录</button>')
    expect(markup).toContain('id="startup-offline" class="secondary" autofocus'); expect(markup).not.toContain('<form')
    expect(markup).not.toMatch(/startup-brand|startup-note|startup-description|开始写作|选择登录后才/)
  })
})
