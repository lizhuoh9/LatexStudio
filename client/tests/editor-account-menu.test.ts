/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CollaborationState } from '../src/shared/collaboration-contracts'
const fixture = vi.hoisted(() => {
  const nodes = new Map<string, ReturnType<typeof node>>(), actions = new Map<string, () => void>()
  const documentHandlers = new Map<string, EventListener>()
  function node() {
    const classes = new Set<string>(), attributes = new Map<string, string>()
    return { textContent: '', title: '', open: false, focus: vi.fn(), attributes, classes,
      handlers: new Map<string, EventListener>(),
      classList: { toggle(name: string, force: boolean) { if (force) classes.add(name); else classes.delete(name) } },
      setAttribute(name: string, value: string) { attributes.set(name, value) },
      addEventListener(name: string, handler: EventListener) { this.handlers.set(name, handler) },
      removeEventListener(name: string) { this.handlers.delete(name) }, contains(value: unknown) { return value === this } }
  }
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id)! }
  return { nodes, actions, get, documentHandlers }
})
vi.mock('../src/renderer/dom', () => ({ element: fixture.get,
  text: (id: string, value: string) => { fixture.get(id).textContent = value },
  button: (id: string, handler: () => void) => fixture.actions.set(id, handler) }))
vi.mock('../src/renderer/account-avatar', () => ({ AccountAvatar: class {
  update(id: number | null) { fixture.get('account-avatar').attributes.set('fixture-account-id', String(id)) }
  setClosing() {} dispose() {}
} }))
import { CollaborationModel } from '../src/renderer/collaboration-model'
import { AccountMenu } from '../src/renderer/account-menu'
const state = (extra: Partial<CollaborationState> = {}): CollaborationState => ({ phase: 'signed-out', message: '',
  account: null, authorization: null, expiresAt: null, sessionOnly: true, ...extra })
let model: CollaborationModel, menu: AccountMenu, open: Mock<() => void>
beforeEach(() => {
  fixture.nodes.clear(); fixture.actions.clear(); fixture.documentHandlers.clear()
  vi.stubGlobal('document', { addEventListener: (name: string, fn: EventListener) => fixture.documentHandlers.set(name, fn),
    removeEventListener: (name: string) => fixture.documentHandlers.delete(name) })
  model = new CollaborationModel(true, () => 1000); open = vi.fn(); menu = new AccountMenu(model, open)
})
afterEach(() => { menu.dispose(); vi.unstubAllGlobals() })

describe('top-right account identity and settings', () => {
  it('shows a guest avatar without authorizing or opening settings during construction/update', () => {
    menu.update(); expect(fixture.get('account-label').textContent).toBe('未登录')
    expect(fixture.get('account-avatar').classes.has('is-guest')).toBe(true)
    expect(open).not.toHaveBeenCalled(); expect(model.state).toBeNull()
  })
  it('shows authenticated identity initials and accessible account name, reverting on logout', () => {
    model.receive(state({ phase: 'signed-in', account: { id: 7, login: 'fixture-user', name: '李卓' }, expiresAt: 100000 }))
    menu.update(); expect(fixture.get('account-initial').textContent).toBe('李')
    expect(fixture.get('account-avatar').attributes.get('fixture-account-id')).toBe('7')
    expect(fixture.get('account-label').textContent).toBe('fixture-user')
    expect(fixture.get('account-toggle').attributes.get('aria-label')).toContain('已登录 李卓')
    expect(fixture.get('account-menu').classes.has('is-signed-in')).toBe(true)
    model.receive(state()); menu.update()
    expect(fixture.get('account-initial').textContent).toBe(''); expect(fixture.get('account-avatar').classes.has('is-guest')).toBe(true)
    expect(fixture.get('account-avatar').attributes.get('fixture-account-id')).toBe('null')
  })
  it('does not treat an expired or invalid account as signed in', () => {
    model.receive(state({ phase: 'signed-in', account: { id: 7, login: 'fixture-user', name: null }, expiresAt: 500 }))
    menu.update(); expect(fixture.get('account-label').textContent).toBe('未登录')
  })
  it('opens settings only on explicit click, closes the menu and respects close/disposal guards', () => {
    fixture.get('account-menu').open = true; fixture.actions.get('account-settings')!()
    expect(open).toHaveBeenCalledOnce(); expect(fixture.get('account-menu').open).toBe(false)
    menu.setClosing(true); fixture.actions.get('account-settings')!(); expect(open).toHaveBeenCalledOnce()
    menu.setClosing(false); menu.dispose(); fixture.actions.get('account-settings')!(); expect(open).toHaveBeenCalledOnce()
  })
  it('closes on outside pointer/Escape and preserves native keyboard focus', () => {
    fixture.get('account-menu').open = true; fixture.documentHandlers.get('pointerdown')!(new Event('pointerdown'))
    expect(fixture.get('account-menu').open).toBe(false)
    fixture.get('account-menu').open = true
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })
    fixture.get('account-menu').handlers.get('keydown')!(event)
    expect(event.defaultPrevented).toBe(true); expect(fixture.get('account-toggle').focus).toHaveBeenCalledOnce()
  })
  it('keeps account names as text rather than interpolating untrusted HTML into the avatar', () => {
    model.receive(state({ phase: 'signed-in', account: { id: 7, login: 'fixture-user', name: '<img onerror=evil>' }, expiresAt: 100000 }))
    menu.update(); expect(fixture.get('account-name').textContent).toBe('<img onerror=evil>')
    expect(fixture.get('account-initial').textContent).toBe('<')
    menu.dispose(); expect(fixture.documentHandlers.size).toBe(0)
  })
})
