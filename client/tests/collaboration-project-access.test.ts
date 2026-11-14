import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubAccountService, type ReadonlyProjectAccess } from '../src/main/collaboration/service'
import { RepositoryOperationError, readRepositoryOperationFailure, withRepositoryOperation } from '../src/main/github/repository-operation'
import { readVerificationLifecycleFailure, withVerificationLifecycle } from '../src/main/github/verification-lifecycle'
import { CollaborationTransport } from '../src/main/collaboration/transport'
import type { GitHubTarget } from '../src/main/github/remote-policy'
import type { TransferOptions } from '../src/main/github/transport'

// Definitions only: UNRUN. Main-only source with synthetic Fetch/streams/promises; no Git/FS,
// accounts, Vault, UI, Node execution or Native proof. The optional close hook is test-only.
const audit = vi.hoisted(() => ({ failClose: false, holdClose: null as Promise<void> | null, closed: vi.fn(),
  created: [] as Array<{ url: string; readOnly: boolean | undefined; signal: AbortSignal | undefined }> }))
vi.mock('../src/main/github/transport', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/github/transport')>()
  return { ...actual, githubHttp: (target: GitHubTarget, token: string, options: TransferOptions = {}) => {
    const client = actual.githubHttp(target, token, options)
    audit.created.push({ url: target.url, readOnly: options.readOnly, signal: options.signal })
    return { request: client.request, close: async () => {
      audit.closed()
      await client.close()
      if (audit.holdClose) await audit.holdClose
      if (audit.failClose) throw new Error('ghu_fixture-only-close-secret')
    } }
  } }
})
const token = 'ghu_fixture-only-memory-secret'
const user = { id: 123, login: 'lab-user', name: 'Lab User', email: 'never-in-capability@example.invalid' }
const device = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const services: GitHubAccountService[] = []
const releases: Array<() => void> = []
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = () => done() })
  releases.push(() => resolve())
  return { promise, resolve }
}
async function flush(): Promise<void> { for (let i = 0; i < 250; i++) await Promise.resolve() }
function track(promise: Promise<unknown>) {
  const state = { done: false, result: Promise.resolve<unknown>(undefined) }
  state.result = promise.then(value => { state.done = true; return value }, (error: unknown) => { state.done = true; return error })
  return state
}
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try { await promise } catch (error) { return error }
  throw new Error('Expected a synthetic failure')
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}
function repo(extra: Record<string, unknown> = {}) {
  return { id: 42, name: 'paper', private: true, owner: { login: 'lab-team' }, ...extra }
}
interface Server { profile: unknown; installations: unknown; repositories: unknown; detail: unknown }
type FetchHook = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined
function fixture(hook?: FetchHook) {
  let clock = 100000
  const server: Server = { profile: user, installations: { total_count: 1, installations: [{ id: 17 }] },
    repositories: { total_count: 1, repositories: [repo()] }, detail: { ...repo(), default_branch: 'papers/default' } }
  const reply = (value: unknown) => value instanceof Response ? value : json(value)
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    const custom = hook?.(url, init)
    if (custom !== undefined) return custom
    if (url.href === 'https://github.com/login/device/code') return json(device)
    if (url.href === 'https://github.com/login/oauth/access_token') return json({ access_token: token, token_type: 'bearer', expires_in: 300, refresh_token: 'ignored-refresh-secret' })
    if (url.href === 'https://api.github.com/user') return reply(server.profile)
    if (url.pathname === '/user/installations') return reply(server.installations)
    if (/^\/user\/installations\/[0-9]+\/repositories$/.test(url.pathname)) return reply(server.repositories)
    if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/lab-team/')) return reply(server.detail)
    if (url.origin === 'https://github.com' && url.pathname.startsWith('/lab-team/')) return new Response('git-pack')
    throw new Error('Unexpected synthetic endpoint')
  })
  const service = new GitHubAccountService({ clientId: 'Iv1.project-access-fixture', fetcher, now: () => clock,
    sleep: async ms => { clock += ms } })
  services.push(service)
  return { service, server, fetcher, advanceClock: (ms: number) => { clock += ms } }
}
async function signedIn(hook?: FetchHook) {
  const result = fixture(hook)
  result.service.startLogin()
  await flush()
  expect(result.service.status().phase).toBe('signed-in')
  return result
}
function access(value: ReadonlyProjectAccess | undefined): ReadonlyProjectAccess {
  if (!value) throw new Error('Expected a captured fixture capability')
  return value
}
async function knownCleanup(): Promise<RepositoryOperationError> {
  const error = await caught(withRepositoryOperation({}, async scope => {
    scope.own({ close: async () => { throw new Error(token) } })
  }))
  if (!(error instanceof RepositoryOperationError) || readRepositoryOperationFailure(error)?.cleanupFailed !== true) throw new Error('Expected genuine completed Scope failure')
  return error
}
async function* binary(...chunks: Uint8Array[]): AsyncIterableIterator<Uint8Array> { for (const chunk of chunks) yield chunk }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  audit.failClose = false; audit.holdClose = null; audit.created.length = 0; audit.closed.mockClear()
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(services.splice(0).map(service => service.logout()))
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers(); vi.restoreAllMocks()
})

it('leaves the unconfigured/signed-out public state unchanged and makes no authorization request', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const service = new GitHubAccountService({ clientId: null, fetcher })
  services.push(service)
  const callback = vi.fn(async () => 42)
  await expect(service.withProjectAccess(42, callback)).rejects.toThrow()
  expect(service.status()).toMatchObject({ phase: 'unconfigured', sessionOnly: true, account: null })
  expect(callback).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
})

it('refreshes exact authorization before publishing a frozen metadata-only capability', async () => {
  const { service, fetcher } = await signedIn()
  const value = await service.withProjectAccess(42, async lease => {
    expect(Object.keys(lease).sort()).toEqual(['account', 'branch', 'check', 'http', 'project', 'signal', 'target'])
    for (const item of [lease, lease.project, lease.account, lease.target, lease.http]) expect(Object.isFrozen(item)).toBe(true)
    expect(lease.project).toEqual({ id: 42, installationId: 17, owner: 'lab-team', name: 'paper', private: true })
    expect(lease.account).toEqual({ id: 123, login: 'lab-user', name: 'Lab User' })
    expect(lease.target.url).toBe('https://github.com/lab-team/paper.git')
    expect(lease.branch).toBe('papers/default')
    lease.check()
    return JSON.stringify(lease)
  })
  for (const secret of [token, 'ignored-refresh-secret', user.email]) expect(value).not.toContain(secret)
  expect(fetcher.mock.calls.slice(3).map(([url]) => String(url))).toEqual(['https://api.github.com/user',
    'https://api.github.com/user/installations?per_page=50&page=1',
    'https://api.github.com/user/installations/17/repositories?per_page=50&page=1', 'https://api.github.com/repos/lab-team/paper'])
  expect(audit.created).toHaveLength(1)
  expect(audit.created[0]?.readOnly).toBe(true)
  expect(audit.closed).toHaveBeenCalledTimes(1)
})

it('uses the supplied fetcher for read-only Git and preserves the actual public async iterator body protocol', async () => {
  const { service, fetcher } = await signedIn()
  await service.withProjectAccess(42, async lease => {
    expect(audit.created[0]?.signal).toBe(lease.signal)
    const before = fetcher.mock.calls.length
    for (const url of [`${lease.target.url}/info/refs?service=git-receive-pack`, `${lease.target.url}/git-receive-pack`]) {
      await expect(lease.http.request({ url, method: url.endsWith('/git-receive-pack') ? 'POST' : 'GET' })).rejects.toThrow('只读')
    }
    expect(fetcher).toHaveBeenCalledTimes(before)
    const response = await lease.http.request({ url: `${lease.target.url}/git-upload-pack`, method: 'POST', body: binary(new Uint8Array([3, 4])) })
    if (response.body) for await (const chunk of response.body) expect(chunk.byteLength).toBeGreaterThan(0)
    const last = fetcher.mock.calls.at(-1)
    expect(new Headers(last?.[1]?.headers).get('authorization')).toBe(`Basic ${btoa(`x-access-token:${token}`)}`)
    expect(last?.[1]).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' })
  })
})

it.each(['https://evil.invalid/lab-team/paper.git/info/refs?service=git-upload-pack',
  'https://github.com/other-team/paper.git/info/refs?service=git-upload-pack',
  'https://api.github.com/lab-team/paper.git/info/refs?service=git-upload-pack'])('does not grant an arbitrary host/repository URL capability: %s', async url => {
  const { service, fetcher } = await signedIn()
  await service.withProjectAccess(42, async lease => {
    const before = fetcher.mock.calls.length
    await expect(lease.http.request({ url })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(before)
  })
})

it('revokes retained HTTP and check after actual callback completion', async () => {
  const { service, fetcher } = await signedIn()
  const held: { value?: ReadonlyProjectAccess } = {}
  expect(await service.withProjectAccess(42, async lease => { held.value = lease; return 42 })).toBe(42)
  const lease = access(held.value)
  const before = fetcher.mock.calls.length
  expect(lease.signal.aborted).toBe(true)
  expect(() => lease.check()).toThrow()
  await expect(lease.http.request({ url: `${lease.target.url}/info/refs?service=git-upload-pack` })).rejects.toThrow()
  await expect(lease.http.close()).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(before)
})

it('keeps an actual repository name ending in .git distinct from a transport suffix', async () => {
  const { service, server, fetcher } = await signedIn()
  server.repositories = { total_count: 1, repositories: [repo({ name: 'paper.git' })] }
  server.detail = { ...repo({ name: 'paper.git' }), default_branch: 'main' }
  await service.withProjectAccess(42, async lease => {
    expect(lease.target).toEqual({ owner: 'lab-team', repository: 'paper.git', url: 'https://github.com/lab-team/paper.git.git' })
    await lease.http.request({ url: `${lease.target.url}/info/refs?service=git-upload-pack` })
  })
  expect(fetcher.mock.calls.map(([url]) => String(url))).toContain('https://api.github.com/repos/lab-team/paper.git')
  expect(fetcher.mock.calls.map(([url]) => String(url))).toContain('https://github.com/lab-team/paper.git.git/info/refs?service=git-upload-pack')
})

it.each([0, -1, 0.5, NaN, Infinity])('rejects nonpositive or noninteger project ID before async work: %s', async id => {
  const { service, fetcher } = await signedIn()
  const callback = vi.fn(async () => 42)
  const count = fetcher.mock.calls.length
  await expect(service.withProjectAccess(id, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(count)
})

it.each(['42', null, { valueOf: () => 42 }])('does not coerce a JavaScript caller project ID: %j', async id => {
  const { service, fetcher } = await signedIn()
  const callback = vi.fn(async () => 42)
  const before = fetcher.mock.calls.length
  // Reflect intentionally exercises invalid JavaScript input without widening the public signature.
  await expect(Reflect.apply(service.withProjectAccess, service, [id, callback])).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(before)
})

it.each([0, 120001, 0.5])('rejects an invalid timeout before a Scope can sign an error: %s', async timeoutMs => {
  const { service, fetcher } = await signedIn()
  const callback = vi.fn(async () => 42)
  const before = fetcher.mock.calls.length
  const error = await caught(service.withProjectAccess(42, callback, { timeoutMs }))
  expect(error).toBeInstanceOf(RepositoryOperationError)
  expect(readRepositoryOperationFailure(error)).toBeNull()
  expect(callback).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(before)
})

it.each([{ id: 999 }, { login: 'other-user' }])('requires fresh profile identity to match the captured session: %j', async change => {
  const { service, server } = await signedIn()
  server.profile = { ...user, ...change }
  const callback = vi.fn(async () => 42)
  await expect(service.withProjectAccess(42, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(audit.created).toHaveLength(0)
})

it.each([
  { total_count: 0, repositories: [] },
  { total_count: 2, repositories: [repo(), repo()] },
  { total_count: 501, repositories: [] },
  { total_count: 1, repositories: [repo({ owner: { login: '../escape' } })] },
  { total_count: 1, repositories: [repo({ name: '../escape' })] },
  { total_count: 1, repositories: [repo({ private: 'true' })] },
])('requires a complete safe bounded installation intersection: %j', async repositories => {
  const { service, server } = await signedIn()
  server.repositories = repositories
  const callback = vi.fn(async () => 42)
  await expect(service.withProjectAccess(42, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(audit.created).toHaveLength(0)
})

it.each([{ id: 99 }, { name: 'renamed' }, { owner: { login: 'other-team' } }, { private: false },
  { default_branch: '../escape' }, { default_branch: null }])('checks fixed repository detail against the fresh selected identity: %j', async change => {
  const { service, server, fetcher } = await signedIn()
  server.detail = { ...repo(), default_branch: 'main', ...change }
  const callback = vi.fn(async () => 42)
  await expect(service.withProjectAccess(42, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(audit.created).toHaveLength(0)
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://api.github.com/repos/lab-team/paper')
})

it('invalidates this device session immediately on a fresh metadata 401 without authorizing a callback', async () => {
  const { service, server } = await signedIn()
  server.detail = new Response('', { status: 401 })
  const callback = vi.fn(async () => 42)
  await expect(service.withProjectAccess(42, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
  expect(service.status()).toMatchObject({ phase: 'signed-out', account: null })
  expect(audit.created).toHaveLength(0)
})

it.each(['unchanged', 'name', 'privacy', 'installation'] as const)('binds an optional private project snapshot, including %s', async field => {
  const { service, server } = await signedIn()
  const listed = await service.projects()
  const first = listed[0]
  if (!first) throw new Error('Expected one validated fixture project')
  first.name = 'external-copy-mutation'
  if (field === 'name') server.repositories = { total_count: 1, repositories: [repo({ name: 'renamed' })] }
  if (field === 'privacy') server.repositories = { total_count: 1, repositories: [repo({ private: false })] }
  if (field === 'installation') server.installations = { total_count: 1, installations: [{ id: 19 }] }
  const callback = vi.fn(async () => 42)
  if (field === 'unchanged') {
    expect(await service.withProjectAccess(42, callback)).toBe(42)
    expect(callback).toHaveBeenCalledTimes(1)
  } else {
    await expect(service.withProjectAccess(42, callback)).rejects.toThrow()
    expect(callback).not.toHaveBeenCalled()
    expect(audit.created).toHaveLength(0)
  }
})

it('clears previous selection metadata on a generation change while retaining a valid cancelled-close session', async () => {
  const { service, server } = await signedIn()
  await service.projects()
  await service.cancelAndWait()
  expect(service.status().phase).toBe('signed-in')
  server.repositories = { total_count: 1, repositories: [repo({ name: 'new-name' })] }
  server.detail = { ...repo({ name: 'new-name' }), default_branch: 'main' }
  expect(await service.withProjectAccess(42, async lease => lease.project.name)).toBe('new-name')
})

it('keeps only one access in flight until the real callback settles', async () => {
  const { service, fetcher } = await signedIn()
  const held = gate()
  const first = track(service.withProjectAccess(42, async () => { await held.promise; return 42 }))
  await flush()
  const count = fetcher.mock.calls.length
  const second = vi.fn(async () => 99)
  await expect(service.withProjectAccess(42, second)).rejects.toThrow()
  expect(second).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(count)
  held.resolve()
  expect(await first.result).toBe(42)
})

it('does not let either parallel cancel return before the retained access callback and closes drain', async () => {
  const { service } = await signedIn()
  const held = gate()
  const pending = track(service.withProjectAccess(42, async () => { await held.promise; return 42 }))
  await flush()
  const first = track(service.cancelAndWait())
  const second = track(service.cancelAndWait())
  await flush()
  expect(first.done).toBe(false); expect(second.done).toBe(false); expect(pending.done).toBe(false)
  held.resolve()
  expect(await pending.result).toMatchObject({ cancelled: true, cleanupFailed: false })
  expect(await first.result).toMatchObject({ phase: 'signed-in' })
  expect(await second.result).toMatchObject({ phase: 'signed-in' })
  expect(service.status().account?.id).toBe(123)
})

it('lets concurrent logout clear immediately without cancel resurrecting it or starting a new login/access', async () => {
  const { service, fetcher } = await signedIn()
  const held = gate()
  const pending = track(service.withProjectAccess(42, async () => { await held.promise; return 42 }))
  await flush()
  const cancelled = track(service.cancelAndWait())
  const loggedOut = track(service.logout())
  expect(service.status()).toMatchObject({ phase: 'signed-out', account: null })
  const count = fetcher.mock.calls.length
  expect(service.startLogin().phase).toBe('signed-out')
  await expect(service.withProjectAccess(42, async () => 99)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(count)
  await flush()
  expect(cancelled.done).toBe(false); expect(loggedOut.done).toBe(false)
  held.resolve()
  expect(await pending.result).toMatchObject({ cancelled: true })
  expect(await cancelled.result).toMatchObject({ phase: 'signed-out', account: null })
  expect(await loggedOut.result).toMatchObject({ phase: 'signed-out', account: null })
})

it('keeps a completed callback in the draining set until its actual owned close acknowledges', async () => {
  const { service } = await signedIn()
  const close = gate()
  audit.holdClose = close.promise
  const pending = track(service.withProjectAccess(42, async () => 42))
  await flush()
  expect(audit.closed).toHaveBeenCalledTimes(1)
  expect(pending.done).toBe(false)
  const first = track(service.cancelAndWait())
  const second = track(service.cancelAndWait())
  await flush()
  expect(first.done).toBe(false); expect(second.done).toBe(false)
  close.resolve()
  expect(await pending.result).toMatchObject({ cancelled: true, cleanupFailed: false })
  expect(await first.result).toMatchObject({ phase: 'signed-in' })
  expect(await second.result).toMatchObject({ phase: 'signed-in' })
})

it('expiry aborts and retains an access for a later close drain rather than publishing the late value', async () => {
  const { service, advanceClock } = await signedIn()
  const held = gate()
  const pending = track(service.withProjectAccess(42, async () => { await held.promise; return 42 }))
  await flush()
  advanceClock(301000)
  expect(service.status()).toMatchObject({ phase: 'signed-out', account: null })
  const stopped = track(service.cancelAndWait())
  await flush()
  expect(stopped.done).toBe(false)
  held.resolve()
  expect(await pending.result).toMatchObject({ cancelled: true })
  expect(await stopped.result).toMatchObject({ phase: 'signed-out' })
})

it('checks session expiry again after a callback returns instead of publishing its stale value', async () => {
  const { service, advanceClock } = await signedIn()
  const error = await caught(service.withProjectAccess(42, async () => { advanceClock(301000); return 42 }))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: true, cancelled: true })
  expect(service.status().phase).toBe('signed-out')
})

it('snapshots the original parent and tightened timeout before asynchronous authorization begins', async () => {
  const { service } = await signedIn()
  const original = new AbortController()
  const replacement = new AbortController()
  const options = { signal: original.signal, timeoutMs: 20 }
  const held = gate()
  const pending = track(service.withProjectAccess(42, async () => { await held.promise; return 42 }, options))
  options.signal = replacement.signal; options.timeoutMs = 120000
  await flush()
  replacement.abort()
  await vi.advanceTimersByTimeAsync(21)
  expect(pending.done).toBe(false)
  held.resolve()
  expect(await pending.result).toMatchObject({ timedOut: true, cancelled: false, cleanupFailed: false })
  expect(service.status().phase).toBe('signed-in')
})

it('pre-aborted real parent signals perform no fresh authorization and do not poison the session', async () => {
  const { service, fetcher } = await signedIn()
  const parent = new AbortController(); parent.abort()
  const callback = vi.fn(async () => 42)
  const before = fetcher.mock.calls.length
  const error = await caught(service.withProjectAccess(42, callback, { signal: parent.signal }))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ cancelled: true, cleanupFailed: false })
  expect(fetcher).toHaveBeenCalledTimes(before)
  expect(callback).not.toHaveBeenCalled()
  expect((await service.cancelAndWait()).phase).toBe('signed-in')
})

it('records a real own-close failure before removal and rethrows it from every later close/logout', async () => {
  const { service } = await signedIn()
  audit.failClose = true
  const error = await caught(service.withProjectAccess(42, async () => 42))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: false, cleanupFailed: true })
  expect(String(error)).not.toContain('ghu_fixture-only-close-secret')
  await expect(service.cancelAndWait()).rejects.toBe(error)
  const logout = service.logout()
  expect(service.status()).toMatchObject({ phase: 'signed-out', account: null })
  await expect(logout).rejects.toBe(error)
  await expect(service.withProjectAccess(42, async () => 99)).rejects.toBe(error)
  expect(service.startLogin().phase).toBe('signed-out')
})

it.each(['repository', 'verification'] as const)('preserves genuine fresh-metadata %s cleanup before generic transport normalization', async kind => {
  const nested = kind === 'repository' ? await knownCleanup() : await caught(withVerificationLifecycle(async () => 42, async () => { throw new Error(token) }))
  let armed = false
  const { service, fetcher } = await signedIn(url => armed && url.href === 'https://api.github.com/user' ? Promise.reject(nested) : undefined)
  armed = true
  const before = fetcher.mock.calls.length
  const callback = vi.fn(async () => 42)
  const error = await caught(service.withProjectAccess(42, callback))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: true, cleanupFailed: true })
  expect(fetcher).toHaveBeenCalledTimes(before + 1)
  expect(callback).not.toHaveBeenCalled()
  expect(audit.created).toHaveLength(0)
  await expect(service.cancelAndWait()).rejects.toBe(error)
  await expect(service.logout()).rejects.toBe(error)
  expect(service.status()).toMatchObject({ phase: 'signed-out', account: null })
  expect(String(error)).not.toContain(token)
  expect(error).not.toHaveProperty('cause')
})

it.each(['plain', 'shape', 'constructor', 'prototype', 'proxy', 'cause'] as const)('does not infer metadata cleanup from an unbranded provider %s', async kind => {
  const genuine = await knownCleanup()
  const trap = vi.fn(() => { throw new Error(token) })
  const shaped = Object.defineProperties(Object.create(null), { cleanupFailed: { get: trap }, flags: { get: trap }, cause: { get: trap } })
  const forged = kind === 'plain' ? new Error(token) : kind === 'shape' ? shaped : kind === 'constructor' ?
    new RepositoryOperationError({ operationFailed: true, cleanupFailed: true, cancelled: false, timedOut: false,
      localChangesMayExist: false, remoteWriteMayHaveCompleted: false }) : kind === 'prototype' ? Object.create(genuine) :
      kind === 'proxy' ? new Proxy(genuine, { get: trap }) : { cause: genuine, flags: genuine.flags, cleanupFailed: true }
  expect(readRepositoryOperationFailure(forged)).toBeNull()
  expect(readVerificationLifecycleFailure(forged)).toBeNull()
  let armed = false
  const { service } = await signedIn(url => armed && url.href === 'https://api.github.com/user' ? Promise.reject(forged) : undefined)
  armed = true
  const callback = vi.fn(async () => 42)
  const error = await caught(service.withProjectAccess(42, callback))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect(callback).not.toHaveBeenCalled()
  expect(trap).not.toHaveBeenCalled()
  expect(String(error)).not.toContain(token)
  expect((await service.cancelAndWait()).phase).toBe('signed-in')
  armed = false
  expect(await service.withProjectAccess(42, async () => 99)).toBe(99)
})

it.each(['repository', 'verification'] as const)('keeps already-observed metadata %s cleanup when parent cancellation is queued before catch', async kind => {
  const nested = kind === 'repository' ? await knownCleanup() : await caught(withVerificationLifecycle(async () => 42, async () => { throw new Error(token) }))
  const parent = new AbortController()
  const fetcher = vi.fn<typeof fetch>(() => {
    // The first microtask lets abortable observe the rejection; the second aborts before request.catch.
    queueMicrotask(() => queueMicrotask(() => parent.abort()))
    return Promise.reject(nested)
  })
  const transport = new CollaborationTransport(fetcher)
  const error = await caught(transport.profile(token, parent.signal))
  expect(parent.signal.aborted).toBe(true)
  expect(error).toBe(nested)
  const flags = kind === 'repository' ? readRepositoryOperationFailure(error) : readVerificationLifecycleFailure(error)
  expect(flags?.cleanupFailed).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(String(error)).not.toContain(token)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['repository', 'verification'] as const)('preserves genuine nested %s cleanup through the new Scope and sticky service veto', async kind => {
  const { service } = await signedIn()
  const nested = kind === 'repository' ? await knownCleanup() : await caught(withVerificationLifecycle(async () => 42, async () => { throw new Error(token) }))
  const error = await caught(service.withProjectAccess(42, async () => { throw nested }))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: true, cleanupFailed: true })
  await expect(service.cancelAndWait()).rejects.toBe(error)
  expect(String(error)).not.toContain(token)
  expect(error).not.toHaveProperty('cause')
})

it.each(['constructor', 'prototype', 'proxy', 'cause'] as const)('never brands or sticky-poisons a forged provider %s', async kind => {
  const { service } = await signedIn()
  const genuine = await knownCleanup()
  const trap = vi.fn(() => { throw new Error(token) })
  const forged = kind === 'constructor' ? new RepositoryOperationError({ operationFailed: true, cleanupFailed: true, cancelled: false,
    timedOut: false, localChangesMayExist: false, remoteWriteMayHaveCompleted: false }) : kind === 'prototype' ? Object.create(genuine) :
    kind === 'proxy' ? new Proxy(genuine, { get: trap, getPrototypeOf: trap, ownKeys: trap }) : { cause: genuine, flags: genuine.flags, cleanupFailed: true }
  expect(readRepositoryOperationFailure(forged)).toBeNull()
  const error = await caught(service.withProjectAccess(42, async () => { throw forged }))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect(trap).not.toHaveBeenCalled()
  expect((await service.cancelAndWait()).phase).toBe('signed-in')
  expect(await service.withProjectAccess(42, async () => 99)).toBe(99)
})

it('does not poison a valid session after a plain primary-only callback failure', async () => {
  const { service } = await signedIn()
  const error = await caught(service.withProjectAccess(42, async () => { throw new Error(token) }))
  expect(readRepositoryOperationFailure(error)).toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect((await service.cancelAndWait()).phase).toBe('signed-in')
  expect(await service.withProjectAccess(42, async () => 99)).toBe(99)
})
