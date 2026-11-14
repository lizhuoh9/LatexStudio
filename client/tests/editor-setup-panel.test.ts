/// <reference lib="dom" />
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TexSetupApi, TexSetupState } from '../src/shared/tex-setup-contracts'

interface NodeMock {
  disabled: boolean; hidden: boolean; open: boolean; max: number; value: number
  setAttribute: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>
  showModal: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>
}
const dom = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), nodes: new Map<string, NodeMock>(), text: vi.fn() }))
vi.mock('../src/renderer/dom', () => ({
  button: (id: string, handler: () => void) => dom.handlers.set(id, handler), text: dom.text,
  element: (id: string) => {
    if (!dom.nodes.has(id)) dom.nodes.set(id, { disabled: false, hidden: false, open: false, max: 0, value: 0,
      setAttribute: vi.fn(), removeAttribute: vi.fn(), showModal: vi.fn(), close: vi.fn() })
    return dom.nodes.get(id)
  }
}))
import { SetupPanel } from '../src/renderer/setup-panel'
const state = (extra: Partial<TexSetupState> = {}): TexSetupState => ({ phase: 'required', message: 'synthetic fixture',
  completed: 0, total: 0, supported: true, compileVerified: false, ...extra })
let api: TexSetupApi
let receive: (state: TexSetupState) => void
beforeEach(() => {
  dom.handlers.clear(); dom.nodes.clear(); dom.text.mockClear()
  api = { status: vi.fn().mockResolvedValue(state()), prepare: vi.fn().mockResolvedValue(state({ phase: 'prepared' })),
    cancel: vi.fn().mockResolvedValue(state()), onState: vi.fn((listener) => { receive = listener; return () => {} }) }
})
async function settle(): Promise<void> { for (let i = 0; i < 4; i += 1) await Promise.resolve() }

describe('optional graphical preparation bridge', () => {
  it('handles legacy preload without setup APIs and makes no implicit request', async () => {
    const panel = new SetupPanel(undefined, vi.fn()); panel.initialize()
    dom.handlers.get('setup-prepare')!(); await settle()
    expect(panel.verified).toBe(false); expect(panel.summary).toBe('编译组件服务不可用')
    expect(dom.nodes.get('setup-prepare')!.disabled).toBe(true)
  })
  it('only queries status on initialization, never prepares automatically', async () => {
    const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
    expect(api.status).toHaveBeenCalledOnce(); expect(api.prepare).not.toHaveBeenCalled()
    expect(dom.nodes.get('setup-prepare')!.disabled).toBe(false)
  })
  it('shows prepared but not verified after an explicit fixture resource request', async () => {
    const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
    dom.handlers.get('setup-prepare')!(); await settle()
    expect(api.prepare).toHaveBeenCalledOnce(); expect(panel.verified).toBe(false)
    expect(panel.summary).toBe('编译组件尚未通过验证')
  })
  it('retains real state on a request failure instead of inventing a prepared phase', async () => {
    vi.mocked(api.prepare).mockRejectedValue(new Error('synthetic preparation failure'))
    const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
    dom.handlers.get('setup-prepare')!(); await settle()
    expect(panel.model.state?.phase).toBe('required'); expect(panel.model.error).toContain('preparation failure')
    expect(dom.nodes.get('setup-prepare')!.disabled).toBe(false)
  })
})

it('reports real bundled-component progress without presenting download or disk decisions', async () => {
  const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
  receive(state({ phase: 'extracting', completed: 5, total: 10 }))
  expect(dom.text).toHaveBeenCalledWith('setup-progress-label', '50% · 5 / 10')
  expect(dom.nodes.has('setup-space')).toBe(false)
  expect(dom.nodes.get('setup-prepare')!.hidden).toBe(true)
  expect(dom.nodes.get('setup-cancel')!.hidden).toBe(false)
  expect(panel.verified).toBe(false); expect(api.prepare).not.toHaveBeenCalled()
})

it('does not present an indeterminate startup check as configuring or invent a percentage', async () => {
  const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle(); dom.text.mockClear()
  receive(state({ phase: 'checking', total: 0 }))
  expect(dom.text).toHaveBeenCalledWith('setup-progress-label', '正在后台校验，可先编辑论文…')
  expect(dom.nodes.get('setup-progress')!.removeAttribute).toHaveBeenCalledWith('value')
  expect(panel.verified).toBe(false); expect(api.prepare).not.toHaveBeenCalled()
  expect(dom.nodes.get('setup-prepare')!.hidden).toBe(true)
})
it('shows retry only for supported incomplete states and never calls prepare on a ready event', async () => {
  const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
  expect(dom.nodes.get('setup-prepare')!.hidden).toBe(false)
  receive(state({ phase: 'prepared', compileVerified: true }))
  expect(dom.nodes.get('setup-prepare')!.hidden).toBe(true)
  expect(dom.nodes.get('setup-cancel')!.hidden).toBe(true); expect(panel.verified).toBe(true)
  expect(dom.nodes.get('setup-progress')!.hidden).toBe(true)
  receive(state({ phase: 'error', supported: false }))
  expect(panel.summary).toBe('当前系统暂不支持编译')
  expect(dom.nodes.get('setup-prepare')!.disabled).toBe(true)
  expect(dom.nodes.get('setup-prepare')!.hidden).toBe(true)
  expect(api.prepare).not.toHaveBeenCalled()
})

describe('setup controls preserve close-input gating', () => {
  it('blocks requests and opening the modal while closing, including after late state', async () => {
    const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
    panel.setClosing(true); receive(state({ phase: 'error' }))
    dom.handlers.get('setup-prepare')!(); dom.handlers.get('setup-refresh')!(); dom.handlers.get('setup-open')!()
    await settle(); expect(api.prepare).not.toHaveBeenCalled(); expect(api.status).toHaveBeenCalledOnce()
    expect(dom.nodes.get('setup-prepare')!.disabled).toBe(true)
    expect(dom.nodes.has('setup-dialog')).toBe(false)
  })
  it('restores controls without restarting preparation when close is canceled', async () => {
    const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
    panel.setClosing(true); panel.setClosing(false); await settle()
    expect(dom.nodes.get('setup-prepare')!.disabled).toBe(false); expect(api.prepare).not.toHaveBeenCalled()
  })
  it('updates progress with text and attributes rather than injecting markup', async () => {
    const panel = new SetupPanel(api, vi.fn()); panel.initialize(); await settle()
    receive(state({ phase: 'downloading', completed: 5, total: 10, message: '<img src=x onerror=evil()>' }))
    expect(dom.nodes.get('setup-progress')!.value).toBe(5)
    expect(dom.text).toHaveBeenCalledWith('setup-detail', expect.stringContaining('<img'))
    expect(dom.nodes.get('setup-progress')!.setAttribute).toHaveBeenCalledWith('aria-valuetext', expect.stringContaining('50%'))
  })
})
