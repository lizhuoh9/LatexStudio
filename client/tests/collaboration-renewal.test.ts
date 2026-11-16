import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubAccountService } from '../src/main/collaboration/service'
import type { AccountSessionStore, StoredSession } from '../src/main/collaboration/session-policy'

const NOW = 1800000000000, HOUR = 3600000
const clientId = 'Iv1.renewal-fixture', id = '15940166-606f-41dd-9c11-9871393ef77a'
const profile = { id: 7, login: 'fixture-user', name: 'Fixture User' }
const grant = { access_token: 'ghu_NEW_ACCESS_CANARY', token_type: 'bearer', expires_in: 28800,
  refresh_token: 'ghr_NEW_REFRESH_CANARY', refresh_token_expires_in: 15552000 }
const device = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const services: GitHubAccountService[] = []
function store(initial: StoredSession | null = null) {
  let saved = initial
  const api: AccountSessionStore = { load: vi.fn(async () => saved ? structuredClone(saved) : null),
    save: vi.fn(async value => { saved = structuredClone(value); return true }),
    clear: vi.fn(async expected => { if (!expected || expected.id === saved?.id) saved = null }) }
  return { api, saved: () => saved }
}
function fixture(replies: unknown[], sessionStore: AccountSessionStore) {
  let now = NOW
  const fetcher = vi.fn<typeof fetch>(async () => {
    const value = replies.shift(); if (value instanceof Error) throw value
    if (typeof value === 'function') return await (value as () => Promise<Response>)()
    if (value instanceof Response) return value
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  })
  const open = vi.fn(async () => undefined)
  const service = new GitHubAccountService({ clientId, fetcher, now: () => now, sleep: async ms => { now += ms }, sessionStore, openAuthorization: open })
  services.push(service)
  return { service, fetcher, open, setClock: (value: number) => { now = value } }
}
const expired = (): StoredSession => Object.assign({ id, clientId, token: 'ghu_OLD_ACCESS_CANARY',
  issuedAt: NOW - HOUR, expiresAt: NOW - 1, conservative: false },
{ refreshToken: 'ghr_OLD_REFRESH_CANARY', refreshExpiresAt: NOW + 100 * 24 * HOUR })
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }) }
const rotated = { ...grant, access_token: 'ghu_ROTATED_ACCESS_CANARY', refresh_token: 'ghr_ROTATED_REFRESH_CANARY' }
async function flush() { for (let i = 0; i < 500; i++) await Promise.resolve() }
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.cancelAndWait())); vi.useRealTimers() })

describe('encrypted persistent device-flow login with rotating refresh credentials', () => {
  it('withholds the synchronous local-workspace commit guard while a rotated credential awaits fresh identity verification', async () => {
    let release!: (value: Response) => void
    const pending = new Promise<Response>(done => { release = done })
    const item = fixture([device, grant, profile, rotated, () => pending], store().api)
    item.service.startLogin(); await flush()
    const guard = item.service.captureSessionGuard()
    item.setClock(NOW + 8 * HOUR + 6000)
    const renewing = item.service.restoreSession(); await flush()
    expect(() => guard()).toThrow(/取消/)
    expect(() => item.service.captureSessionGuard()).toThrow(/取消/)
    release(json(profile)); await renewing
    expect(() => guard()).not.toThrow()
  })
  it('stops the pending-recovery state if secure storage reports the refresh authorization has expired or was removed', async () => {
    const saved = store(expired()), item = fixture([new Error('OFFLINE_CANARY')], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', renewable: true })
    vi.mocked(saved.api.load).mockResolvedValue(null)
    const state = await item.service.restoreSession()
    expect(state.phase).toBe('signed-out'); expect(state.renewable).not.toBe(true)
    expect(item.open).not.toHaveBeenCalled(); expect(item.fetcher).toHaveBeenCalledOnce()
  })
  it('automatically recovers a restart that was offline without opening another authorization or discovering projects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const saved = store(expired()), item = fixture([new Error('OFFLINE_CANARY'), rotated, profile], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', renewable: true, account: null })
    expect(saved.saved()?.token).toBe('ghu_OLD_ACCESS_CANARY')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(item.service.status()).toMatchObject({ phase: 'signed-in', renewable: true })
    expect(saved.saved()).toMatchObject({ token: rotated.access_token, refreshToken: rotated.refresh_token })
    expect(item.open).not.toHaveBeenCalled()
    expect(item.fetcher.mock.calls.filter(([url]) => String(url).includes('/user/installations'))).toHaveLength(0)
  })
  it('keeps the rotated live credential in memory when storage becomes unavailable instead of reusing the invalid old pair', async () => {
    const saved = store(), item = fixture([device, grant, profile, rotated, profile], saved.api)
    item.service.startLogin(); await flush()
    vi.mocked(saved.api.save).mockResolvedValue(false)
    vi.mocked(saved.api.clear).mockRejectedValue(new Error('STORAGE_UNAVAILABLE_CANARY'))
    item.setClock(NOW + 8 * HOUR + 6000)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-in', renewable: true, sessionOnly: true })
    expect(item.fetcher.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${rotated.access_token}` })
  })
  it('automatically rotates before access expiry without a status refresh, browser or repository action', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const saved = store(), item = fixture([device, grant, profile, rotated, profile], saved.api)
    item.service.startLogin(); await flush()
    item.setClock(NOW + 5000 + 8 * HOUR - 5 * 60000)
    await vi.advanceTimersByTimeAsync(8 * HOUR - 5 * 60000)
    expect(saved.saved()).toMatchObject({ token: rotated.access_token, refreshToken: rotated.refresh_token })
    expect(item.service.status()).toMatchObject({ phase: 'signed-in', renewable: true })
    expect(item.open).toHaveBeenCalledOnce()
    expect(item.fetcher.mock.calls.filter(([url]) => String(url).includes('/user/installations'))).toHaveLength(0)
  })
  it('coalesces live renewal before project discovery and never sends the old access credential afterward', async () => {
    const saved = store(), item = fixture([device, grant, profile, rotated, profile, { installations: [], total_count: 0 }], saved.api)
    item.service.startLogin(); await flush(); item.setClock(NOW + 8 * HOUR + 6000)
    const [projects, state] = await Promise.all([item.service.projects(), item.service.restoreSession()])
    expect(projects).toEqual([]); expect(state.phase).toBe('signed-in')
    expect(item.fetcher.mock.calls.filter(([, init]) => String(init?.body).includes('grant_type=refresh_token'))).toHaveLength(1)
    expect(item.fetcher.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${rotated.access_token}` })
    expect(saved.saved()).toMatchObject({ token: rotated.access_token, refreshToken: rotated.refresh_token })
    expect(item.open).toHaveBeenCalledOnce() // Only the original explicit login.
  })
  it('persists a rotated pair before profile verification, so temporary profile failure cannot reuse the consumed refresh token', async () => {
    const saved = store(expired()), item = fixture([rotated, new Error('PRIVATE_PROFILE_ERROR'), profile], saved.api)
    expect((await item.service.restoreSession()).phase).toBe('signed-out')
    expect(saved.saved()).toMatchObject({ token: rotated.access_token, refreshToken: rotated.refresh_token })
    expect((await item.service.restoreSession()).phase).toBe('signed-in')
    expect(item.fetcher.mock.calls.filter(([url]) => url === 'https://github.com/login/oauth/access_token')).toHaveLength(1)
    expect(item.fetcher.mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${rotated.access_token}` })
  })
  it('logout drains a late rotation and removes both credentials without allowing late sign-in', async () => {
    let release!: (value: Response) => void
    const gate = new Promise<Response>(done => { release = done })
    const saved = store(), item = fixture([device, grant, profile, () => gate], saved.api)
    item.service.startLogin(); await flush(); item.setClock(NOW + 8 * HOUR + 6000)
    const renewing = item.service.restoreSession(); await flush()
    let ended = false; const logout = item.service.logout().then(() => { ended = true }); await flush()
    expect(ended).toBe(false); release(json(rotated)); await logout; await renewing
    expect(item.service.status()).toMatchObject({ phase: 'signed-out', account: null })
    expect(saved.saved()).toBeNull(); expect(item.fetcher).toHaveBeenCalledTimes(4)
  })
  it('normal shutdown waits for an already-dispatched rotation and keeps the new pair for the next launch', async () => {
    let release!: (value: Response) => void
    const gate = new Promise<Response>(done => { release = done })
    const saved = store(), item = fixture([device, grant, profile, () => gate, profile], saved.api)
    item.service.startLogin(); await flush(); item.setClock(NOW + 8 * HOUR + 6000)
    const renewing = item.service.restoreSession(); await flush()
    let ended = false; const shutdown = item.service.cancelAndWait().then(() => { ended = true }); await flush()
    expect(ended).toBe(false); release(json(rotated)); await shutdown; await renewing
    expect(saved.saved()).toMatchObject({ token: rotated.access_token, refreshToken: rotated.refresh_token })
    const restarted = fixture([profile], saved.api); restarted.setClock(NOW + 8 * HOUR + 6001)
    expect(await restarted.service.restoreSession()).toMatchObject({ phase: 'signed-in', sessionOnly: false })
    expect(restarted.fetcher).toHaveBeenCalledOnce(); expect(restarted.open).not.toHaveBeenCalled()
  })
  it('does not rotate an access token while a discovery operation still owns it', async () => {
    let release!: (value: Response) => void
    const gate = new Promise<Response>(done => { release = done })
    const saved = store(), item = fixture([device, grant, profile, () => gate, rotated, profile], saved.api)
    item.service.startLogin(); await flush(); const reading = item.service.projects(); await flush()
    item.setClock(NOW + 8 * HOUR - 30000)
    expect((await item.service.restoreSession()).phase).toBe('signed-in')
    expect(item.fetcher).toHaveBeenCalledTimes(4)
    release(json({ installations: [], total_count: 0 })); await reading
    expect((await item.service.restoreSession()).phase).toBe('signed-in')
    expect(saved.saved()?.token).toBe(rotated.access_token)
  })
  it('rejects an account identity change after rotation and removes the new stored pair', async () => {
    const saved = store(), item = fixture([device, grant, profile, rotated, { ...profile, id: 99 }], saved.api)
    item.service.startLogin(); await flush(); item.setClock(NOW + 8 * HOUR + 6000)
    expect((await item.service.restoreSession()).phase).toBe('signed-out'); await flush()
    expect(saved.saved()).toBeNull(); expect(item.open).toHaveBeenCalledOnce()
  })
  it('retains a complete refresh pair after explicit login without exposing it through state', async () => {
    const saved = store(), item = fixture([device, grant, profile], saved.api)
    item.service.startLogin(); await flush()
    expect(item.service.status()).toMatchObject({ phase: 'signed-in', sessionOnly: false })
    expect(saved.saved()).toMatchObject({ token: grant.access_token, refreshToken: grant.refresh_token })
    expect(JSON.stringify(item.service.status())).not.toMatch(/CANARY|refreshToken|access_token|client_secret/)
    await item.service.cancelAndWait(); expect(saved.saved()).not.toBeNull()
  })
  it('renews an expired access token on restart using only client_id and refresh_token, never a browser or App secret', async () => {
    const saved = store(expired()), item = fixture([grant, profile], saved.api)
    const states = await Promise.all([item.service.restoreSession(), item.service.restoreSession()])
    for (const state of states) expect(state).toMatchObject({ phase: 'signed-in', sessionOnly: false, account: { id: 7 } })
    expect(item.fetcher).toHaveBeenCalledTimes(2)
    const [url, init] = item.fetcher.mock.calls[0]!
    expect(url).toBe('https://github.com/login/oauth/access_token')
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ client_id: clientId,
      grant_type: 'refresh_token', refresh_token: 'ghr_OLD_REFRESH_CANARY' })
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'manual' })
    expect(saved.saved()).toMatchObject({ token: grant.access_token, refreshToken: grant.refresh_token })
    expect(item.open).not.toHaveBeenCalled()
  })
  it('keeps encrypted authorization after a temporary renewal failure and resumes on a later read', async () => {
    const credential = expired(), saved = store(credential), item = fixture([new Error('PRIVATE_NETWORK'), grant, profile], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', account: null })
    expect(saved.saved()).toEqual(credential)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-in', sessionOnly: false })
    expect(item.open).not.toHaveBeenCalled(); expect(item.service.status().message).not.toContain('PRIVATE_NETWORK')
  })
  it('removes revoked refresh credentials instead of retrying or fabricating a signed-in identity', async () => {
    const saved = store(expired()), item = fixture([{ error: 'bad_refresh_token' }], saved.api)
    expect(await item.service.restoreSession()).toMatchObject({ phase: 'signed-out', account: null })
    expect(saved.saved()).toBeNull(); expect(item.fetcher).toHaveBeenCalledOnce(); expect(item.open).not.toHaveBeenCalled()
  })
})
