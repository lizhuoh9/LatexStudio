import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubError } from '../src/main/github/remote-policy'
import { readVerificationLifecycleFailure, withVerificationLifecycle } from '../src/main/github/verification-lifecycle'
import { RepositoryOperationError, withRepositoryOperation } from '../src/main/github/repository-operation'

// SOURCE definitions only: UNRUN. No filesystem, Git, actual HTTP or native execution.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const secret = 'ghp_test-provider-must-not-escape'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function track(promise: Promise<unknown>) {
  const state = { done: false, result: Promise.resolve<unknown>(undefined) }
  state.result = promise.then(value => { state.done = true; return value }, (error: unknown) => { state.done = true; return error })
  return state
}
async function caught(action: () => Promise<unknown>): Promise<unknown> {
  try { await action() } catch (error) { return error }
  throw new Error('Expected a synthetic failure')
}
async function knownFailure(operationFailed: boolean, cleanupFailed: boolean): Promise<GitHubError> {
  const error = await caught(() => withVerificationLifecycle(async () => {
    if (operationFailed) throw new Error(secret)
    return 'not published after failed cleanup'
  }, async () => { if (cleanupFailed) throw new Error(secret) }))
  if (!(error instanceof GitHubError) || readVerificationLifecycleFailure(error) === null) throw new Error('Expected an authentic fixture failure')
  return error
}
function safe(error: unknown) {
  expect(error).toBeInstanceOf(GitHubError)
  expect(Object.isFrozen(error)).toBe(true)
  expect(String(error)).not.toContain(secret)
  expect(JSON.stringify(error)).not.toContain(secret)
  expect((error as Error).stack).not.toContain(secret)
  expect(error).not.toHaveProperty('cause')
}

it('publishes the value only after actual action and cleanup completion', async () => {
  const work = deferred<number>()
  const closed = deferred<void>()
  const close = vi.fn(() => closed.promise)
  const pending = track(withVerificationLifecycle(() => work.promise, close))
  await vi.advanceTimersByTimeAsync(0)
  expect(close).not.toHaveBeenCalled()
  expect(pending.done).toBe(false)
  work.resolve(42)
  await vi.advanceTimersByTimeAsync(0)
  expect(close).toHaveBeenCalledTimes(1)
  expect(pending.done).toBe(false)
  closed.resolve(undefined)
  expect(await pending.result).toBe(42)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([[true, false], [false, true], [true, true]] as const)('generates only local frozen flags for primary=%s cleanup=%s', async (operationFailed, cleanupFailed) => {
  const error = await knownFailure(operationFailed, cleanupFailed)
  safe(error)
  const flags = readVerificationLifecycleFailure(error)
  expect(flags).toEqual({ operationFailed, cleanupFailed })
  expect(Object.isFrozen(flags)).toBe(true)
  expect(Reflect.set(flags!, 'cleanupFailed', false)).toBe(false)
  expect(Reflect.set(error as object, 'cause', new Error(secret))).toBe(false)
  expect(Reflect.set(error as object, 'cleanupFailed', false)).toBe(false)
})

it.each([[false, false, false], [true, false, false], [false, true, false], [false, false, true],
  [true, true, false], [true, false, true], [false, true, true], [true, true, true]] as const)('merges nested authentic flags without inventing primary: %s/%s/%s', async (primary, bodyCleanup, transferCleanup) => {
  const pending = track(withVerificationLifecycle(() => withVerificationLifecycle(async () => {
    if (primary) throw new Error(secret)
    return 42
  }, async () => { if (bodyCleanup) throw new Error(secret) }), async () => { if (transferCleanup) throw new Error(secret) }))
  const result = await pending.result
  if (!primary && !bodyCleanup && !transferCleanup) expect(result).toBe(42)
  else {
    safe(result)
    expect(readVerificationLifecycleFailure(result)).toEqual({ operationFailed: primary, cleanupFailed: bodyCleanup || transferCleanup })
  }
})

it('awaits cleanup after action failure rather than racing away a pending close', async () => {
  const closed = deferred<void>()
  const pending = track(withVerificationLifecycle(async () => { throw new Error(secret) }, () => closed.promise))
  await vi.advanceTimersByTimeAsync(1000000)
  expect(pending.done).toBe(false)
  closed.resolve(undefined)
  const error = await pending.result
  safe(error)
  expect(readVerificationLifecycleFailure(error)).toEqual({ operationFailed: true, cleanupFailed: false })
})

it('handles synchronous throws from both callbacks without retaining the thrown objects', async () => {
  const error = await caught(() => withVerificationLifecycle(() => { throw { message: secret } }, () => { throw { cause: secret } }))
  safe(error)
  expect(readVerificationLifecycleFailure(error)).toEqual({ operationFailed: true, cleanupFailed: true })
})

it('counts a branded primary error thrown during cleanup as both primary and unconfirmed cleanup', async () => {
  const primary = await knownFailure(true, false)
  const error = await caught(() => withVerificationLifecycle(async () => 42, async () => { throw primary }))
  expect(readVerificationLifecycleFailure(error)).toEqual({ operationFailed: true, cleanupFailed: true })
})

it('never reads provider error getters or proxy traps while classifying failures', async () => {
  const trap = vi.fn(() => { throw new Error(secret) })
  const provider = Object.create(null) as object
  for (const key of ['message', 'name', 'flags', 'operationFailed', 'cleanupFailed', 'cause']) Object.defineProperty(provider, key, { get: trap })
  const proxy = new Proxy(provider, { get: trap, getPrototypeOf: trap, ownKeys: trap })
  expect(readVerificationLifecycleFailure(proxy)).toBeNull()
  const error = await caught(() => withVerificationLifecycle(async () => { throw proxy }, async () => undefined))
  expect(readVerificationLifecycleFailure(error)).toEqual({ operationFailed: true, cleanupFailed: false })
  expect(trap).not.toHaveBeenCalled()
  safe(error)
})

it.each([undefined, null, false, 1, 'provider', Symbol('provider')])('primitive provider value does not carry a brand: %s', (value) => {
  expect(readVerificationLifecycleFailure(value)).toBeNull()
})

it('rejects reflected construction, prototype inheritance, names, flags, proxies and cause chains', async () => {
  const genuine = await knownFailure(false, true)
  const prototype = Object.getPrototypeOf(genuine)
  const Constructor = prototype.constructor as new (kind: string) => Error
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const candidates = [new Constructor('both'), Object.create(genuine), Object.create(prototype), new Proxy(genuine as object, {}),
    Object.assign(new GitHubError(secret), { name: 'VerificationLifecycleError', cleanupFailed: true, operationFailed: false }),
    { flags: readVerificationLifecycleFailure(genuine), cause: genuine, cleanupFailed: true }, revoked.proxy]
  for (const candidate of candidates) {
    expect(readVerificationLifecycleFailure(candidate)).toBeNull()
    const error = await caught(() => withVerificationLifecycle(async () => { throw candidate }, async () => undefined))
    expect(readVerificationLifecycleFailure(error)).toEqual({ operationFailed: true, cleanupFailed: false })
  }
  expect(Object.isFrozen(Constructor)).toBe(true)
  expect(Object.isFrozen(prototype)).toBe(true)
  expect(Reflect.set(prototype, 'constructor', Error)).toBe(false)
})

it('latches authentic nested cleanup in step before a caller catches the failure', async () => {
  const nested = await knownFailure(false, true)
  const mutate = vi.fn(async () => undefined)
  const push = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const error = await caught(() => withRepositoryOperation({}, async scope => {
    scope.own({ close })
    try { await scope.step(async () => { throw nested }) } catch { /* Recovery cannot erase cleanup uncertainty. */ }
    await expect(scope.mutate(mutate)).rejects.toThrow()
    await expect(scope.remoteWrite(push)).rejects.toThrow()
    return 'must not publish'
  }))
  expect(error).toBeInstanceOf(RepositoryOperationError)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: true, localChangesMayExist: false, remoteWriteMayHaveCompleted: false })
  expect(mutate).not.toHaveBeenCalled()
  expect(push).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('also captures authentic cleanup when a direct verification rejection reaches the outer catch', async () => {
  const nested = await knownFailure(false, true)
  const error = await caught(() => withRepositoryOperation({}, async () => { throw nested }))
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: true })
  safe(error)
})

it.each(['authentic-primary', 'provider-shape', 'provider-prototype'] as const)('caught recoverable primary failures do not poison successful action: %s', async (kind) => {
  const genuine = await knownFailure(true, kind === 'provider-prototype')
  const provider = kind === 'authentic-primary' ? genuine : kind === 'provider-prototype' ? Object.create(genuine) : { cleanupFailed: true, flags: { cleanupFailed: true } }
  const mutate = vi.fn(async () => 42)
  const result = await withRepositoryOperation({}, async scope => {
    try { await scope.step(async () => { throw provider }) } catch { /* Explicit local recovery with no known failed cleanup. */ }
    return scope.mutate(mutate)
  })
  expect(result).toBe(42)
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('awaits all owned closes and retains local/remote uncertainty after a nested cleanup latch', async () => {
  const nested = await knownFailure(true, true)
  const closed = deferred<void>()
  const first = vi.fn(async () => { throw new Error(secret) })
  const second = vi.fn(() => closed.promise)
  const push = vi.fn(async () => 'accepted')
  const pending = track(withRepositoryOperation({}, async scope => {
    scope.own({ close: first }); scope.own({ close: second })
    await scope.mutate(async () => undefined)
    await scope.remoteWrite(push)
    await scope.step(async () => { throw nested })
  }))
  await vi.advanceTimersByTimeAsync(0)
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  expect(pending.done).toBe(false)
  closed.resolve(undefined)
  expect(await pending.result).toMatchObject({ operationFailed: true, cleanupFailed: true, localChangesMayExist: true, remoteWriteMayHaveCompleted: true })
  expect(push).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancel and deadline cannot race away nested cleanup or permit a later mutation', async () => {
  const parent = new AbortController()
  const bodyClosed = deferred<void>()
  const clientClosed = deferred<void>()
  const ownClose = vi.fn(() => clientClosed.promise)
  const mutate = vi.fn(async () => undefined)
  const pending = track(withRepositoryOperation({ signal: parent.signal, timeoutMs: 10 }, async scope => {
    scope.own({ close: ownClose })
    await scope.step(() => withVerificationLifecycle(async () => 42, () => bodyClosed.promise))
    await scope.mutate(mutate)
  }))
  parent.abort()
  await vi.advanceTimersByTimeAsync(11)
  expect(pending.done).toBe(false)
  expect(ownClose).not.toHaveBeenCalled()
  bodyClosed.reject(new Error(secret))
  await vi.advanceTimersByTimeAsync(0)
  expect(ownClose).toHaveBeenCalledTimes(1)
  expect(pending.done).toBe(false)
  clientClosed.resolve(undefined)
  expect(await pending.result).toMatchObject({ operationFailed: true, cleanupFailed: true, cancelled: true, timedOut: true, localChangesMayExist: false })
  expect(mutate).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
