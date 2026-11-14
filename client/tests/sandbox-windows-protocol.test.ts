import * as childProcess from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowsSandboxSession, type WindowsSandboxSession } from '../src/main/sandbox/windows'

const mocks = vi.hoisted(() => ({ spawn: vi.fn<typeof import('node:child_process').spawn>() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_SANDBOX_SMOKE === '1'
const profile = `PaperStudio.Compiler.${'a'.repeat(32)}`
const folders: string[] = []; const sessions: WindowsSandboxSession[] = []; const helpers: FakeHelper[] = []
class FakeHelper extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough()
  requests: Record<string, unknown>[] = []
  cleanupStarted = false
  closed = false
  profile: string | null = profile
  kill = vi.fn(() => { this.finish(null); return true })
  constructor() {
    super(); this.stdin.on('data', (bytes) => { this.requests.push(JSON.parse(bytes.toString()) as Record<string, unknown>) })
  }
  frame(value: object) { this.stdout.write(`${JSON.stringify(value)}\n`) }
  ready() { this.frame({ type: 'ready', version: 1, profile, elapsedMs: 1 }) }
  cleanup(stage: 'setup' | 'session' = 'session', identity: string | null = profile) {
    this.cleanupStarted = true; this.profile = identity
    this.frame({ type: 'cleanup-start', stage, profile: identity, activeProcesses: 0, elapsedMs: 5 })
  }
  terminal(reason = 'canceled', cleanup = true) {
    if (!this.cleanupStarted) this.cleanup()
    this.frame({ type: 'closed', reason, cleanup, elapsedMs: 10, profile: this.profile })
  }
  finish(code: number | null) { if (!this.closed) { this.closed = true; this.emit('close', code) } }
}
afterEach(async () => {
  for (const helper of helpers.splice(0)) { if (!helper.closed) { helper.terminal(); helper.finish(1223) } }
  for (const session of sessions.splice(0)) await session.cancel().catch(() => undefined)
  vi.useRealTimers(); mocks.spawn.mockReset()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})
async function setup(options: { fakeTime?: boolean; timeoutMs?: number; setupFailure?: boolean; signal?: AbortSignal } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'paperstudio-protocol-')); folders.push(folder)
  const id = randomUUID(); const runtimeRoot = join(folder, `paperstudio-tex-${id}`); const work = join(folder, 'source')
  await mkdir(runtimeRoot); await mkdir(work)
  const executable = join(runtimeRoot, 'fixture.exe'); await writeFile(executable, 'NOT_EXECUTED')
  await writeFile(join(runtimeRoot, 'paperstudio-runtime.json'), JSON.stringify({ schema: 1, id, ready: true, platform: 'win32', distribution: 'texlive' }))
  const helper = new FakeHelper(); helpers.push(helper)
  if (options.fakeTime) vi.useFakeTimers()
  const spawn = mocks.spawn.mockReturnValue(helper as unknown as ReturnType<typeof childProcess.spawn>)
  const starting = createWindowsSandboxSession({ executable, runtimeRoot, workDirs: [work], timeoutMs: options.timeoutMs, signal: options.signal })
  await vi.waitFor(() => expect(spawn.mock.calls.length).toBe(1))
  if (options.setupFailure) { helper.cleanup('setup', null); helper.terminal('error'); helper.finish(1223) }
  else helper.ready()
  const session = await starting; sessions.push(session)
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, stdio: 'pipe', windowsHide: true })
  return { helper, session, work }
}

describe.skipIf(!enabled)('Windows session protocol fail-closed parser (mock helper, no native profile)', () => {
  it.each([
    ['unknown run id', (helper: FakeHelper) => helper.frame({ type: 'data', id: 2, stream: 'stdout', data: 'YQ==' })],
    ['noncanonical base64', (helper: FakeHelper) => helper.frame({ type: 'data', id: 1, stream: 'stdout', data: 'YQ=' })],
    ['non-UTF8 transport', (helper: FakeHelper) => helper.stdout.write(Buffer.from([0xc3, 0x28, 10]))],
    ['non-UTF8 embedded in otherwise valid JSON', (helper: FakeHelper) => helper.stdout.write(Buffer.concat([Buffer.from('{"type":"data","id":1,"stream":"stdout","data":"YQ==","ignored":"'), Buffer.from([0xff]), Buffer.from('"}\n')]))],
    ['oversized line', (helper: FakeHelper) => helper.stdout.write('x'.repeat(16385))],
    ['run-exit before run-start', (helper: FakeHelper) => helper.frame({ type: 'run-exit', id: 1, code: 0, elapsedMs: 2 })]
  ] as const)('rejects %s and does not resolve cancellation until actual helper close', async (name, corrupt) => {
    const { helper, session, work } = await setup()
    let settled = false
    const result = session.run([], work).then(() => { settled = true; return null }, (error: unknown) => { settled = true; return error })
    if (name !== 'run-exit before run-start') helper.frame({ type: 'run-start', id: 1, pid: 123456 })
    corrupt(helper)
    expect(helper.requests.at(-1)?.type).toBe('cancel')
    helper.terminal(); await setImmediate()
    expect(settled).toBe(false)
    helper.finish(1223)
    expect(await result).toBeInstanceOf(Error)
    await expect(session.dispose()).rejects.toThrow('协议')
  })
  it('rejects a cleanup ACK paired with the wrong native exit code', async () => {
    const { helper, session } = await setup()
    helper.terminal('closed'); helper.finish(1)
    await expect(session.dispose()).rejects.toThrow('未确认完整清理')
  })
  it('preserves a cleanup-failure ACK as a residual warning rather than successful cancellation', async () => {
    const { helper, session } = await setup()
    const canceled = session.cancel()
    helper.terminal('canceled', false); helper.finish(125)
    await expect(canceled).rejects.toThrow('清理失败')
    await expect(session.dispose()).rejects.toThrow('清理失败')
  })
  it.each(['wrong-exit', 'trailing-bytes', 'trailing-frame'] as const)('rejects canceled cleanup with %s discovered while awaiting close', async (kind) => {
    const { helper, session } = await setup()
    const result = session.cancel().then(() => null, (error: unknown) => error)
    helper.terminal()
    if (kind === 'trailing-bytes') helper.stdout.write('x')
    if (kind === 'trailing-frame') helper.frame({ type: 'data', id: 1, stream: 'stdout', data: 'YQ==' })
    helper.finish(kind === 'wrong-exit' ? 1 : 1223)
    expect(await result).toBeInstanceOf(Error)
  })
  it('accepts only the expected cancellation error after validated stage, ACK and actual native close', async () => {
    const controller = new AbortController(); const { helper, session } = await setup({ signal: controller.signal })
    controller.abort(); let settled = false
    const result = session.cancel().then(() => { settled = true })
    helper.terminal(); await setImmediate(); expect(settled).toBe(false)
    helper.finish(1223); await result
    await expect(session.cancel()).resolves.toBeUndefined()
  })
  it('keeps the 10-second forced stop until a safe cleanup stage is confirmed', async () => {
    const { helper, session } = await setup({ fakeTime: true })
    const result = session.cancel().then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(9999); expect(helper.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(helper.kill).toHaveBeenCalledTimes(1)
    expect(await result).toBeInstanceOf(Error)
  })
  it('switches once to absolute 30-second cleanup grace after Job zero, never refreshing it', async () => {
    const { helper, session } = await setup({ fakeTime: true })
    const result = session.cancel().then(() => null, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(9000); helper.cleanup()
    await vi.advanceTimersByTimeAsync(29999); expect(helper.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(helper.kill).toHaveBeenCalledTimes(1)
    expect(await result).toBeInstanceOf(Error)
  })
  it('ends execution timing only on cleanup-start and refuses new RUNs there', async () => {
    const { helper, session, work } = await setup({ fakeTime: true, timeoutMs: 1000 })
    helper.cleanup()
    await expect(session.run([], work)).rejects.toThrow('不可运行')
    await vi.advanceTimersByTimeAsync(1100); expect(helper.kill).not.toHaveBeenCalled()
    helper.terminal('closed'); helper.finish(0)
    await expect(session.dispose()).resolves.toBeUndefined()
  })
  it.each(['duplicate', 'wrong-profile', 'active-process', 'wrong-stage', 'run-after-cleanup'] as const)('rejects %s cleanup transitions', async (kind) => {
    const { helper, session } = await setup()
    if (kind === 'duplicate' || kind === 'run-after-cleanup') helper.cleanup()
    if (kind === 'run-after-cleanup') helper.frame({ type: 'run-start', id: 1, pid: 123456 })
    else helper.frame({ type: 'cleanup-start', stage: kind === 'wrong-stage' ? 'setup' : 'session', activeProcesses: kind === 'active-process' ? 1 : 0,
      profile: kind === 'wrong-profile' ? `PaperStudio.Compiler.${'b'.repeat(32)}` : profile, elapsedMs: 5 })
    helper.terminal('closed'); helper.finish(0)
    await expect(session.dispose()).rejects.toThrow('协议')
  })
  it('permits safe setup-stage cleanup without READY but still rejects failed startup', async () => {
    await expect(setup({ setupFailure: true })).rejects.toThrow('会话终止：error')
  })
  it('rejects a successful closed ACK without any safe cleanup stage', async () => {
    const { helper, session } = await setup()
    helper.frame({ type: 'closed', reason: 'closed', cleanup: true, elapsedMs: 10, profile }); helper.finish(0)
    await expect(session.dispose()).rejects.toThrow('残留风险')
  })
  it('rejects profile identity changes even if the helper supplies a nominal cleanup ACK', async () => {
    const { helper, session } = await setup()
    helper.frame({ type: 'closed', reason: 'closed', cleanup: true, elapsedMs: 10, profile: `PaperStudio.Compiler.${'b'.repeat(32)}` })
    helper.finish(0)
    await expect(session.dispose()).rejects.toThrow('残留风险')
  })
})
