import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitHubAccountService, type ReadonlyProjectAccess } from '../src/main/collaboration/service'
import { assertWritableProjectAccess } from '../src/main/collaboration/project-access'
import { readRepositoryOperationFailure } from '../src/main/github/repository-operation'

// Synthetic Fetch/Git-protocol only: no real account, permissions, network writes, Vault or install proof.
const audit = vi.hoisted(() => ({ failClose: false }))
vi.mock('../src/main/github/transport', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/github/transport')>()
  return { ...actual, githubHttp: (...args: Parameters<typeof actual.githubHttp>) => {
    const client = actual.githubHttp(...args)
    return { request: client.request, close: async () => { await client.close(); if (audit.failClose) throw new Error('fixture-secret') } }
  } }
})
const token = 'ghu_fixture_only_session_secret'
const user = { id: 7, login: 'lab-user', name: 'Lab User' }
const repository = { id: 42, owner: { login: 'lab-user' }, name: 'paper', private: true }
const prompt = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const services: GitHubAccountService[] = []
const releases: Array<() => void> = []
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
function inviteRow(extra: Record<string, unknown> = {}) {
  return { id: 88, repository, invitee: { id: user.id, login: user.login }, inviter: { login: 'lab-owner' }, ...extra }
}
function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function flush() { for (let i = 0; i < 300; i++) await Promise.resolve() }
async function caught(promise: Promise<unknown>): Promise<unknown> {
  try { await promise } catch (error) { return error }
  throw new Error('Expected fixture failure')
}
type Hook = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined
async function signedIn(hook?: Hook) {
  let clock = 100000
  const server = { profile: { ...user }, repositories: [repository] as unknown[], detail: { ...repository, default_branch: 'main', permissions: { push: true, admin: true } },
    created: { ...repository } as unknown, invitations: [inviteRow()] as unknown[] }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), custom = hook?.(url, init)
    if (custom !== undefined) return custom
    if (url.pathname === '/login/device/code') return json(prompt)
    if (url.pathname === '/login/oauth/access_token') return json({ access_token: token, token_type: 'bearer', expires_in: 300 })
    if (url.pathname === '/user') return json(server.profile)
    if (url.pathname === '/user/installations') return json({ total_count: 1, installations: [{ id: 17 }] })
    if (url.pathname === '/user/installations/17/repositories') return json({ total_count: server.repositories.length, repositories: server.repositories })
    if (url.pathname === '/user/repos' && init?.method === 'POST') return json(server.created, 201)
    if (url.pathname === '/user/repository_invitations') return json(server.invitations)
    if (url.pathname === '/user/repository_invitations/88' && init?.method === 'PATCH') return new Response(null, { status: 204 })
    if (url.pathname === '/repos/lab-user/paper/collaborators/alice') return json(inviteRow({ invitee: { login: 'alice' } }), 201)
    if (url.pathname === '/repos/lab-user/paper') return json(server.detail)
    if (url.origin === 'https://github.com' && url.pathname.startsWith('/lab-user/paper.git/')) return new Response('fixture-pack')
    throw new Error(`Unexpected fixture ${url.pathname}`)
  })
  const service = new GitHubAccountService({ clientId: 'Iv1.actions-fixture', fetcher, now: () => clock, sleep: async ms => { clock += ms } })
  services.push(service); service.startLogin(); await flush()
  expect(service.status().phase).toBe('signed-in')
  return { service, fetcher, server, advance: (ms: number) => { clock += ms } }
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); audit.failClose = false })
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(services.splice(0).map(value => value.logout()))
  vi.useRealTimers(); vi.restoreAllMocks()
})

it('keeps unconfigured actions offline and refuses every write capability', async () => {
  const fetcher = vi.fn<typeof fetch>(), service = new GitHubAccountService({ clientId: null, fetcher }); services.push(service)
  for (const action of [() => service.createPrivateProject('paper'), () => service.invitations(), () => service.inviteCollaborator(42, 'alice'),
    () => service.projectForLink('https://github.com/lab-user/paper'), () => service.withWritableProjectAccess(42, async () => 1)]) {
    await expect(action()).rejects.toThrow()
  }
  expect(fetcher).not.toHaveBeenCalled()
})
it.each(['../paper', '', 'a b', 'paper?token=x', '.', '..', 'a'.repeat(101)])('rejects unsafe create name before any request: %s', async name => {
  const { service, fetcher } = await signedIn(), before = fetcher.mock.calls.length
  await expect(service.createPrivateProject(name)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(before)
})
it('creates only a private empty repository and returns a token-free installation intersection result', async () => {
  const { service, fetcher } = await signedIn()
  expect(await service.createPrivateProject('paper')).toEqual({ id: 42, owner: 'lab-user', name: 'paper', private: true, accessible: true })
  const [, init] = fetcher.mock.calls.find(([url]) => String(url).endsWith('/user/repos'))!
  expect(JSON.parse(String(init?.body))).toEqual({ name: 'paper', private: true, auto_init: false })
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
  expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' })
  expect(JSON.stringify(service.status())).not.toContain(token)
  expect(fetcher.mock.calls.filter(([, value]) => ['POST', 'PUT', 'PATCH'].includes(value?.method ?? '')).map(([url]) => String(url)))
    .toEqual(['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user/repos'])
})
it.each([false, undefined, 'true'])('does not discover, associate, upload or patch visibility when create private is %s', async value => {
  const { service, server, fetcher } = await signedIn(); server.created = { ...repository, private: value }
  const error = await caught(service.createPrivateProject('paper'))
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('https://api.github.com/user/repos')
  expect(String(error)).not.toContain(token)
})
it.each([{ name: 'other' }, { owner: { login: 'other-user' } }, { id: 0 }])('rejects a mismatched create acknowledgement %j', async change => {
  const { service, server } = await signedIn(); server.created = { ...repository, ...change }
  await expect(service.createPrivateProject('paper')).rejects.toThrow()
})
it('reports a created repository outside the selected installation without broadening installation scope', async () => {
  const { service, server, fetcher } = await signedIn(); server.repositories = []
  expect(await service.createPrivateProject('paper')).toMatchObject({ private: true, accessible: false })
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})
it('does not retry an uncertain create acknowledgement and preserves a remote-write warning', async () => {
  const { service, fetcher } = await signedIn((url, init) => {
    if (url.pathname === '/user/repos' && init?.method === 'POST') return Promise.reject(new Error(token))
  })
  const error = await caught(service.createPrivateProject('paper'))
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(String(error)).toContain('不要自动重试')
  expect(String(error)).not.toContain(token)
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/user/repos'))).toHaveLength(1)
})
it('waits for an actual in-flight write Fetch on logout even if a synthetic provider ignores abort', async () => {
  const held = gate<Response>(); releases.push(() => held.resolve(json(repository, 201)))
  const { service } = await signedIn(url => url.pathname === '/user/repos' ? held.promise : undefined)
  const action = service.createPrivateProject('paper').catch(error => error); await flush()
  let done = false
  const stopping = service.logout().then(() => { done = true }); await flush()
  expect(done).toBe(false)
  held.resolve(json(repository, 201)); await stopping
  expect(readRepositoryOperationFailure(await action)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(service.status().phase).toBe('signed-out')
})
it('logs out on a write 401 and returns no provider response fields', async () => {
  const { service } = await signedIn(url => url.pathname === '/user/repos' ? json({ token }, 401) : undefined)
  const error = await caught(service.createPrivateProject('paper'))
  expect(service.status().phase).toBe('signed-out')
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(String(error)).not.toContain(token)
})
it('issues only session-bound opaque private invitations, rechecks and accepts a 204 acknowledgement', async () => {
  const { service, fetcher } = await signedIn()
  const [item] = await service.invitations(); expect(item).toBeDefined()
  expect(item).toMatchObject({ projectId: 42, owner: 'lab-user', name: 'paper', inviter: 'lab-owner' })
  expect(JSON.stringify(item)).not.toContain(token)
  expect(item!.handle).toMatch(/^psi\./)
  expect(await service.acceptInvitation(item!.handle)).toMatchObject({ id: 42, private: true, accessible: true })
  await expect(service.acceptInvitation(item!.handle)).rejects.toThrow('选择已失效')
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
})
it('accepts membership but does not pretend an uninstalled project became accessible', async () => {
  const { service, server } = await signedIn(), [item] = await service.invitations(); server.repositories = []
  expect(await service.acceptInvitation(item!.handle)).toMatchObject({ accessible: false })
})
it.each(['removed', 'renamed', 'different-invitee'])('does not accept stale or changed invitation: %s', async change => {
  const { service, server, fetcher } = await signedIn(), [item] = await service.invitations()
  server.invitations = change === 'removed' ? [] : [change === 'renamed' ? inviteRow({ repository: { ...repository, name: 'renamed' } }) : inviteRow({ invitee: { id: 999 } })]
  await expect(service.acceptInvitation(item!.handle)).rejects.toThrow()
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
})
it('invalidates invitation handles at expiry and logout, and refresh only replaces them on success', async () => {
  const { service } = await signedIn(), [item] = await service.invitations()
  vi.advanceTimersByTime(10 * 60 * 1000)
  await expect(service.acceptInvitation(item!.handle)).rejects.toThrow()
})
it('refuses forged invitation IDs and handles from another session without PATCH', async () => {
  const first = await signedIn(), [item] = await first.service.invitations(), second = await signedIn()
  for (const handle of ['88', 'psi.not-a-real-handle', item!.handle]) await expect(second.service.acceptInvitation(handle)).rejects.toThrow()
  expect(second.fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
})
it('requires repository administrator permission before inviting another account', async () => {
  const { service, server, fetcher } = await signedIn(); server.detail.permissions.admin = false
  await expect(service.inviteCollaborator(42, 'alice')).rejects.toThrow()
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})
it('invites a named collaborator with push only and never a credential-bearing or permission-granting URL', async () => {
  const { service, fetcher } = await signedIn()
  expect(await service.inviteCollaborator(42, 'alice')).toEqual({ owner: 'lab-user', name: 'paper', login: 'alice', status: 'invited' })
  const [url, init] = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')!
  expect(url).toBe('https://api.github.com/repos/lab-user/paper/collaborators/alice')
  expect(JSON.parse(String(init?.body))).toEqual({ permission: 'push' })
})
it('rejects an invitation acknowledgement for another repository ID without retrying the write', async () => {
  const { service, fetcher } = await signedIn(url => url.pathname.endsWith('/collaborators/alice') ? json(inviteRow({
    repository: { ...repository, id: 99 }, invitee: { login: 'alice' },
  }), 201) : undefined)
  const error = await caught(service.inviteCollaborator(42, 'alice'))
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1)
})
it('handles an already-authorized collaborator 204 without parsing JSON', async () => {
  const { service } = await signedIn(url => url.pathname.endsWith('/collaborators/alice') ? new Response(null, { status: 204 }) : undefined)
  expect(await service.inviteCollaborator(42, 'alice')).toMatchObject({ status: 'already-authorized' })
})
it.each(['https://evil.invalid/lab-user/paper', 'https://token@github.com/lab-user/paper', 'https://github.com/lab-user/paper?token=x', 'https://github.com/lab-user/paper#grant'])('rejects unsafe sharing link before discovery: %s', async link => {
  const { service, fetcher } = await signedIn(), before = fetcher.mock.calls.length
  await expect(service.projectForLink(link)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(before)
})
it('a sharing link only matches freshly authorized App installation access and consumes selection once', async () => {
  const { service, server, fetcher } = await signedIn()
  server.repositories = []
  await expect(service.projectForLink('https://github.com/lab-user/paper')).rejects.toThrow()
  server.repositories = [repository]
  const selection = await service.projectForLink('https://github.com/lab-user/paper')
  expect(await service.withSelectedProjectAccess(selection.handle, async access => access.project.id)).toBe(42)
  await expect(service.withSelectedProjectAccess(selection.handle, async () => 1)).rejects.toThrow()
  expect(fetcher.mock.calls.some(([, init]) => ['PUT', 'PATCH'].includes(init?.method ?? ''))).toBe(false)
})
it('preserves a real .git-ending repository sharing link without selecting another accessible repository', async () => {
  const { service, server } = await signedIn()
  server.repositories = [repository, { ...repository, id: 43, name: 'paper.git' }]
  const selected = await service.projectForLink('https://github.com/lab-user/paper.git')
  expect(selected.project).toMatchObject({ id: 43, name: 'paper.git' })
})
it('does not silently upgrade a readonly capability or a copied mode field', async () => {
  const { service } = await signedIn()
  await service.withProjectAccess(42, async access => {
    expect('mode' in access).toBe(false)
    expect(() => assertWritableProjectAccess(access)).toThrow()
    expect(() => assertWritableProjectAccess({ ...access, mode: 'write' } as ReadonlyProjectAccess)).toThrow()
    await expect(access.http.request({ url: `${access.target.url}/git-receive-pack`, method: 'POST' })).rejects.toThrow('只读')
  })
})
it('does not grant a copied capability when a provider changes the global WeakMap prototype', async () => {
  const { service } = await signedIn()
  await service.withWritableProjectAccess(42, async access => {
    const copied = { ...access }
    const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, 'get')
    if (!original) throw new Error('Missing native WeakMap fixture descriptor')
    Reflect.defineProperty(WeakMap.prototype, 'get', { ...original, value: () => true })
    let granted = false
    try { assertWritableProjectAccess(copied); granted = true } catch { /* Expected private identity rejection. */ }
    finally { Reflect.defineProperty(WeakMap.prototype, 'get', original) }
    expect(granted).toBe(false)
    assertWritableProjectAccess(access)
  })
})
it.each([{ push: false, admin: false }, { push: 'true', admin: false }, null])('refuses write access without explicit push/admin authority: %j', async permissions => {
  const { service, server } = await signedIn(); Reflect.set(server.detail, 'permissions', permissions)
  const callback = vi.fn(async () => 1)
  await expect(service.withWritableProjectAccess(42, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
})
it('revokes the issued write brand after actual callback completion and confines it to the selected repository', async () => {
  const { service, fetcher } = await signedIn(); let retained: ReadonlyProjectAccess | undefined
  await service.withWritableProjectAccess(42, async access => {
    retained = access; assertWritableProjectAccess(access); expect(access.mode).toBe('write')
    const before = fetcher.mock.calls.length
    await expect(access.http.request({ url: 'https://github.com/other/paper.git/git-receive-pack', method: 'POST' })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(before)
    const response = await access.http.request({ url: `${access.target.url}/git-receive-pack`, method: 'POST' })
    if (response.body) for await (const chunk of response.body) expect(chunk.byteLength).toBeGreaterThan(0)
  })
  expect(() => assertWritableProjectAccess(retained!)).toThrow()
})
it('brands receive-pack uncertainty but not a rejected cross-repository or readonly write', async () => {
  const { service } = await signedIn((url, init) => url.pathname.endsWith('/git-receive-pack') && init?.method === 'POST' ? Promise.reject(new Error(token)) : undefined)
  const error = await caught(service.withWritableProjectAccess(42, access => access.http.request({ url: `${access.target.url}/git-receive-pack`, method: 'POST' })))
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(String(error)).not.toContain(token)
})
it('preserves cleanup veto from an admin access operation and blocks later actions', async () => {
  const { service, fetcher } = await signedIn(); audit.failClose = true
  const error = await caught(service.inviteCollaborator(42, 'alice'))
  expect(readRepositoryOperationFailure(error)?.cleanupFailed).toBe(true)
  const before = fetcher.mock.calls.length
  expect(await caught(service.createPrivateProject('paper'))).toBe(error)
  expect(fetcher).toHaveBeenCalledTimes(before)
})
it('latches an actual mutation-response body cleanup failure and refuses subsequent cloud actions', async () => {
  const { service, fetcher } = await signedIn(url => url.pathname === '/user/repos' ? new Response(new ReadableStream<Uint8Array>({
    cancel: async () => { throw new Error(token) },
  }), { status: 201, headers: { 'content-type': 'text/plain' } }) : undefined)
  const error = await caught(service.createPrivateProject('paper'))
  expect(readRepositoryOperationFailure(error)?.cleanupFailed).toBe(true)
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).toBe(true)
  expect(String(error)).not.toContain(token)
  const before = fetcher.mock.calls.length
  expect(await caught(service.invitations())).toBe(error)
  expect(fetcher).toHaveBeenCalledTimes(before)
})
it('awaits mutation-response body cancellation before logout settles', async () => {
  const held = gate<void>(); releases.push(() => held.resolve())
  const { service } = await signedIn(url => url.pathname === '/user/repos' ? new Response(new ReadableStream<Uint8Array>({
    cancel: () => held.promise,
  }), { status: 201, headers: { 'content-type': 'text/plain' } }) : undefined)
  const action = service.createPrivateProject('paper').catch(error => error); await flush()
  let done = false
  const stopping = service.logout().then(() => { done = true }); await flush()
  expect(done).toBe(false)
  held.resolve(); await stopping
  expect(readRepositoryOperationFailure(await action)?.remoteWriteMayHaveCompleted).toBe(true)
})
it('keeps a fresh write request out of public repositories even when push permission is true', async () => {
  const { service, server } = await signedIn()
  server.repositories = [{ ...repository, private: false }]
  Reflect.set(server.detail, 'private', false)
  const callback = vi.fn(async () => 1)
  await expect(service.withWritableProjectAccess(42, callback)).rejects.toThrow()
  expect(callback).not.toHaveBeenCalled()
})
it('allows an explicit administrator write lease but never a copied structural capability', async () => {
  const { service, server } = await signedIn(); server.detail.permissions.push = false
  await service.withWritableProjectAccess(42, async access => {
    assertWritableProjectAccess(access, true)
    expect(() => assertWritableProjectAccess({ ...access })).toThrow()
  })
})
it('checks a refreshed profile before a mutation and never sends a write for another account', async () => {
  const { service, server, fetcher } = await signedIn(); server.profile.id = 999
  await expect(service.createPrivateProject('paper')).rejects.toThrow()
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/user/repos'))).toBe(false)
})
it('does not accept public invitation links as private invitation permissions', async () => {
  const { service, server } = await signedIn()
  server.invitations = [inviteRow({ repository: { ...repository, private: false } })]
  expect(await service.invitations()).toEqual([])
})
it('captures a synchronous secret-free session guard without making requests or changing public state', async () => {
  const { service, fetcher } = await signedIn(), before = fetcher.mock.calls.length, state = service.status()
  const guard = service.captureSessionGuard()
  expect(guard()).toBeUndefined(); expect(guard()).toBeUndefined()
  expect(Object.keys(guard)).toEqual([]); expect(JSON.stringify(guard)).toBeUndefined()
  expect(service.status()).toEqual(state); expect(fetcher).toHaveBeenCalledTimes(before)
  const offline = new GitHubAccountService({ clientId: null, fetcher }); services.push(offline)
  expect(() => offline.captureSessionGuard()).toThrow('请先登录')
})
it('rejects a captured guard immediately on logout and after the same account signs in again', async () => {
  const { service } = await signedIn(), guard = service.captureSessionGuard(), previous = service.status().account
  const stopping = service.logout()
  expect(guard).toThrow(); await stopping
  expect(guard).toThrow(); expect(() => service.captureSessionGuard()).toThrow('请先登录')
  service.startLogin(); await flush()
  expect(service.status().account).toEqual(previous)
  expect(guard).toThrow(); expect(service.captureSessionGuard()()).toBeUndefined()
})
it.each(['wall', 'monotonic'] as const)('rejects a captured guard after independent %s clock expiry', async clock => {
  const { service, advance } = await signedIn(), guard = service.captureSessionGuard()
  if (clock === 'wall') advance(300001)
  else vi.spyOn(performance, 'now').mockReturnValue(1_000_000)
  expect(guard).toThrow(); expect(service.status().phase).toBe('signed-out')
  expect(() => service.captureSessionGuard()).toThrow('请先登录')
})
it('invalidates pre-stop guards even when cancellation retains the same signed-in memory session', async () => {
  const { service } = await signedIn(), guard = service.captureSessionGuard(), held = gate<void>()
  releases.push(() => held.resolve())
  const action = service.withProjectAccess(42, async () => held.promise).catch(error => error); await flush()
  let stopped = false
  const stopping = service.cancelAndWait().then(() => { stopped = true }); await flush()
  expect(stopped).toBe(false); expect(guard).toThrow(); expect(() => service.captureSessionGuard()).toThrow()
  held.resolve(); await action; await stopping
  expect(service.status().phase).toBe('signed-in'); expect(guard).toThrow()
  expect(service.captureSessionGuard()()).toBeUndefined()
})
it('vetoes an otherwise current session guard after a genuine owned-client cleanup failure', async () => {
  const { service } = await signedIn(), guard = service.captureSessionGuard(); audit.failClose = true
  const error = await caught(service.withProjectAccess(42, async () => undefined))
  expect(readRepositoryOperationFailure(error)?.cleanupFailed).toBe(true)
  try { guard(); throw new Error('Expected guard failure') } catch (actual) { expect(actual).toBe(error) }
  try { service.captureSessionGuard(); throw new Error('Expected capture failure') } catch (actual) { expect(actual).toBe(error) }
})
it.each([{ owner: 'other-owner', name: 'paper' }, { owner: 'lab-user', name: 'renamed-paper' }])(
  'refuses invitation PUT when fresh admin access differs from the confirmed target %j', async expected => {
    const { service, fetcher } = await signedIn()
    const error = await caught(service.inviteCollaborator(42, 'alice', {}, expected))
    expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).not.toBe(true)
    expect(String(error)).not.toContain(token)
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })
it('refuses an invitation after the remote repository is renamed while retaining the same repository ID', async () => {
  const renamed = { ...repository, name: 'renamed-paper', default_branch: 'main', permissions: { push: true, admin: true } }
  const { service, server, fetcher } = await signedIn(url => url.pathname === '/repos/lab-user/renamed-paper' ? json(renamed) : undefined)
  server.repositories = [renamed]
  const error = await caught(service.inviteCollaborator(42, 'alice', {}, { owner: 'lab-user', name: 'paper' }))
  expect(readRepositoryOperationFailure(error)?.remoteWriteMayHaveCompleted).not.toBe(true)
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/repos/lab-user/renamed-paper'))).toBe(true)
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
})
it('snapshots the confirmed invite target before asynchronous authorization and permits the matching private target', async () => {
  const { service } = await signedIn(), expected = { owner: 'lab-user', name: 'paper' }
  const action = service.inviteCollaborator(42, 'alice', {}, expected)
  expected.name = 'changed-after-call'
  expect(await action).toMatchObject({ status: 'invited', owner: 'lab-user', name: 'paper' })
})
it('participates in transfer cancellation before any action request and consumes invitation selection even with invalid options', async () => {
  const { service, fetcher } = await signedIn(), [item] = await service.invitations(), before = fetcher.mock.calls.length
  await expect(service.acceptInvitation(item!.handle, { timeoutMs: 0 })).rejects.toThrow()
  await expect(service.acceptInvitation(item!.handle)).rejects.toThrow()
  const abort = new AbortController(); abort.abort()
  await expect(service.createPrivateProject('paper', { signal: abort.signal })).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(before)
})
