import { afterEach, expect, it, vi } from 'vitest'
import { GitHubAccountService } from '../src/main/collaboration/service'
import { MAX_INSTALLATIONS, MAX_PROJECTS, MAX_PROJECT_REQUESTS } from '../src/main/collaboration/projects'
import { PAGE_SIZE } from '../src/main/collaboration/transport'

const token = 'ghu_project_fixture_secret'
const services: GitHubAccountService[] = []
const device = { device_code: 'b'.repeat(40), user_code: 'WXYZ-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...extra } })
}
function repo(id: number, extra: Record<string, unknown> = {}) {
  return { id, name: `paper-${id}`, private: true, owner: { login: 'lab-team' }, ...extra }
}
async function flush(): Promise<void> { for (let i = 0; i < 150; i++) await Promise.resolve() }
async function loggedIn(handler: (url: URL) => Response | Promise<Response>,
  extra: Partial<ConstructorParameters<typeof GitHubAccountService>[0]> = {}) {
  let clock = 100_000
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input))
    if (url.href === 'https://github.com/login/device/code') return json(device)
    if (url.href === 'https://github.com/login/oauth/access_token') return json({ access_token: token, token_type: 'bearer', expires_in: 28800 })
    if (url.href === 'https://api.github.com/user') return json({ id: 321, login: 'lab-user', name: null })
    return handler(url)
  })
  const service = new GitHubAccountService({ clientId: 'Iv1.project_fixture', fetcher, now: () => clock,
    sleep: async (ms) => { clock += ms }, ...extra })
  services.push(service)
  service.startLogin()
  await flush()
  expect(service.status().phase).toBe('signed-in')
  return { service, fetcher, setClock: (value: number) => { clock = value } }
}
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.logout())) })

  it('returns only whitelisted metadata and constructs every URL without trusting Link or clone_url', async () => {
    const { service, fetcher } = await loggedIn((url) => url.pathname === '/user/installations' ?
      json({ total_count: 1, installations: [{ id: 17, repositories_url: 'https://evil.invalid' }] }, 200,
        { link: '<https://evil.invalid/secret>; rel="next"' }) :
      json({ total_count: 1, repositories: [repo(42, { clone_url: `https://evil.invalid/${token}`, access_token: token,
        owner: { login: 'lab-team', email: 'hidden@example.invalid' } })] }))
    expect(await service.projects()).toEqual([{ id: 42, installationId: 17, owner: 'lab-team', name: 'paper-42', private: true }])
    const calls = fetcher.mock.calls.slice(3)
    expect(calls.map(([url]) => url)).toEqual([
      `https://api.github.com/user/installations?per_page=${PAGE_SIZE}&page=1`,
      `https://api.github.com/user/installations/17/repositories?per_page=${PAGE_SIZE}&page=1`
    ])
    for (const [url, init] of calls) {
      expect(String(url)).not.toContain(token)
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual', cache: 'no-store' })
      expect(new Headers(init!.headers).get('authorization')).toBe(`Bearer ${token}`)
    }
  })

  it('does not scan account repositories when no app installations are authorized', async () => {
    const { service, fetcher } = await loggedIn(() => json({ total_count: 0, installations: [] }))
    expect(await service.projects()).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('paginates repositories using fixed numeric pages and exact total counts', async () => {
    const rows = Array.from({ length: PAGE_SIZE + 1 }, (_, index) => repo(index + 1))
    const { service, fetcher } = await loggedIn((url) => {
      if (url.pathname === '/user/installations') return json({ total_count: 1, installations: [{ id: 5 }] })
      const page = Number(url.searchParams.get('page'))
      return json({ total_count: rows.length, repositories: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) })
    })
    expect((await service.projects()).length).toBe(PAGE_SIZE + 1)
    expect(fetcher.mock.calls.slice(4).map(([url]) => new URL(String(url)).searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('deduplicates consistent repository identity across authorized installations', async () => {
    const { service } = await loggedIn((url) => url.pathname === '/user/installations' ?
      json({ total_count: 2, installations: [{ id: 5 }, { id: 7 }] }) : json({ total_count: 1, repositories: [repo(42)] }))
    expect(await service.projects()).toEqual([{ id: 42, installationId: 5, owner: 'lab-team', name: 'paper-42', private: true }])
  })

  it('rejects conflicting identities instead of silently replacing metadata', async () => {
    const { service } = await loggedIn((url) => {
      if (url.pathname === '/user/installations') return json({ total_count: 2, installations: [{ id: 5 }, { id: 7 }] })
      return json({ total_count: 1, repositories: [repo(42, { name: url.pathname.includes('/5/') ? 'first' : 'different' })] })
    })
    await expect(service.projects()).rejects.toThrow('无法安全使用')
  })

  it.each([
    { total_count: 1, installations: [{ id: 5 }, { id: 7 }] },
    { total_count: 2, installations: [{ id: 5 }] },
    { total_count: 2, installations: [{ id: 5 }, { id: 5 }] },
    { total_count: 1, installations: [{ id: -1 }] },
    { total_count: -1, installations: [] }
  ])('rejects inconsistent, duplicate or invalid installation response %j', async (response) => {
    const { service, fetcher } = await loggedIn(() => json(response))
    await expect(service.projects()).rejects.toThrow('无法安全使用')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it.each([
    { total_count: 1, repositories: [repo(1), repo(2)] },
    { total_count: 2, repositories: [repo(1)] },
    { total_count: 2, repositories: [repo(1), repo(1)] },
    { total_count: 1, repositories: [repo(0)] },
    { total_count: 1, repositories: [repo(1, { private: 'true' })] },
    { total_count: 1, repositories: [repo(1, { owner: { login: '../escape' } })] },
    { total_count: 1, repositories: [repo(1, { name: '../escape' })] }
  ])('rejects unsafe or incomplete repository response %j', async (response) => {
    const { service } = await loggedIn((url) => url.pathname === '/user/installations' ?
      json({ total_count: 1, installations: [{ id: 5 }] }) : json(response))
    await expect(service.projects()).rejects.toThrow('无法安全使用')
  })

  it('rejects a changing total count during pagination instead of claiming completeness', async () => {
    const { service } = await loggedIn((url) => {
      if (url.pathname === '/user/installations') return json({ total_count: 1, installations: [{ id: 5 }] })
      return url.searchParams.get('page') === '1' ?
        json({ total_count: PAGE_SIZE + 1, repositories: Array.from({ length: PAGE_SIZE }, (_, i) => repo(i + 1)) }) :
        json({ total_count: PAGE_SIZE + 2, repositories: [repo(100)] })
    })
    await expect(service.projects()).rejects.toThrow('无法安全使用')
  })

  it('rejects excessive installation totals before any repository requests', async () => {
    const { service, fetcher } = await loggedIn(() => json({ total_count: MAX_INSTALLATIONS + 1, installations: [] }))
    await expect(service.projects()).rejects.toThrow('安全限额')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('rejects excessive repository totals without returning a partial list', async () => {
    const { service } = await loggedIn((url) => url.pathname === '/user/installations' ?
      json({ total_count: 1, installations: [{ id: 5 }] }) : json({ total_count: MAX_PROJECTS + 1, repositories: [] }))
    await expect(service.projects()).rejects.toThrow('安全限额')
  })

  it('enforces a project cap across installations, not merely per installation', async () => {
    const each = Math.floor(MAX_PROJECTS / 2) + 1
    const { service } = await loggedIn((url) => {
      if (url.pathname === '/user/installations') return json({ total_count: 2, installations: [{ id: 5 }, { id: 7 }] })
      const offset = url.pathname.includes('/5/') ? 0 : 1000
      const page = Number(url.searchParams.get('page'))
      const rows = Array.from({ length: each }, (_, i) => repo(offset + i + 1))
      return json({ total_count: each, repositories: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) })
    })
    await expect(service.projects()).rejects.toThrow('安全限额')
  })

  it('bounds all installation and repository page requests with one shared budget', async () => {
    const { service, fetcher } = await loggedIn((url) => url.pathname === '/user/installations' ?
      json({ total_count: MAX_PROJECT_REQUESTS, installations: Array.from({ length: MAX_PROJECT_REQUESTS }, (_, i) => ({ id: i + 1 })) }) :
      json({ total_count: 0, repositories: [] }))
    await expect(service.projects()).rejects.toThrow('安全限额')
    expect(fetcher.mock.calls.length - 3).toBe(MAX_PROJECT_REQUESTS)
    expect(service.status().phase).toBe('signed-in')
  })

  it('clears this device session immediately on a project 401 and sends no more authenticated requests', async () => {
    const { service, fetcher } = await loggedIn(() => json({ error: `${token} private response` }, 401))
    await expect(service.projects()).rejects.toThrow('登录已失效')
    expect(service.status()).toMatchObject({ phase: 'signed-out', account: null, expiresAt: null })
    await expect(service.projects()).rejects.toThrow('请先登录')
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(service.status())).not.toContain(token)
  })

  it('rejects API redirects without trusting Location or leaking its body', async () => {
    const { service, fetcher } = await loggedIn(() => new Response(token, { status: 307,
      headers: { location: `https://evil.invalid/${token}` } }))
    await expect(service.projects()).rejects.toThrow('重定向')
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(service.status())).not.toContain(token)
  })

  it('keeps a valid session after a sanitized transient read failure and allows a fresh retry', async () => {
    let fail = true
    const { service } = await loggedIn(() => {
      if (fail) { fail = false; throw new Error(`Authorization ${token}`) }
      return json({ total_count: 0, installations: [] })
    })
    await expect(service.projects()).rejects.toThrow('云端请求失败')
    expect(service.status().phase).toBe('signed-in')
    expect(JSON.stringify(service.status())).not.toContain(token)
    expect(await service.projects()).toEqual([])
  })

  it('coalesces project reads while returning independent metadata copies', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const { service, fetcher } = await loggedIn((url) => url.pathname === '/user/installations' ? pending :
      json({ total_count: 1, repositories: [repo(42)] }))
    const first = service.projects(), second = service.projects()
    expect(fetcher).toHaveBeenCalledTimes(4)
    resolve(json({ total_count: 1, installations: [{ id: 5 }] }))
    const [left, right] = await Promise.all([first, second])
    left[0]!.name = 'modified'
    expect(right[0]!.name).toBe('paper-42')
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('cancels and awaits a project read on close without logging out or accepting its late 401', async () => {
    let resolve!: (response: Response) => void
    const pending = new Promise<Response>((done) => { resolve = done })
    const { service, fetcher } = await loggedIn(() => pending)
    const read = service.projects().catch((error: unknown) => error)
    expect((await service.cancelAndWait()).phase).toBe('signed-in')
    expect((await read as Error).message).toContain('取消')
    resolve(json({ error: token }, 401))
    await flush()
    expect(service.status().phase).toBe('signed-in')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('aborts project response bodies on explicit logout and cannot restore the account later', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode('{')),
      cancel: () => { cancelled = true } })
    const { service } = await loggedIn(() => new Response(body, { headers: { 'content-type': 'application/json' } }))
    const read = service.projects().catch((error: unknown) => error)
    await flush()
    expect((await service.logout()).phase).toBe('signed-out')
    expect((await read as Error).message).toContain('取消')
    expect(cancelled).toBe(true)
    expect(service.status().account).toBeNull()
  })

  it('discards a pending project list when the session expires', async () => {
    const { service, setClock } = await loggedIn(() => new Promise<Response>(() => undefined))
    const read = service.projects().catch((error: unknown) => error)
    setClock(service.status().expiresAt!)
    expect(service.status().phase).toBe('signed-out')
    expect((await read as Error).message).toContain('取消')
  })

  it('handles expiry exactly between the initial projects check and registration without a raw TypeError', async () => {
    let trip = false, reads = 0
    const { service, fetcher } = await loggedIn(() => json({ total_count: 0, installations: [] }),
      { now: () => trip && ++reads >= 2 ? Number.MAX_SAFE_INTEGER : 100_000 })
    trip = true
    await expect(service.projects()).rejects.toThrow('取消')
    expect(service.status().phase).toBe('signed-out')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
