import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TransferBody, TransferOptions, TransferResponse } from '../src/main/github/transfer'
import { githubHttp, verifyGitHub } from '../src/main/github/transport'
import { GitHubError, githubTarget } from '../src/main/github/remote-policy'
import { readVerificationLifecycleFailure } from '../src/main/github/verification-lifecycle'
import { RepositoryOperationError, withRepositoryOperation } from '../src/main/github/repository-operation'
import { WorkspaceRepositoryTransfer } from '../src/main/workspace/repository-transfer'

// SOURCE definitions only: UNRUN. Real pure modules with synthetic promises/Fetch/WebStreams;
// the manager close gate below is NOT actual Electron, controller, filesystem, Git or GitHub proof.
const provider = vi.hoisted(() => ({ real: false, options: [] as TransferOptions[], responses: [] as TransferResponse[],
  open: vi.fn<(url: string, init: RequestInit) => Promise<TransferResponse>>(), close: vi.fn<() => Promise<void>>() }))
vi.mock('../src/main/github/transfer', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/github/transfer')>()
  return { ...actual, GitHubTransfer: function (options: TransferOptions = {}) {
    provider.options.push(options)
    return provider.real ? new actual.GitHubTransfer(options) : { open: provider.open, close: provider.close }
  } }
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  provider.real = false
  provider.options.length = 0
  provider.responses.length = 0
  provider.open.mockReset().mockImplementation(async () => {
    const response = provider.responses.shift()
    if (!response) throw new Error('Unexpected synthetic response request')
    return response
  })
  provider.close.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const target = githubTarget('https://github.com/team/paper')
const token = 'ghp_fixture-token-never-returned'
const user = { login: 'alice', id: 42, email: 'not-collected@example.test' }
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
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try { await promise } catch (error) { return error }
  throw new Error('Expected synthetic failure')
}
function response(text: string) {
  let sent = false
  const returned = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }))
  const body: TransferBody = {
    [Symbol.asyncIterator]() { return this },
    async next() { if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: new TextEncoder().encode(text) } },
    return: returned,
    async throw(error?: unknown) { throw error },
  }
  return { value: { statusCode: 200, headers: { 'content-type': 'application/json' }, body }, returned }
}
function ready() {
  const identity = response(JSON.stringify(user))
  const repository = response(JSON.stringify({ default_branch: 'papers/default' }))
  provider.responses.push(identity.value, repository.value)
  return { identity, repository }
}
function assertSafe(error: unknown, operationFailed: boolean, cleanupFailed: boolean) {
  expect(error).toBeInstanceOf(GitHubError)
  expect(readVerificationLifecycleFailure(error)).toEqual({ operationFailed, cleanupFailed })
  expect(Object.isFrozen(error)).toBe(true)
  expect(error).not.toHaveProperty('cause')
  expect(String(error)).not.toContain(token)
  expect(JSON.stringify(error)).not.toContain(token)
  expect((error as Error).stack).not.toContain(token)
}
const failures = [
  { label: 'primary-only', malformed: true, bodyFailed: false, clientFailed: false, primary: true, cleanup: false },
  { label: 'body-cleanup-only', malformed: false, bodyFailed: true, clientFailed: false, primary: false, cleanup: true },
  { label: 'transfer-cleanup-only', malformed: false, bodyFailed: false, clientFailed: true, primary: false, cleanup: true },
  { label: 'primary-and-both-cleanups', malformed: true, bodyFailed: true, clientFailed: true, primary: true, cleanup: true },
] as const
function prepareFailure(scenario: typeof failures[number]) {
  const fixtures = ready()
  if (scenario.malformed) provider.responses[0] = response('{').value
  const first = provider.responses[0]!
  const returned = first.body.return as ReturnType<typeof response>['returned']
  if (scenario.bodyFailed) returned.mockRejectedValue(new Error(`Authorization: ${token}`))
  if (scenario.clientFailed) provider.close.mockRejectedValue(new Error(`https://user:${token}@github.com`))
  return { ...fixtures, returned }
}

it('keeps successful identity/default-history shape and awaits each API cleanup and transfer close once', async () => {
  const fixtures = ready()
  expect(await verifyGitHub(target, token)).toEqual({ login: 'alice', id: 42, branch: 'papers/default' })
  expect(fixtures.identity.returned).toHaveBeenCalledTimes(1)
  expect(fixtures.repository.returned).toHaveBeenCalledTimes(1)
  expect(provider.close).toHaveBeenCalledTimes(1)
  expect(provider.open.mock.calls.map(([url]) => url)).toEqual(['https://api.github.com/user', 'https://api.github.com/repos/team/paper'])
})

it.each(failures)('preserves both nested failure phases without returning identity: $label', async scenario => {
  const fixture = prepareFailure(scenario)
  const error = await caught(verifyGitHub(target, token))
  assertSafe(error, scenario.primary, scenario.cleanup)
  expect(fixture.returned).toHaveBeenCalledTimes(1)
  expect(provider.close).toHaveBeenCalledTimes(1)
  expect(provider.open).toHaveBeenCalledTimes(scenario.malformed || scenario.bodyFailed ? 1 : 2)
})

it('does not start the next API, transfer close or identity publication before pending API cleanup settles', async () => {
  const fixture = ready()
  const bodyClosed = deferred<IteratorResult<Uint8Array>>()
  const transferClosed = deferred<void>()
  fixture.identity.returned.mockImplementation(() => bodyClosed.promise)
  provider.close.mockImplementation(() => transferClosed.promise)
  const pending = track(verifyGitHub(target, token))
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.identity.returned).toHaveBeenCalledTimes(1)
  expect(provider.open).toHaveBeenCalledTimes(1)
  expect(provider.close).not.toHaveBeenCalled()
  expect(pending.done).toBe(false)
  bodyClosed.reject(new Error(token))
  await vi.advanceTimersByTimeAsync(0)
  expect(provider.close).toHaveBeenCalledTimes(1)
  expect(pending.done).toBe(false)
  transferClosed.resolve(undefined)
  assertSafe(await pending.result, false, true)
})

it.each(failures)('feeds actual Scope and manager sticky close-veto correctly: $label', async scenario => {
  prepareFailure(scenario)
  const manager = new WorkspaceRepositoryTransfer(() => undefined)
  const error = await caught(manager.run('connect', signal => withRepositoryOperation({ signal }, scope =>
    scope.step(() => verifyGitHub(target, token, { signal: scope.signal })))))
  expect(error).toBeInstanceOf(RepositoryOperationError)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: scenario.cleanup })
  expect(manager.status().phase).toBe('settled')
  expect(manager.isActive()).toBe(false)
  const mainClose = vi.fn()
  try { manager.assertCloseReady(); mainClose() } catch { /* Synthetic Main close gate preserves the workspace. */ }
  expect(mainClose).toHaveBeenCalledTimes(scenario.cleanup ? 0 : 1)
  if (scenario.cleanup) await expect(manager.cancelAndWait()).rejects.toThrow('清理')
  else await expect(manager.cancelAndWait()).resolves.toMatchObject({ phase: 'settled' })
  expect(provider.close).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('a caller catch cannot erase a known API cleanup failure or allow a later mutation', async () => {
  const fixture = ready()
  fixture.identity.returned.mockRejectedValue(new Error(token))
  const manager = new WorkspaceRepositoryTransfer(() => undefined)
  const mutate = vi.fn(async () => 'must not run')
  const error = await caught(manager.run('connect', signal => withRepositoryOperation({ signal }, async scope => {
    try { await scope.step(() => verifyGitHub(target, token, { signal: scope.signal })) } catch { /* Cannot erase the latch. */ }
    try { await scope.mutate(mutate) } catch { /* Even a second catch cannot clear it. */ }
    return 'not publishable'
  })))
  expect(error).toMatchObject({ cleanupFailed: true, localChangesMayExist: false })
  expect(mutate).not.toHaveBeenCalled()
  expect(() => manager.assertCloseReady()).toThrow('清理')
})

it('allows explicit local recovery after a primary-only verification failure with confirmed cleanup', async () => {
  provider.responses.push(response('{').value)
  const manager = new WorkspaceRepositoryTransfer(() => undefined)
  const mutate = vi.fn(async () => 42)
  const value = await manager.run('connect', signal => withRepositoryOperation({ signal }, async scope => {
    try { await scope.step(() => verifyGitHub(target, token, { signal: scope.signal })) } catch { /* Explicit local fallback. */ }
    return scope.mutate(mutate)
  }))
  expect(value).toBe(42)
  expect(mutate).toHaveBeenCalledTimes(1)
  expect(() => manager.assertCloseReady()).not.toThrow()
})

it('does not inspect a failing provider error message, getters, prototype or forged cleanup fields', async () => {
  const trap = vi.fn(() => { throw new Error(token) })
  const failure = new Proxy({ cleanupFailed: true, flags: { cleanupFailed: true } }, { get: trap, getPrototypeOf: trap, ownKeys: trap })
  provider.open.mockRejectedValueOnce(failure)
  const error = await caught(verifyGitHub(target, token))
  assertSafe(error, true, false)
  expect(trap).not.toHaveBeenCalled()
  expect(provider.close).toHaveBeenCalledTimes(1)
})

it('actual transfer accepts valid JSON and numeric Content-Length with fixed headers and no identity token', async () => {
  provider.real = true
  const body = JSON.stringify(user)
  const replies = [new Response(body, { headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).byteLength) } }),
    new Response('{"default_branch":"main"}', { headers: { 'content-type': 'application/vnd.github+json' } })]
  const fetcher = vi.fn<typeof fetch>(async () => replies.shift()!)
  expect(await verifyGitHub(target, token, { fetcher })).toEqual({ login: 'alice', id: 42, branch: 'main' })
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).not.toContain(token)
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
  }
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('actual transfer reports malformed consumed JSON as primary-only after confirmed cleanup', async () => {
  provider.real = true
  const reply = new Response('{', { headers: { 'content-type': 'application/json' } })
  const fetcher = vi.fn<typeof fetch>(async () => reply)
  assertSafe(await caught(verifyGitHub(target, token, { fetcher })), true, false)
  expect(reply.body?.locked).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('actual transfer deadline plus rejected stream cancel propagates known cleanup failure, not a success certificate', async () => {
  provider.real = true
  const cancel = vi.fn(async () => { throw new Error(token) })
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'content-type': 'application/json' } }))
  const pending = track(verifyGitHub(target, token, { fetcher, limits: { clientMs: 40, requestMs: 20 } }))
  await vi.advanceTimersByTimeAsync(50)
  assertSafe(await pending.result, true, true)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('actual transfer parent cancellation with acknowledged stream cancel remains primary-only', async () => {
  provider.real = true
  const parent = new AbortController()
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ cancel })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }))
  const pending = track(verifyGitHub(target, token, { fetcher, signal: parent.signal }))
  await vi.advanceTimersByTimeAsync(0)
  parent.abort()
  assertSafe(await pending.result, true, false)
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('actual two-endpoint identity requests still share one cumulative request budget', async () => {
  provider.real = true
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(user), { headers: { 'content-type': 'application/json' } }))
  assertSafe(await caught(verifyGitHub(target, token, { fetcher, limits: { requests: 1 } })), true, false)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it.each([`${target.url}/info/refs?service=git-receive-pack`, `${target.url}/git-receive-pack`])('ordinary GitHubError/readOnly policy is unchanged before network: %s', async url => {
  provider.real = true
  const fetcher = vi.fn<typeof fetch>()
  const client = githubHttp(target, token, { fetcher, readOnly: true })
  try {
    const error = await caught(client.request({ url, method: url.endsWith('/git-receive-pack') ? 'POST' : 'GET' }))
    expect(error).toBeInstanceOf(GitHubError)
    expect(readVerificationLifecycleFailure(error)).toBeNull()
    expect(String(error)).toContain('只读')
    expect(fetcher).not.toHaveBeenCalled()
  } finally { await client.close() }
  expect(vi.getTimerCount()).toBe(0)
})
