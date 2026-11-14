import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubError } from '../src/main/github/remote-policy'
import { REPOSITORY_OPERATION_TIMEOUT_MS, RepositoryOperationError, snapshotRepositoryConnection, snapshotRepositoryOperationOptions,
  withRepositoryOperation, type RepositoryOperationOptions, type RepositoryOperationScope } from '../src/main/github/repository-operation'

// Definitions only: UNRUN. Synthetic promises/AbortSignals, not native FS, Git or network evidence.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const secret = 'ghp_provider-must-not-escape'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function track(promise: Promise<unknown>) {
  const state = { done: false, result: Promise.resolve<unknown>(undefined) }
  state.result = promise.then((value) => { state.done = true; return value }, (error: unknown) => { state.done = true; return error })
  return state
}

it('exports the 120-second cooperative ceiling and freezes the options snapshot', () => {
  expect(REPOSITORY_OPERATION_TIMEOUT_MS).toBe(120000)
  const snapshot = snapshotRepositoryOperationOptions()
  expect(snapshot).toEqual({ signal: undefined, timeoutMs: 120000 })
  expect(Object.isFrozen(snapshot)).toBe(true)
})

it.each([NaN, Infinity, -1, 0, 0.5, 120001])('rejects invalid or enlarged timeout %s before work or timers', async (timeoutMs) => {
  const action = vi.fn(async () => 'never')
  await expect(withRepositoryOperation({ timeoutMs }, action)).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect(action).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([null, false, {}, [], '10', 1.5])('explicit invalid timeout %j is not an omitted override', async (timeoutMs) => {
  const options = { timeoutMs } as unknown as RepositoryOperationOptions
  const action = vi.fn(async () => undefined)
  await expect(withRepositoryOperation(options, action)).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect(action).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('reads the timeout getter once and only undefined uses the default', () => {
  const get = vi.fn(() => 10)
  const input = Object.defineProperty({}, 'timeoutMs', { get })
  expect(snapshotRepositoryOperationOptions(input).timeoutMs).toBe(10)
  expect(get).toHaveBeenCalledTimes(1)
  expect(snapshotRepositoryOperationOptions({ timeoutMs: undefined }).timeoutMs).toBe(120000)
})

it('freezes the canonical target and token primitives before settings can be changed', () => {
  const input = { url: 'https://github.com/team/paper', token: 'ghp_original' }
  const captured = snapshotRepositoryConnection(input)
  input.url = 'https://github.com/other/repository'
  input.token = 'ghp_replacement'
  expect(captured).toEqual({ target: { url: 'https://github.com/team/paper.git', owner: 'team', repository: 'paper' }, token: 'ghp_original' })
  expect(Object.isFrozen(captured)).toBe(true)
  expect(Object.isFrozen(captured.target)).toBe(true)
  expect(Reflect.set(captured.target, 'url', input.url)).toBe(false)
})

it('connection getters are read once and getter failures never become provider output', () => {
  const url = vi.fn(() => 'https://github.com/team/paper')
  const token = vi.fn(() => 'ghp_original')
  const input = Object.defineProperties({}, { url: { get: url }, token: { get: token } }) as { url: string; token: string }
  expect(snapshotRepositoryConnection(input).token).toBe('ghp_original')
  expect(url).toHaveBeenCalledTimes(1)
  expect(token).toHaveBeenCalledTimes(1)
  token.mockImplementationOnce(() => { throw new Error(`Authorization: ${secret}`) })
  let error: unknown
  try { snapshotRepositoryConnection(input) } catch (failure) { error = failure }
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: false })
  expect(String(error)).not.toContain(secret)
  expect(error).not.toHaveProperty('cause')
})

it.each([{ url: 'http://github.com/team/paper', token: 'ghp_original' },
  { url: 'https://user:password@github.com/team/paper', token: 'ghp_original' },
  { url: 'https://github.com/team/paper', token: '秘密' },
  { url: 'https://github.com/team/paper', token: 'line\nbreak' }])('invalid connection primitives are statically rejected: %j', (input) => {
  expect(() => snapshotRepositoryConnection(input)).toThrow(RepositoryOperationError)
})

it('does not accept a duck-typed mutable cancellation signal', async () => {
  const signal = { aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as AbortSignal
  const action = vi.fn(async () => undefined)
  await expect(withRepositoryOperation({ signal }, action)).rejects.toBeInstanceOf(RepositoryOperationError)
  expect(action).not.toHaveBeenCalled()
  expect(signal.addEventListener).not.toHaveBeenCalled()
})

it('sanitizes a throwing options getter without retaining its provider cause', async () => {
  const options = Object.defineProperty({}, 'signal', { get() { throw new Error(`Authorization: Bearer ${secret}`) } })
  const error = await withRepositoryOperation(options, async () => undefined).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect(String(error)).not.toContain(secret)
  expect(error).not.toHaveProperty('cause')
  expect(vi.getTimerCount()).toBe(0)
})

it('pre-abort performs no action and disposes the scope timer', async () => {
  const parent = new AbortController()
  parent.abort()
  const action = vi.fn(async () => undefined)
  await expect(withRepositoryOperation({ signal: parent.signal }, action)).rejects.toMatchObject({
    operationFailed: true, cancelled: true, cleanupFailed: false, localChangesMayExist: false,
  })
  expect(action).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for the owned required close before publishing success', async () => {
  const closed = deferred<void>()
  const client = { close: vi.fn(() => closed.promise) }
  const operation = track(withRepositoryOperation({}, async (scope) => { scope.own(client); return 42 }))
  await vi.advanceTimersByTimeAsync(0)
  expect(client.close).toHaveBeenCalledTimes(1)
  expect(operation.done).toBe(false)
  closed.resolve(undefined)
  expect(await operation.result).toBe(42)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains primary and cleanup failures as frozen safe flags, not raw provider text', async () => {
  const close = vi.fn(async () => { throw new GitHubError(`Authorization: Bearer ${secret}`) })
  const error = await withRepositoryOperation({}, async (scope) => {
    scope.own({ close })
    throw new GitHubError(`https://user:${secret}@evil.example`)
  }).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(RepositoryOperationError)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: true })
  expect(Object.isFrozen(error)).toBe(true)
  const safe = error as RepositoryOperationError
  expect(Object.isFrozen(safe.flags)).toBe(true)
  expect(Reflect.set(safe.flags, 'cleanupFailed', false)).toBe(false)
  expect(String(error)).not.toContain(secret)
  expect(JSON.stringify(error)).not.toContain(secret)
  expect(safe.stack).not.toContain(secret)
  expect(error).not.toHaveProperty('cause')
  expect(close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not report success when only cleanup fails', async () => {
  const error = await withRepositoryOperation({}, async (scope) => {
    scope.own({ close: async () => { throw new Error(secret) } })
    return 'not publishable'
  }).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ operationFailed: false, cleanupFailed: true })
  expect(String(error)).not.toContain(secret)
})

it('starts every owned close, waits for every result, and closes each object only once', async () => {
  const pending = deferred<void>()
  const first = { close: vi.fn(async () => { throw new Error(secret) }) }
  const second = { close: vi.fn(() => pending.promise) }
  const operation = track(withRepositoryOperation({}, async (scope) => {
    scope.own(first); scope.own(second); scope.own(first)
    throw new Error(secret)
  }))
  await vi.advanceTimersByTimeAsync(0)
  expect(first.close).toHaveBeenCalledTimes(1)
  expect(second.close).toHaveBeenCalledTimes(1)
  expect(operation.done).toBe(false)
  pending.resolve(undefined)
  expect(await operation.result).toMatchObject({ operationFailed: true, cleanupFailed: true })
})

it('captures the close implementation when a client is registered', async () => {
  const original = vi.fn(async () => {})
  const replacement = vi.fn(async () => {})
  await withRepositoryOperation({}, async (scope) => {
    const client = scope.own({ close: original })
    client.close = replacement
  })
  expect(original).toHaveBeenCalledTimes(1)
  expect(replacement).not.toHaveBeenCalled()
})

it('invalid required-close clients do not produce fake cleanup success', async () => {
  const client = {} as { close(): Promise<void> }
  await expect(withRepositoryOperation({}, async (scope) => { scope.own(client) })).rejects.toMatchObject({ operationFailed: true, cleanupFailed: true })
})

it('timeout cannot race a pending local action or permit its next mutation', async () => {
  const work = deferred<void>()
  const next = vi.fn(async () => undefined)
  const close = vi.fn(async () => {})
  let ownedSignal: AbortSignal | undefined
  const operation = track(withRepositoryOperation({ timeoutMs: 10 }, async (scope) => {
    ownedSignal = scope.signal
    scope.own({ close })
    await scope.mutate(() => work.promise)
    await scope.mutate(next)
  }))
  await vi.advanceTimersByTimeAsync(11)
  expect(ownedSignal?.aborted).toBe(true)
  expect(operation.done).toBe(false)
  expect(close).not.toHaveBeenCalled()
  work.resolve(undefined)
  expect(await operation.result).toMatchObject({ operationFailed: true, timedOut: true, localChangesMayExist: true, cleanupFailed: false })
  expect(next).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('parent cancellation awaits in-flight work and only then rejects and confirms cleanup', async () => {
  const parent = new AbortController()
  const work = deferred<void>()
  const close = vi.fn(async () => {})
  const next = vi.fn(async () => {})
  const operation = track(withRepositoryOperation({ signal: parent.signal }, async (scope) => {
    scope.own({ close })
    await scope.step(() => work.promise)
    await scope.mutate(next)
  }))
  parent.abort()
  await vi.advanceTimersByTimeAsync(0)
  expect(operation.done).toBe(false)
  work.resolve(undefined)
  expect(await operation.result).toMatchObject({ operationFailed: true, cancelled: true, localChangesMayExist: false })
  expect(next).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
})

it('cancellation during successful action cleanup still prevents successful settlement', async () => {
  const parent = new AbortController()
  const finished = deferred<void>()
  const close = vi.fn(() => finished.promise)
  const operation = track(withRepositoryOperation({ signal: parent.signal }, async (scope) => { scope.own({ close }); return 1 }))
  await vi.advanceTimersByTimeAsync(0)
  parent.abort()
  expect(operation.done).toBe(false)
  finished.resolve(undefined)
  expect(await operation.result).toMatchObject({ operationFailed: true, cancelled: true, cleanupFailed: false })
  expect(vi.getTimerCount()).toBe(0)
})

it('timeout during cleanup awaits acknowledgement and cannot return the earlier success value', async () => {
  const finished = deferred<void>()
  const operation = track(withRepositoryOperation({ timeoutMs: 10 }, async (scope) => { scope.own({ close: () => finished.promise }); return 1 }))
  await vi.advanceTimersByTimeAsync(11)
  expect(operation.done).toBe(false)
  finished.resolve(undefined)
  expect(await operation.result).toMatchObject({ operationFailed: true, timedOut: true, cleanupFailed: false })
})

it('snapshots the original parent and tightened timeout before deferred execution', async () => {
  const parent = new AbortController()
  const substitute = new AbortController()
  const input: RepositoryOperationOptions = { signal: parent.signal, timeoutMs: 10 }
  const snapshot = snapshotRepositoryOperationOptions(input)
  input.signal = substitute.signal
  input.timeoutMs = 120000
  const work = deferred<void>()
  const operation = track(withRepositoryOperation(snapshot, async (scope) => scope.step(() => work.promise)))
  substitute.abort()
  await vi.advanceTimersByTimeAsync(11)
  expect(operation.done).toBe(false)
  work.resolve(undefined)
  expect(await operation.result).toMatchObject({ timedOut: true, cancelled: false })
})

it('records ambiguous remote acceptance and does not retry or proceed to later mutations', async () => {
  const parent = new AbortController()
  const accepted = deferred<string>()
  const push = vi.fn(() => accepted.promise)
  const metadata = vi.fn(async () => {})
  const operation = track(withRepositoryOperation({ signal: parent.signal }, async (scope) => {
    await scope.remoteWrite(push)
    await scope.mutate(metadata)
  }))
  parent.abort()
  expect(operation.done).toBe(false)
  accepted.resolve('accepted before cancellation was observed')
  const error = await operation.result
  expect(error).toMatchObject({ operationFailed: true, cancelled: true, remoteWriteMayHaveCompleted: true })
  expect(push).toHaveBeenCalledTimes(1)
  expect(metadata).not.toHaveBeenCalled()
  expect(String(error)).toContain('不要自动重试或回滚')
})

it('cannot extend the lifetime through a scope retained after completion', async () => {
  let retained: RepositoryOperationScope | undefined
  await withRepositoryOperation({}, async (scope) => { retained = scope })
  expect(() => retained!.check()).toThrow()
  const close = vi.fn(async () => {})
  expect(() => retained!.own({ close })).toThrow()
  expect(close).not.toHaveBeenCalled()
})
