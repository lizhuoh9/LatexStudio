import { afterEach, expect, it, vi } from 'vitest'
import type { CollaborationState } from '../src/shared/collaboration-contracts'
import { GitHubAccountService } from '../src/main/collaboration/service'
import { MAX_JSON_BYTES } from '../src/main/collaboration/transport'

const clientId = 'Iv1.fixture_app_only'
const token = 'ghu_fixture_secret_token'
const deviceCode = 'a'.repeat(40)
const device = { device_code: deviceCode, user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const grant = { access_token: token, token_type: 'bearer', expires_in: 28800, refresh_token: 'refresh_fixture_secret' }
const profile = { id: 123, login: 'lab-user', name: 'Lab User', email: 'not-for-ui@example.invalid', access_token: token }
const services: GitHubAccountService[] = []
type Reply = unknown | (() => Promise<Response>)
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
function network(replies: Reply[]) {
  return vi.fn<typeof fetch>(async () => {
    if (!replies.length) throw new Error('Unexpected fixture request with Authorization secret')
    const reply = replies.shift()
    if (typeof reply === 'function') return (reply as () => Promise<Response>)()
    if (reply instanceof Error) throw reply
    return reply instanceof Response ? reply : json(reply)
  })
}
function fixture(replies: Reply[], extra: Partial<ConstructorParameters<typeof GitHubAccountService>[0]> = {}) {
  let clock = 100_000
  const intervals: number[] = []
  const fetcher = network(replies)
  const service = new GitHubAccountService({ clientId, fetcher, now: () => clock,
    sleep: async (ms) => { intervals.push(ms); clock += ms }, ...extra })
  services.push(service)
  return { service, fetcher, intervals, setClock: (value: number) => { clock = value } }
}
async function flush(): Promise<void> { for (let i = 0; i < 150; i++) await Promise.resolve() }
async function complete(service: GitHubAccountService, phase: CollaborationState['phase'] = 'signed-in'): Promise<void> {
  await flush()
  expect(service.status().phase).toBe(phase)
}
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.logout())); vi.useRealTimers() })

  it.each([null, '', 'numeric', 'with space clientid', 'x'.repeat(129)])('remains unconfigured for client id %s', (id) => {
    const { service, fetcher } = fixture([], { clientId: id })
    expect(service.startLogin()).toMatchObject({ phase: 'unconfigured', account: null, sessionOnly: true })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('opens once only after explicit login and a validated prompt, before polling', async () => {
    let release!: () => void
    const opening = new Promise<void>(resolve => { release = resolve })
    const open = vi.fn<NonNullable<ConstructorParameters<typeof GitHubAccountService>[0]['openAuthorization']>>(
      async prompt => { prompt.userCode = 'WXYZ-1234'; await opening })
    const { service, fetcher } = fixture([device, grant, profile], { openAuthorization: open })
    service.status(); expect(open).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    service.startLogin(); service.startLogin(); await flush()
    expect(open).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1)
    expect(service.status().authorization?.userCode).toBe(device.user_code)
    expect(Object.keys(open.mock.calls[0]![0]).sort()).toEqual(['expiresAt', 'userCode', 'verificationUri'])
    release(); await complete(service); expect(open).toHaveBeenCalledTimes(1)
  })
  it('keeps a valid prompt and concise retry message when the browser cannot open', async () => {
    const open = vi.fn(async () => { throw new Error('CANARY_PRIVATE_BROWSER_PATH') })
    const { service, fetcher } = fixture([device], { openAuthorization: open,
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true })) })
    service.startLogin(); await flush()
    expect(service.status()).toMatchObject({ phase: 'authorizing', authorization: { userCode: device.user_code }, message: '无法打开浏览器，请重试打开授权页。' })
    expect(JSON.stringify(service.status())).not.toContain('CANARY_PRIVATE_BROWSER_PATH')
    expect(open).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1)
    await service.cancelAndWait(); expect(service.status().authorization).toBeNull()
  })
  it('cancels and drains an outstanding browser action without polling or late login', async () => {
    let release!: () => void
    const opening = new Promise<void>(resolve => { release = resolve })
    const open = vi.fn(async () => opening), { service, fetcher } = fixture([device], { openAuthorization: open })
    service.startLogin(); await flush(); expect(open).toHaveBeenCalledTimes(1)
    let drained = false; const cancelled = service.cancelAndWait().then(() => { drained = true })
    await flush(); expect(drained).toBe(false)
    release(); await cancelled; await flush()
    expect(service.status()).toMatchObject({ phase: 'signed-out', authorization: null, account: null })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([{ ...device, verification_uri: 'https://untrusted.invalid/' }, { ...device, expires_in: 0 }])('never opens an invalid prompt', async reply => {
    const open = vi.fn(async () => undefined), { service } = fixture([reply], { openAuthorization: open })
    service.startLogin(); await complete(service, 'error'); expect(open).not.toHaveBeenCalled()
  })

  it('returns authorizing immediately and exposes only whitelisted public account fields', async () => {
    const states: CollaborationState[] = []
    const { service, fetcher } = fixture([device, grant, profile], { onState: (state) => states.push(state) })
    expect(service.startLogin()).toMatchObject({ phase: 'authorizing', sessionOnly: true })
    await complete(service)
    expect(service.status().account).toEqual({ id: 123, login: 'lab-user', name: 'Lab User' })
    expect(states.some((state) => state.phase === 'authorizing' && state.authorization?.userCode === device.user_code)).toBe(true)
    expect(states.at(-1)).toEqual(service.status())
    expect(states.at(-1)).toMatchObject({ phase: 'signed-in', account: { id: 123 }, authorization: null })
    const publicStates = JSON.stringify(states)
    for (const secret of [token, deviceCode, 'refresh_fixture_secret', profile.email]) expect(publicStates).not.toContain(secret)
    expect(fetcher).toHaveBeenCalledTimes(3)
    const first = fetcher.mock.calls[0]!
    expect(first[0]).toBe('https://github.com/login/device/code')
    expect(new URLSearchParams(first[1]!.body as string)).toEqual(new URLSearchParams({ client_id: clientId, scope: 'repo' }))
    const poll = fetcher.mock.calls[1]!
    expect(poll[0]).toBe('https://github.com/login/oauth/access_token')
    expect(new URLSearchParams(poll[1]!.body as string).get('device_code')).toBe(deviceCode)
    expect(new URLSearchParams(poll[1]!.body as string).has('scope')).toBe(false)
    expect(fetcher.mock.calls[2]![0]).toBe('https://api.github.com/user')
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).not.toContain(token)
      expect(String(url)).not.toContain(deviceCode)
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual', cache: 'no-store' })
    }
  })

  it('returns independent state copies and ignores observer exceptions or mutations', async () => {
    const { service } = fixture([device, grant, profile], { onState: (state) => {
      if (state.account) state.account.login = 'changed'
      if (state.authorization) state.authorization.userCode = 'MUTATED'
      throw new Error('observer failure')
    } })
    service.startLogin()
    await complete(service)
    const state = service.status()
    state.account!.login = 'external'
    expect(service.status().account!.login).toBe('lab-user')
  })

  it('coalesces repeated login requests and cancels an abort-ignoring response without late login', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const { service, fetcher } = fixture([() => pending])
    service.startLogin(); service.startLogin(); service.startLogin()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await service.cancelLogin()).phase).toBe('signed-out')
    resolve(json(device))
    await flush()
    expect(service.status().phase).toBe('signed-out')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('honors pending and cumulatively adds five seconds for each slow_down', async () => {
    const { service, intervals } = fixture([device, { error: 'authorization_pending' }, { error: 'slow_down' },
      { error: 'slow_down' }, grant, profile])
    service.startLogin()
    await complete(service)
    expect(intervals).toEqual([5000, 5000, 10000, 15000])
  })

  it('never tight-polls when the provider supplies an interval below five seconds', async () => {
    const { service, intervals } = fixture([{ ...device, interval: 1 }, grant, profile])
    service.startLogin()
    await complete(service)
    expect(intervals).toEqual([5000])
  })

  it.each(['access_denied', 'expired_token', 'device_flow_disabled', 'incorrect_client_credentials'])('safely reports %s', async (error) => {
    const { service } = fixture([device, { error, error_description: `${token} ${deviceCode}` }])
    service.startLogin()
    await complete(service, 'error')
    expect(service.status().authorization).toBeNull()
    expect(JSON.stringify(service.status())).not.toContain(token)
    expect(JSON.stringify(service.status())).not.toContain(deviceCode)
  })

  it('expires without polling after the device code lifetime has ended', async () => {
    const { service, fetcher, intervals } = fixture([{ ...device, expires_in: 2 }])
    service.startLogin()
    await complete(service, 'error')
    expect(intervals).toEqual([2000])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(service.status().message).toContain('过期')
  })

  it('has an independent authorization deadline even when the wall clock goes backwards', async () => {
    vi.useFakeTimers()
    const { service, fetcher, setClock } = fixture([{ ...device, expires_in: 6 }, { error: 'authorization_pending' }],
      { sleep: undefined })
    service.startLogin()
    await flush()
    setClock(-1_000_000)
    await vi.advanceTimersByTimeAsync(6000)
    await complete(service, 'error')
    expect(service.status().message).toContain('过期')
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('cancels an injected sleep that ignores abort, with no late authorization', async () => {
    const { service, fetcher } = fixture([device], { sleep: () => new Promise<void>(() => undefined) })
    service.startLogin()
    await flush()
    expect(service.status().authorization?.userCode).toBe('ABCD-EFGH')
    expect((await service.cancelAndWait()).phase).toBe('signed-out')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps a valid signed-in session on cancel and close cleanup, but logout clears only this device', async () => {
    const { service, fetcher } = fixture([device, grant, profile])
    service.startLogin()
    await complete(service)
    expect((await service.cancelLogin()).phase).toBe('signed-in')
    expect((await service.cancelAndWait()).phase).toBe('signed-in')
    expect(service.startLogin().phase).toBe('signed-in')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect((await service.logout()).phase).toBe('signed-out')
    expect(service.status().account).toBeNull()
    expect(service.status().message).toContain('未撤销云端授权')
    await expect(service.projects()).rejects.toThrow('请先登录')
  })

  it('does not resurrect a cancelled account profile, including after a new login', async () => {
    let resolve!: (value: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const { service, fetcher } = fixture([device, grant, () => pending, device, grant, { ...profile, id: 456, login: 'new-user' }])
    service.startLogin()
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    await service.logout()
    service.startLogin()
    await complete(service)
    resolve(json({ ...profile, access_token: token }, 401))
    await flush()
    expect(service.status().account!.login).toBe('new-user')
  })

  it.each([
    { device_code: 'not-a-device-code' }, { user_code: 'abcd-efgh' }, { user_code: 'ABCD-EFGH?token=x' },
    { verification_uri: 'https://github.com/login/device?token=x' }, { verification_uri: 'https://evil.invalid/login/device' },
    { expires_in: 901 }, { expires_in: 0 }, { interval: 0 }, { interval: 1.5 }
  ])('rejects invalid device response %j', async (change) => {
    const { service, fetcher } = fixture([{ ...device, ...change }])
    service.startLogin()
    await complete(service, 'error')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([{ access_token: 'bad\nheader' }, { token_type: 'mac' }, { scope: 'read:user' }, { expires_in: 0 }, { expires_in: -1 }])(
    'rejects invalid or under-scoped token response %j', async (change) => {
      const { service, fetcher } = fixture([device, { ...grant, ...change }])
      service.startLogin()
      await complete(service, 'error')
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

  it('accepts OAuth responses returning repo scope alongside read scopes', async () => {
    const { service } = fixture([device, { ...grant, scope: 'read:user repo' }, profile])
    service.startLogin()
    await complete(service)
    expect(service.status().account!.login).toBe('lab-user')
  })

  it.each([{ id: 0 }, { id: 1.1 }, { login: '../escape' }, { name: 'bad\u0000name' }, { name: 123 }])(
    'rejects invalid profile response %j', async (change) => {
      const { service } = fixture([device, grant, { ...profile, ...change }])
      service.startLogin()
      await complete(service, 'error')
      expect(service.status().account).toBeNull()
    })

  it('uses an explicit conservative one-hour local policy when the server omits expiry', async () => {
    const { service } = fixture([device, { access_token: token, token_type: 'bearer' }, profile])
    service.startLogin()
    await complete(service)
    expect(service.status().expiresAt).toBe(105_000 + 3600_000)
    expect(service.status().message).toContain('服务器未提供到期时间')
    expect(service.status().message).toContain('不自动续期')
  })

  it('caps session lifetime to eight hours and clears it immediately on local expiry', async () => {
    const { service, fetcher, setClock } = fixture([device, { ...grant, expires_in: 999_999 }, profile])
    service.startLogin()
    await complete(service)
    expect(service.status().expiresAt).toBe(105_000 + 8 * 3600_000)
    setClock(service.status().expiresAt!)
    expect(service.status().phase).toBe('signed-out')
    expect(service.status().account).toBeNull()
    await expect(service.projects()).rejects.toThrow('请先登录')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not extend expiry by moving the wall clock backwards during close cleanup', async () => {
    vi.useFakeTimers()
    const { service, setClock } = fixture([device, { ...grant, expires_in: 2 }, profile])
    service.startLogin()
    await complete(service)
    setClock(-1_000_000)
    await service.cancelAndWait()
    await vi.advanceTimersByTimeAsync(2000)
    expect(service.status().phase).toBe('signed-out')
  })

  it('accepts a normal numeric Content-Length and JSON device response', async () => {
    const body = JSON.stringify(device)
    const response = new Response(body, { headers: { 'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(body).byteLength) } })
    const { service } = fixture([response, grant, profile])
    service.startLogin()
    await complete(service)
    expect(service.status().account?.name).toBe('Lab User')
  })

  it('rejects redirects without sending credentials or polling at a second destination', async () => {
    const redirect = new Response('secret redirect body', { status: 302, headers: { location: `https://evil.invalid/${token}` } })
    const { service, fetcher } = fixture([redirect])
    service.startLogin()
    await complete(service, 'error')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(service.status().message).toContain('重定向')
    expect(JSON.stringify(service.status())).not.toContain(token)
  })

  it.each([
    new Response(`{"secret":"${token}"`, { headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ token }), { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_JSON_BYTES + 1) } }),
    new Response('x'.repeat(MAX_JSON_BYTES + 1), { headers: { 'content-type': 'application/json' } })
  ])('rejects invalid, untyped or oversized JSON without leaking the body', async (response) => {
    const { service } = fixture([response])
    service.startLogin()
    await complete(service, 'error')
    expect(JSON.stringify(service.status())).not.toContain(token)
  })

  it('bounds a fetch that ignores cancellation to ten seconds', async () => {
    vi.useFakeTimers()
    const { service } = fixture([() => new Promise<Response>(() => undefined)])
    service.startLogin()
    await vi.advanceTimersByTimeAsync(10_000)
    await complete(service, 'error')
    expect(service.status().message).toContain('超时')
  })

  it('bounds response-body reads and cancels their stream on timeout', async () => {
    vi.useFakeTimers()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode('{')),
      cancel: () => { cancelled = true } })
    const { service } = fixture([new Response(body, { headers: { 'content-type': 'application/json' } })])
    service.startLogin()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    await complete(service, 'error')
    expect(cancelled).toBe(true)
    expect(service.status().message).toContain('超时')
  })

  it('discards raw network errors and authorization response fields', async () => {
    const { service } = fixture([new Error(`Authorization: Bearer ${token} ${deviceCode}`)])
    service.startLogin()
    await complete(service, 'error')
    expect(JSON.stringify(service.status())).not.toContain(token)
    expect(JSON.stringify(service.status())).not.toContain('Authorization')
  })
