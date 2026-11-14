/// <reference lib="dom" />
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryTransferState } from '../src/shared/workspace-contracts'

// Source definitions only: this fixture has not been executed by its owner.
interface NodeMock { disabled: boolean; hidden: boolean; setAttribute: ReturnType<typeof vi.fn> }
const dom = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), nodes: new Map<string, NodeMock>(), text: vi.fn() }))
vi.mock('../src/renderer/dom', () => ({
  button: (id: string, handler: () => void) => dom.handlers.set(id, handler), text: dom.text,
  element: (id: string) => {
    if (!dom.nodes.has(id)) dom.nodes.set(id, { disabled: false, hidden: false, setAttribute: vi.fn() })
    return dom.nodes.get(id)
  }
}))
import { RepositoryTransferPanel, type RepositoryTransferBridge } from '../src/renderer/repository-transfer-panel'
const state = (sequence = 1, phase: RepositoryTransferState['phase'] = 'running'): RepositoryTransferState => ({
  sequence, phase, kind: phase === 'idle' ? null : 'sync', message: 'provider-secret-fixture'
})
let api: Required<RepositoryTransferBridge>
beforeEach(() => {
  dom.handlers.clear(); dom.nodes.clear(); dom.text.mockClear()
  api = { repositoryTransfer: vi.fn().mockResolvedValue(state(0, 'idle')),
    cancelRepositoryTransfer: vi.fn().mockResolvedValue(state(1, 'settled')) }
})
async function settle(): Promise<void> { for (let i = 0; i < 6; i += 1) await Promise.resolve() }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('optional transfer bridge initialization', () => {
  it('does not call a partial old bridge or invent running state', async () => {
    const panel = new RepositoryTransferPanel({ repositoryTransfer: api.repositoryTransfer })
    panel.initialize(); dom.handlers.get('repository-transfer-cancel')!(); await settle()
    expect(api.repositoryTransfer).not.toHaveBeenCalled(); expect(api.cancelRepositoryTransfer).not.toHaveBeenCalled()
    expect(panel.model.state).toBeNull(); expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(true)
  })
  it('only queries cached status once and never cancels at startup', async () => {
    const panel = new RepositoryTransferPanel(api); panel.initialize(); panel.initialize(); await settle()
    expect(api.repositoryTransfer).toHaveBeenCalledOnce(); expect(api.cancelRepositoryTransfer).not.toHaveBeenCalled()
    expect(vi.mocked(api.repositoryTransfer).mock.calls[0]).toEqual([])
    expect(panel.model.state?.phase).toBe('idle')
  })
  it('ignores a stale initial reply after receiving a running event', async () => {
    const pending = deferred<RepositoryTransferState>(); vi.mocked(api.repositoryTransfer).mockReturnValue(pending.promise)
    const panel = new RepositoryTransferPanel(api); panel.initialize(); panel.receive(state(5))
    pending.resolve(state(0, 'idle')); await settle()
    expect(panel.model.state?.sequence).toBe(5); expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(false)
  })
})

describe('independent no-payload cancellation', () => {
  it('can cancel while another cached state request is still pending', async () => {
    const query = deferred<RepositoryTransferState>(); const cancel = deferred<RepositoryTransferState>()
    vi.mocked(api.repositoryTransfer).mockReturnValue(query.promise); vi.mocked(api.cancelRepositoryTransfer).mockReturnValue(cancel.promise)
    const panel = new RepositoryTransferPanel(api); panel.initialize(); panel.receive(state())
    dom.handlers.get('repository-transfer-cancel')!()
    expect(panel.model.state?.phase).toBe('running'); expect(panel.model.requesting).toBe(true)
    expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(true)
    expect(vi.mocked(api.cancelRepositoryTransfer).mock.calls).toEqual([[]])
    dom.handlers.get('repository-transfer-cancel')!(); expect(api.cancelRepositoryTransfer).toHaveBeenCalledOnce()
    cancel.resolve(state(1, 'settled')); query.resolve(state(0, 'idle')); await settle()
    expect(panel.model.state?.phase).toBe('settled')
    expect(panel.model.summary).toContain('不代表成功、连接清理已确认或修改已撤回')
  })
  it('keeps request uncertainty instead of echoing a provider exception or undoing phase', async () => {
    vi.mocked(api.cancelRepositoryTransfer).mockRejectedValue(new Error('provider-secret-fixture'))
    const panel = new RepositoryTransferPanel(api); panel.receive(state())
    dom.handlers.get('repository-transfer-cancel')!(); await settle()
    expect(panel.model.state?.phase).toBe('running'); expect(panel.model.error).toContain('尚未确认')
    expect(panel.model.requesting).toBe(false); expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(false)
    expect(JSON.stringify(dom.text.mock.calls)).not.toContain('provider-secret-fixture')
  })
  it('does not let an old cancellation callback remove a new operation control', async () => {
    const old = deferred<RepositoryTransferState>(); const fresh = deferred<RepositoryTransferState>()
    vi.mocked(api.cancelRepositoryTransfer).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const panel = new RepositoryTransferPanel(api); panel.receive(state()); dom.handlers.get('repository-transfer-cancel')!()
    panel.receive(state(2)); dom.handlers.get('repository-transfer-cancel')!()
    old.resolve(state(1, 'settled')); await settle(); expect(panel.model.state?.sequence).toBe(2)
    expect(panel.model.state?.phase).toBe('running'); expect(panel.model.requesting).toBe(true)
    fresh.resolve(state(2, 'settled')); await settle()
    expect(panel.model.state?.phase).toBe('settled')
  })
})

describe('close and disposal do not publish or restart work', () => {
  it('freezes controls and snapshot until explicit close cancellation, without auto requests', async () => {
    const panel = new RepositoryTransferPanel(api); panel.initialize(); await settle(); panel.receive(state())
    const before = panel.model.state; panel.setClosing(true); panel.receive(state(1, 'settled'))
    dom.handlers.get('repository-transfer-cancel')!(); dom.handlers.get('repository-transfer-status')!()
    expect(panel.model.state).toBe(before); expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(true)
    expect(api.cancelRepositoryTransfer).not.toHaveBeenCalled(); expect(api.repositoryTransfer).toHaveBeenCalledOnce()
    panel.setClosing(false); expect(panel.model.state?.phase).toBe('settled')
    expect(api.cancelRepositoryTransfer).not.toHaveBeenCalled(); expect(api.repositoryTransfer).toHaveBeenCalledOnce()
  })
  it('holds a late query result during close and does not query again on thaw', async () => {
    const pending = deferred<RepositoryTransferState>(); vi.mocked(api.repositoryTransfer).mockReturnValue(pending.promise)
    const panel = new RepositoryTransferPanel(api); panel.initialize(); panel.setClosing(true)
    pending.resolve(state()); await settle(); expect(panel.model.state).toBeNull()
    panel.setClosing(false); expect(panel.model.state?.phase).toBe('running')
    expect(api.repositoryTransfer).toHaveBeenCalledOnce(); expect(api.cancelRepositoryTransfer).not.toHaveBeenCalled()
  })
  it('drops queued failure text if a newer state settles before thaw', async () => {
    const pending = deferred<RepositoryTransferState>(); vi.mocked(api.cancelRepositoryTransfer).mockReturnValue(pending.promise)
    const panel = new RepositoryTransferPanel(api); panel.receive(state()); dom.handlers.get('repository-transfer-cancel')!()
    panel.setClosing(true); pending.reject(new Error('provider-secret-fixture')); await settle()
    expect(panel.model.error).toBe(''); panel.receive(state(1, 'settled')); panel.setClosing(false)
    expect(panel.model.error).toBe(''); expect(panel.model.state?.phase).toBe('settled')
    expect(JSON.stringify(dom.text.mock.calls)).not.toContain('provider-secret-fixture')
  })
})

it('recovers from a close-time rejection without automatic retry or invented Main phase', async () => {
  const pending = deferred<RepositoryTransferState>()
  vi.mocked(api.cancelRepositoryTransfer).mockReturnValueOnce(pending.promise)
  vi.mocked(api.repositoryTransfer).mockResolvedValue(state())
  const panel = new RepositoryTransferPanel(api); panel.receive(state())
  dom.handlers.get('repository-transfer-cancel')!(); panel.setClosing(true)
  pending.reject(new Error('synthetic Main closing rejection')); await settle()
  expect(panel.model.state?.phase).toBe('running'); expect(panel.model.requesting).toBe(true)
  expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(true)
  panel.setClosing(false); expect(panel.model.requesting).toBe(false)
  expect(dom.nodes.get('repository-transfer-cancel')!.disabled).toBe(false)
  expect(api.cancelRepositoryTransfer).toHaveBeenCalledOnce()
  dom.handlers.get('repository-transfer-status')!(); await settle()
  expect(panel.model.state?.phase).toBe('running'); expect(api.cancelRepositoryTransfer).toHaveBeenCalledOnce()
  dom.handlers.get('repository-transfer-cancel')!(); await settle()
  expect(api.cancelRepositoryTransfer).toHaveBeenCalledTimes(2); expect(panel.model.state?.phase).toBe('settled')
})

it('disposes without canceling, and suppresses late publication', async () => {
  const pending = deferred<RepositoryTransferState>(); vi.mocked(api.repositoryTransfer).mockReturnValue(pending.promise)
  const panel = new RepositoryTransferPanel(api); panel.initialize(); panel.dispose(); dom.text.mockClear()
  pending.resolve(state()); panel.receive(state(2)); await settle()
  expect(dom.text).not.toHaveBeenCalled(); expect(api.cancelRepositoryTransfer).not.toHaveBeenCalled()
})
