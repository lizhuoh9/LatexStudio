import { describe, expect, it } from 'vitest'
import type { RepositoryTransferState } from '../src/shared/workspace-contracts'
import { RepositoryTransferModel } from '../src/renderer/repository-transfer-model'

// Definitions only. No owner-run typecheck, test, browser or application evidence.
const state = (sequence = 1, phase: RepositoryTransferState['phase'] = 'running',
  kind: RepositoryTransferState['kind'] = 'sync'): RepositoryTransferState => ({
  sequence, phase, kind, message: 'untrusted provider-secret-fixture'
})

describe('transfer capability and truthful state', () => {
  it('does not infer idle or start anything from construction', () => {
    const model = new RepositoryTransferModel(true)
    expect(model.state).toBeNull(); expect(model.begin('cancel')).toBeNull()
    expect(model.begin('status')).not.toBeNull(); expect(model.state).toBeNull()
  })
  it('never enables a compatibility cancel when the bridge is unavailable', () => {
    const model = new RepositoryTransferModel(false); model.receive(state())
    expect(model.allowed('cancel')).toBe(false); expect(model.allowed('status')).toBe(false)
    expect(model.summary).toContain('未接入取消')
  })
  it('never copies provider strings into published snapshots', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    expect(model.state?.message).not.toContain('provider-secret-fixture')
    expect(model.summary).toContain('同步正在进行')
  })
  it('rejects malformed sequence, phase and active kind without fabricating state', () => {
    const model = new RepositoryTransferModel(true)
    for (const value of [state(-1), state(NaN), state(1.5), state(1, 'running', 'invalid' as RepositoryTransferState['kind']),
      state(1, 'invalid' as RepositoryTransferState['phase'])]) expect(model.receive(value)).toBe(false)
    expect(model.state).toBeNull()
  })
})

describe('monotonic sequence and same-operation phase', () => {
  it('cannot roll a confirmed Main cancellation phase back to running', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    expect(model.begin('cancel')).not.toBeNull(); expect(model.state?.phase).toBe('running')
    expect(model.requesting).toBe(true); expect(model.allowed('cancel')).toBe(false)
    model.receive(state(1, 'cancelling'))
    expect(model.receive(state())).toBe(false); expect(model.allowed('cancel')).toBe(false)
  })
  it('cannot revive a settled operation with running or cancelling', () => {
    const model = new RepositoryTransferModel(true); model.receive(state(4, 'settled'))
    expect(model.receive(state(4))).toBe(false); expect(model.receive(state(4, 'cancelling'))).toBe(false)
    expect(model.summary).toContain('不代表成功、连接清理已确认或修改已撤回')
    expect(model.allowed('cancel')).toBe(false)
  })
  it('ignores older IDs even if their phase is further ahead', () => {
    const model = new RepositoryTransferModel(true); model.receive(state(9))
    expect(model.receive(state(8, 'settled'))).toBe(false); expect(model.state?.sequence).toBe(9)
  })
  it('permits a genuinely newer operation after the previous one settled', () => {
    const model = new RepositoryTransferModel(true); model.receive(state(4, 'settled'))
    expect(model.receive(state(5, 'running', 'clone'))).toBe(true)
    expect(model.allowed('cancel')).toBe(true); expect(model.summary).toContain('下载项目')
  })
  it('remembers the operation kind even when a settled snapshot clears kind', () => {
    const model = new RepositoryTransferModel(true); model.receive(state(3, 'running', 'connect'))
    expect(model.receive(state(3, 'settled', null))).toBe(true)
    expect(model.receive(state(3, 'settled', 'clone'))).toBe(false)
  })
})

describe('operation-bound cancellation replies', () => {
  it('accepts a terminal reply after that operation emitted progress', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!; model.receive(state(1, 'cancelling'))
    expect(model.respond(ticket, state(1, 'settled'))).toBe(true)
    expect(model.state?.phase).toBe('settled')
  })
  it('does not adopt a different operation from an old cancellation reply', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!
    expect(model.respond(ticket, state(2))).toBe(false); expect(model.state?.sequence).toBe(1)
  })
  it('does not roll back a confirmed Main phase through its own response', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!; model.receive(state(1, 'cancelling'))
    expect(model.respond(ticket, state())).toBe(false); expect(model.state?.phase).toBe('cancelling')
  })
  it('lets a new operation cancel while the old reply remains pending', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const old = model.begin('cancel')!; model.receive(state(2))
    const fresh = model.begin('cancel')!; model.finish(old)
    expect(model.respond(old, state(1, 'settled'))).toBe(false)
    expect(model.respond(fresh, state(2, 'settled'))).toBe(true)
  })
})

describe('stale queries and failures', () => {
  it('ignores the initial query after a newer event and user cancellation', () => {
    const model = new RepositoryTransferModel(true); const initial = model.begin('status')!
    model.receive(state()); model.begin('cancel')
    expect(model.respond(initial, state(0, 'idle', null))).toBe(false)
    expect(model.fail(initial)).toBe(false); expect(model.state?.phase).toBe('running')
    expect(model.requesting).toBe(true); expect(model.allowed('cancel')).toBe(false)
  })
  it('does not let an obsolete finalizer delete a fresh query ticket', () => {
    const model = new RepositoryTransferModel(true); const old = model.begin('status')!
    model.receive(state()); const fresh = model.begin('status')!; model.finish(old)
    expect(model.respond(old, state(0, 'idle', null))).toBe(false)
    expect(model.respond(fresh, state())).toBe(true)
  })
  it('preserves Main running and permits retry once a failed request finishes', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!
    expect(model.fail(ticket)).toBe(true); expect(model.state?.phase).toBe('running')
    expect(model.error).toContain('尚未确认'); expect(model.error).toContain('不会自动撤回')
    model.finish(ticket); expect(model.requesting).toBe(false); expect(model.allowed('cancel')).toBe(true)
  })
  it('drops an older action error after a newer explicit query begins', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const cancel = model.begin('cancel')!; const fresh = model.begin('status')!
    expect(model.fail(cancel)).toBe(false); expect(model.fail(fresh)).toBe(true)
    expect(model.error).toContain('状态请求未完成')
  })
  it('does not publish a late error over a newer authoritative phase', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!; model.receive(state(1, 'settled'))
    expect(model.fail(ticket)).toBe(false); expect(model.error).toBe('')
  })
})

describe('close snapshot and bounded deferred publication', () => {
  it('retains the published snapshot until the close is canceled', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const before = model.state; model.setClosing(true)
    model.receive(state(1, 'cancelling')); model.receive(state(1, 'settled'))
    expect(model.state).toBe(before); expect(model.begin('cancel')).toBeNull()
    expect(model.begin('status')).toBeNull(); model.setClosing(false)
    expect(model.state?.phase).toBe('settled'); expect(model.allowed('cancel')).toBe(false)
  })
  it('queues a current failure instead of changing the frozen error snapshot', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!; model.setClosing(true)
    model.fail(ticket); model.finish(ticket); expect(model.error).toBe('')
    model.setClosing(false); expect(model.error).toContain('尚未确认')
  })
  it('drops queued errors superseded by a newer state before thaw', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!; model.setClosing(true); model.fail(ticket)
    model.receive(state(1, 'settled')); model.finish(ticket); model.setClosing(false)
    expect(model.error).toBe(''); expect(model.state?.phase).toBe('settled')
  })
  it('coalesces late states to the latest monotonic snapshot without regressions', () => {
    const model = new RepositoryTransferModel(true); model.receive(state()); model.setClosing(true)
    for (let sequence = 2; sequence < 20; sequence += 1) model.receive(state(sequence))
    expect(model.receive(state(5, 'settled'))).toBe(false)
    model.setClosing(false); expect(model.state?.sequence).toBe(19)
    model.setClosing(true); model.setClosing(false); expect(model.state?.sequence).toBe(19)
  })
})

describe('request pending is not Main authority', () => {
  it('keeps the authority snapshot immutable while showing a local cancellation request', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const before = model.state; const ticket = model.begin('cancel')!
    expect(model.state).toBe(before); expect(model.state?.phase).toBe('running')
    expect(model.summary).toContain('已请求取消'); expect(model.allowed('cancel')).toBe(false)
    model.finish(ticket); expect(model.requesting).toBe(false); expect(model.allowed('cancel')).toBe(true)
  })
  it('accepts fresh running status and explicit retry after a closing-time rejection', () => {
    const model = new RepositoryTransferModel(true); model.receive(state())
    const ticket = model.begin('cancel')!; model.setClosing(true)
    model.fail(ticket); model.finish(ticket)
    expect(model.requesting).toBe(true); expect(model.summary).toContain('已请求取消')
    model.setClosing(false); expect(model.requesting).toBe(false); expect(model.allowed('cancel')).toBe(true)
    const fresh = model.begin('status')!
    expect(model.respond(fresh, state())).toBe(true); model.finish(fresh)
    expect(model.state?.phase).toBe('running'); expect(model.allowed('cancel')).toBe(true)
    expect(model.begin('cancel')).not.toBeNull()
  })
  it('does not require a kind label in order to cancel a supported running state', () => {
    const model = new RepositoryTransferModel(true); model.receive(state(1, 'running', null))
    expect(model.allowed('cancel')).toBe(true); expect(model.begin('cancel')).not.toBeNull()
    expect(model.state?.phase).toBe('running'); expect(model.requesting).toBe(true)
  })
})

it('ignores late replies and events after disposal', () => {
  const model = new RepositoryTransferModel(true); const ticket = model.begin('status')!
  model.dispose(); expect(model.receive(state())).toBe(false)
  expect(model.respond(ticket, state())).toBe(false); expect(model.fail(ticket)).toBe(false)
  expect(model.allowed('status')).toBe(false); expect(model.allowed('cancel')).toBe(false)
})
