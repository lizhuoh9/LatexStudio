import { describe, expect, it } from 'vitest'
import { environmentNotice, SetupModel } from '../src/renderer/setup-model'
import type { TexSetupState } from '../src/shared/tex-setup-contracts'

const state = (phase: TexSetupState['phase'] = 'required', extra: Partial<TexSetupState> = {}): TexSetupState =>
  ({ phase, message: 'fixture resource status', supported: true, compileVerified: false, completed: 0, total: 0, ...extra })

function readyModel(): SetupModel { const model = new SetupModel(true); model.receive(state()); return model }

describe('preparation is not product compile acceptance', () => {
  it('does not call prepared resources verified', () => {
    const model = readyModel(); model.receive(state('prepared'))
    expect(model.verified).toBe(false); expect(model.summary).toBe('编译组件尚未通过验证')
    expect(model.allowed('prepare')).toBe(false); expect(model.allowed('status')).toBe(true)
  })
  it('requires supported + prepared + compileVerified, not just one flag', () => {
    const model = readyModel(); model.receive(state('verifying', { compileVerified: true }))
    expect(model.verified).toBe(false)
    model.receive(state('prepared', { compileVerified: true, supported: false }))
    expect(model.verified).toBe(false); expect(model.allowed('prepare')).toBe(false)
    model.receive(state('prepared', { compileVerified: true }))
    expect(model.verified).toBe(true)
  })
  it('degrades explicitly without the optional setup bridge', () => {
    const model = new SetupModel(false)
    expect(model.summary).toBe('编译组件服务不可用')
    for (const action of ['prepare', 'cancel', 'status'] as const) expect(model.allowed(action)).toBe(false)
  })
  it('does not ask unsupported platforms to install candidates', () => {
    const model = readyModel(); model.receive(state('required', { supported: false }))
    expect(model.summary).toBe('当前系统暂不支持编译'); expect(model.begin('prepare')).toBeNull()
  })
})

describe('compact notices do not grant compile permission', () => {
  it('hides the inline notice only after the caller confirms both compile gates', () => {
    const model = readyModel(); model.receive(state('prepared', { compileVerified: true }))
    expect(environmentNotice(false, model.verified, null, '', model.summary)).toEqual({
      message: '正在检查编译环境…', hidden: false, problem: false })
    expect(environmentNotice(false, model.verified, false, '', model.summary).hidden).toBe(false)
    expect(environmentNotice(true, model.verified, true, '', model.summary).hidden).toBe(true)
    expect(environmentNotice(true, false, true, '', 'unverified').hidden).toBe(false)
    expect(environmentNotice(true, true, false, '', 'unavailable').hidden).toBe(false)
    expect(model.verified).toBe(true)
  })
  it('keeps missing, unsupported and failed states visible with brief user language', () => {
    const model = new SetupModel(true)
    expect(environmentNotice(false, false, null, '', model.summary).hidden).toBe(false)
    model.receive(state('required', { supported: false }))
    expect(environmentNotice(false, false, false, '', model.summary).message).toBe('当前系统暂不支持编译')
    expect(environmentNotice(true, true, true, 'failed environment request', 'ready')).toEqual({
      message: '编译组件检查失败', hidden: false, problem: true })
  })
  it('fails closed after a refresh error while retaining the last real backend state', () => {
    const model = readyModel(); model.receive(state('prepared', { compileVerified: true }))
    const before = model.state; model.fail(new Error('fixture failure'))
    expect(model.state).toBe(before); expect(model.verified).toBe(false); expect(model.attention).toBe(true)
    model.receive(state('prepared', { compileVerified: true })); expect(model.verified).toBe(true)
  })
})

describe('state events and asynchronous management requests', () => {
  it('ignores an old status reply after a newer progress event', () => {
    const model = readyModel(); const ticket = model.begin('status')!
    model.receive(state('downloading'))
    expect(model.respond('status', state('required'), ticket)).toBe(false)
    expect(model.state?.phase).toBe('downloading')
  })
  it('accepts the command terminal result after its progress events', () => {
    const model = readyModel(); const ticket = model.begin('prepare')!
    model.receive(state('downloading'))
    expect(model.respond('prepare', state('prepared'), ticket)).toBe(true)
    expect(model.verified).toBe(false)
  })
  it('allows cancellation while prepare is pending and rejects its late reply', () => {
    const model = readyModel(); const start = model.begin('prepare')!
    expect(model.allowed('cancel')).toBe(true)
    const cancel = model.begin('cancel')!
    expect(model.respond('cancel', state('required'), cancel)).toBe(true)
    expect(model.respond('prepare', state('prepared'), start)).toBe(false)
    expect(model.state?.phase).toBe('required')
  })
  it('retains actual state on API errors and permits an explicit retry', () => {
    const model = readyModel(); const before = model.state
    model.fail(new Error('fixture transport failed'))
    expect(model.state).toBe(before); expect(model.error).toContain('fixture transport failed')
    expect(model.allowed('prepare')).toBe(true)
  })
})

describe('closing, retry and honest progress', () => {
  it('blocks every new setup request throughout closing, even after a late event', () => {
    const model = readyModel(); model.closing = true; model.receive(state('error'))
    for (const action of ['prepare', 'cancel', 'status'] as const) expect(model.begin(action)).toBeNull()
    model.closing = false; expect(model.allowed('prepare')).toBe(true)
  })
  it('does not silently restart after a canceled request', () => {
    const model = readyModel(); model.begin('prepare'); model.finish('prepare'); model.receive(state())
    expect(model.state?.phase).toBe('required'); expect(model.allowed('prepare')).toBe(true)
    expect(model.allowed('cancel')).toBe(false)
  })
  it('clamps invalid or oversized progress and keeps unknown totals indeterminate', () => {
    const model = readyModel(); model.receive(state('downloading', { completed: 200, total: 100 }))
    expect(model.progress).toEqual({ value: 100, total: 100, percent: 100 })
    model.receive(state('extracting', { completed: NaN, total: Infinity }))
    expect(model.progress).toEqual({ value: 0, total: 0, percent: null })
  })
  it('redacts credential-shaped API failures rather than persisting a raw error', () => {
    const model = readyModel(); model.fail(new Error('fixture ghp_notARealCredential'))
    expect(model.error).not.toContain('ghp_'); expect(model.error).toContain('已隐藏凭据')
  })
})
