import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubAccountService } from '../src/main/collaboration/service'
import type { AccountSessionStore, StoredSession } from '../src/main/collaboration/session-policy'
import { publicState } from '../src/main/collaboration/public-state'
const id = '15940166-606f-41dd-9c11-9871393ef77a', clientId = 'Iv1.fixture-client', token = 'ghu_ACCESS_SESSION_CANARY'
const device = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const grant = { access_token: token, token_type: 'bearer', expires_in: 28800, refresh_token: 'REFRESH_MUST_NOT_PERSIST' }
const profile = { id: 7, login: 'fixture-user', name: 'Fixture User', email: 'PRIVATE_EMAIL' }
const credential = (extra: Partial<StoredSession> = {}): StoredSession => ({ id, clientId, token, issuedAt: 90000, expiresAt: 200000, conservative: true, ...extra })
const services: GitHubAccountService[] = [], cleanups: (() => void)[] = []
function store(initial: StoredSession | null = null) {
  let saved = initial
  const api: AccountSessionStore = { load: vi.fn(async () => saved ? structuredClone(saved) : null),
    save: vi.fn(async value => { saved = structuredClone(value); return true }),
    clear: vi.fn(async expected => { if (!expected || expected.id === saved?.id) saved = null }) }
  return { api, saved: () => saved }
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
function fixture(replies: (unknown | Error | Response)[], sessionStore?: AccountSessionStore) {
  let clock = 100000
  const fetcher = vi.fn<typeof fetch>(async () => { const value = replies.shift(); if (value instanceof Error) throw value; return value instanceof Response ? value : json(value) })
  const open = vi.fn(async () => undefined)
  const service = new GitHubAccountService({ clientId, fetcher, now: () => clock, sleep: async ms => { clock += ms }, openAuthorization: open, sessionStore })
  services.push(service)
  return { service, fetcher, open, setClock: (value: number) => { clock = value } }
}
async function flush() { for (let index = 0; index < 400; index++) await Promise.resolve() }
afterEach(async () => { for (const cleanup of cleanups.splice(0)) cleanup(); await Promise.all(services.splice(0).map(service => service.cancelAndWait())) })

describe('safe current-token restoration, not a refresh-token or auto-login browser flow', () => {
  it('does nothing on construction/local status, then restores only through a trusted read and fresh /user', async () => {
    const saved = store(credential()), item = fixture([profile], saved.api)
    expect(item.service.status()).toMatchObject({ phase: 'signed-out', sessionOnly: true })
    expect(saved.api.load).not.toHaveBeenCalled(); expect(item.fetcher).not.toHaveBeenCalled()
    const both = await Promise.all([item.service.restoreSession(), item.service.restoreSession()])
    expect(saved.api.load).toHaveBeenCalledOnce(); expect(item.fetcher).toHaveBeenCalledExactlyOnceWith('https://api.github.com/user', expect.objectContaining({ method: 'GET' }))
    for (const state of both) expect(state).toMatchObject({ phase: 'signed-in', sessionOnly: false, expiresAt: 200000, account: { login: 'fixture-user' } })
    expect(item.open).not.toHaveBeenCalled(); expect(saved.api.save).not.toHaveBeenCalled()
    expect(JSON.stringify(publicState(both[0]!))).not.toMatch(/ACCESS_SESSION_CANARY|PRIVATE_EMAIL|token/)
  })
  it('stores only the current access token after fresh login and preserves it on shutdown cancel', async () => {
    const saved = store(), first = fixture([device, grant, profile], saved.api)
    first.service.startLogin(); await flush(); expect(first.service.status()).toMatchObject({ phase: 'signed-in', sessionOnly: false })
    const value = saved.saved()!; expect(value.token).toBe(token)
    expect(Object.keys(value).sort()).toEqual(['clientId', 'conservative', 'expiresAt', 'id', 'issuedAt', 'token'])
    expect(JSON.stringify(value)).not.toMatch(/REFRESH_MUST_NOT_PERSIST|PRIVATE_EMAIL|client_secret|account/)
    await first.service.cancelAndWait(); expect(saved.saved()).toEqual(value)
    const restarted = fixture([profile], saved.api); restarted.setClock(value.issuedAt + 1)
    await restarted.service.restoreSession()
    expect(restarted.service.status()).toMatchObject({ phase: 'signed-in', sessionOnly: false, expiresAt: value.expiresAt })
    expect(restarted.open).not.toHaveBeenCalled()
  })
  it.each(['false', 'throw'])('stays memory-only when encrypted storage cannot save (%s)', async mode => {
    const saved = store(); if (mode === 'false') vi.mocked(saved.api.save).mockResolvedValue(false)
    else vi.mocked(saved.api.save).mockRejectedValue(new Error('PRIVATE_STORAGE_PATH'))
    const item = fixture([device, grant, profile], saved.api); item.service.startLogin(); await flush()
    expect(item.service.status()).toMatchObject({ phase: 'signed-in', sessionOnly: true })
    expect(item.service.status().message).toContain('安全存储不可用'); expect(JSON.stringify(item.service.status())).not.toContain('PRIVATE_STORAGE_PATH')
  })
  it('does not restore expired credentials or extend original lifetime', async () => {
    const saved = store(credential({ expiresAt: 99999 })), item = fixture([], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', account: null })
    expect(saved.saved()).toBeNull(); expect(item.fetcher).not.toHaveBeenCalled(); expect(item.open).not.toHaveBeenCalled()
  })
  it('rejects revoked saved tokens and removes their dedicated credential', async () => {
    const saved = store(credential()), item = fixture([json({}, 401)], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', account: null })
    expect(saved.saved()).toBeNull(); expect(item.open).not.toHaveBeenCalled()
  })
  it('does not pretend offline/network failure is signed-in and allows a later explicit read-only retry', async () => {
    const saved = store(credential()), item = fixture([new Error('PRIVATE failure'), profile], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', account: null })
    expect(saved.saved()).toEqual(credential()); expect(item.service.status().message).not.toContain('PRIVATE')
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-in', sessionOnly: false })
    expect(item.open).not.toHaveBeenCalled(); expect(saved.api.save).not.toHaveBeenCalled()
  })
  it('uses conservative one-hour retention when the server does not report expiry', async () => {
    const saved = store(), unknownExpiry = { access_token: token, token_type: 'bearer' }, item = fixture([device, unknownExpiry, profile], saved.api)
    item.service.startLogin(); await flush(); const value = saved.saved()!
    expect(value.conservative).toBe(true); expect(value.expiresAt - value.issuedAt).toBeLessThanOrEqual(3600000)
  })
  it('logout drains a late restore, prevents late signed-in, and deletes the stored session', async () => {
    const saved = store(credential()); let release!: (value: StoredSession) => void
    const pending = new Promise<StoredSession>(done => { release = done }); cleanups.push(() => release(credential()))
    vi.mocked(saved.api.load).mockReturnValue(pending)
    const item = fixture([], saved.api), restoring = item.service.restoreSession(); let ended = false
    const logout = item.service.logout().then(() => { ended = true }); await flush(); expect(ended).toBe(false)
    release(credential()); await logout; await restoring
    expect(item.service.status()).toMatchObject({ phase: 'signed-out', account: null }); expect(saved.saved()).toBeNull()
    expect(item.fetcher).not.toHaveBeenCalled(); expect(item.open).not.toHaveBeenCalled()
  })
  it('cancel while encrypted save ignores abort rolls back only that late credential', async () => {
    const saved = store(); let release!: () => void, value: StoredSession | null = null
    const gate = new Promise<void>(done => { release = done }); cleanups.push(() => release())
    const originalSave = vi.mocked(saved.api.save).getMockImplementation()!
    vi.mocked(saved.api.save).mockImplementation(async credential => { value = credential; await gate; return originalSave(credential) })
    const item = fixture([device, grant, profile], saved.api); item.service.startLogin(); await flush(); expect(value).not.toBeNull()
    let ended = false; const cancel = item.service.cancelAndWait().then(() => { ended = true }); await flush(); expect(ended).toBe(false)
    release(); await cancel; await flush(); expect(saved.saved()).toBeNull()
    expect(item.service.status()).toMatchObject({ phase: 'signed-out', account: null })
  })
  it('does not accept a token that expires while persistence is pending', async () => {
    const saved = store(); let release!: () => void
    const gate = new Promise<void>(done => { release = done }); cleanups.push(() => release())
    const originalSave = vi.mocked(saved.api.save).getMockImplementation()!
    vi.mocked(saved.api.save).mockImplementation(async credential => { await gate; return originalSave(credential) })
    const item = fixture([device, grant, profile], saved.api); item.service.startLogin(); await flush()
    item.setClock(100000000); release(); await flush()
    expect(item.service.status().phase).not.toBe('signed-in'); expect(saved.saved()).toBeNull()
  })
  it('reports failure to remove saved login instead of claiming logout succeeded', async () => {
    const saved = store(credential()), item = fixture([profile], saved.api); await item.service.restoreSession()
    vi.mocked(saved.api.clear).mockRejectedValue(new Error('PRIVATE_REMOVE_ERROR'))
    await expect(item.service.logout()).rejects.not.toThrow('PRIVATE_REMOVE_ERROR')
    expect(item.service.status()).toMatchObject({ phase: 'error', account: null })
    expect(item.service.status().message).toContain('重试退出')
  })
})
