import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitHubAccountService } from '../src/main/collaboration/service'
import { ProjectSelectionRegistry, SELECTION_TTL_MS, secureRandomUuid } from '../src/main/collaboration/project-selection'
import { MAX_PROJECTS } from '../src/main/collaboration/projects'
import { CollaborationError } from '../src/main/collaboration/validation'

// Main-only source with synthetic Fetch; no real accounts, Git/FS, Vault, IPC, UI or Native proof.
const token = 'ghu_fixture-only-selection-secret'
const user = { id: 123, login: 'lab-user', name: 'Lab User' }
const device = { device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }
const HANDLE = /^pss\.[1-9][0-9]*\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const paper = { id: 42, installationId: 17, owner: 'lab-team', name: 'paper', private: true }
const services: GitHubAccountService[] = []

async function flush(): Promise<void> { for (let i = 0; i < 250; i++) await Promise.resolve() }
async function kind(promise: Promise<unknown>): Promise<string> {
  try { await promise } catch (error) { return error instanceof CollaborationError ? error.kind : `other:${String(error)}` }
  throw new Error('Expected a synthetic failure')
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}
function repo(extra: Record<string, unknown> = {}) {
  return { id: 42, name: 'paper', private: true, owner: { login: 'lab-team' }, ...extra }
}

function fixture() {
  let clock = 100000
  const server = { repositories: { total_count: 1, repositories: [repo()] } as unknown,
    detail: { ...repo(), default_branch: 'main' } as unknown, hold: null as Promise<void> | null, failInstallations: false }
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input))
    if (url.href === 'https://github.com/login/device/code') return json(device)
    if (url.href === 'https://github.com/login/oauth/access_token') return json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
    if (url.href === 'https://api.github.com/user') return json(user)
    if (url.pathname === '/user/installations') {
      if (server.hold) await server.hold
      if (server.failInstallations) return new Response('{}', { status: 500 })
      return json({ total_count: 1, installations: [{ id: 17 }] })
    }
    if (/^\/user\/installations\/17\/repositories$/.test(url.pathname)) return json(server.repositories)
    if (url.pathname === '/repos/lab-team/paper' || url.pathname === '/repos/lab-team/renamed') return json(server.detail)
    throw new Error('Unexpected synthetic endpoint')
  })
  const service = new GitHubAccountService({ clientId: 'Iv1.project-selection-fixture', fetcher, now: () => clock,
    sleep: async ms => { clock += ms } })
  services.push(service)
  return { service, server, fetcher }
}
async function signedIn() {
  const result = fixture()
  result.service.startLogin()
  await flush()
  expect(result.service.status().phase).toBe('signed-in')
  return result
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.logout()))
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('ProjectSelectionRegistry', () => {
  const owner = {}
  const binding = { owner, generation: 3 }

  it('issues frozen five-field snapshots behind opaque CSPRNG-format handles', () => {
    const registry = new ProjectSelectionRegistry()
    const [selection] = registry.issue([{ ...paper, extra: 'dropped' } as typeof paper], binding, 0)
    expect(selection?.handle).toMatch(HANDLE)
    expect(Object.isFrozen(selection)).toBe(true)
    expect(Object.isFrozen(selection?.project)).toBe(true)
    expect(selection?.project).toEqual(paper)
    expect(Object.keys(selection!)).toEqual(['handle', 'project'])
  })

  it('consumes a handle exactly once, even when the attempt is rejected', () => {
    const registry = new ProjectSelectionRegistry()
    const [first, second] = registry.issue([paper, { ...paper, id: 43 }], binding, 0)
    expect(registry.consume(first!.handle, binding, 1)).toEqual(paper)
    expect(() => registry.consume(first!.handle, binding, 1)).toThrow(CollaborationError)
    expect(() => registry.consume(second!.handle, { owner, generation: 4 }, 1)).toThrow(CollaborationError)
    expect(() => registry.consume(second!.handle, binding, 1)).toThrow(CollaborationError)
    expect(registry.size).toBe(0)
  })

  it('rejects other sessions, other generations, expiry and malformed handles', () => {
    const registry = new ProjectSelectionRegistry()
    const handles = registry.issue([1, 2, 3].map(id => ({ ...paper, id })), binding, 0).map(item => item.handle)
    const reason = (fn: () => unknown) => { try { fn() } catch (error) { return (error as CollaborationError).kind } }
    expect(reason(() => registry.consume(handles[0], { owner: {}, generation: 3 }, 1))).toBe('selection')
    expect(reason(() => registry.consume(handles[1], { owner: null, generation: 3 }, 1))).toBe('signed-out')
    expect(reason(() => registry.consume(handles[2], binding, SELECTION_TTL_MS))).toBe('selection')
    for (const bad of [42, '', 'pss.1.1.not-a-uuid', `${handles[0]} `, handles[0]?.toUpperCase()]) {
      expect(reason(() => registry.consume(bad, binding, 1))).toBe('selection')
    }
  })

  it('replaces the previous batch atomically and keeps it when issuing fails', () => {
    const registry = new ProjectSelectionRegistry()
    const [old] = registry.issue([paper], binding, 0)
    expect(() => registry.issue([paper, { ...paper, id: 43 }], binding, 0, () => 'not-a-uuid')).toThrow('invalid')
    const [fresh] = registry.issue([paper], binding, 0)
    expect(fresh!.handle).not.toBe(old!.handle)
    expect(fresh!.handle.split('.')[2]).toBe('2')
    expect(() => registry.consume(old!.handle, binding, 1)).toThrow(CollaborationError)
    expect(registry.consume(fresh!.handle, binding, 1)).toEqual(paper)
  })

  it('refuses duplicate handles, more than the project cap and a missing owner', () => {
    const registry = new ProjectSelectionRegistry()
    const fixed = '00000000-0000-4000-8000-000000000000'
    expect(() => registry.issue([paper, { ...paper, id: 43 }], binding, 0, () => fixed)).toThrow('Duplicate')
    const many = Array.from({ length: MAX_PROJECTS + 1 }, (_, index) => ({ ...paper, id: index + 1 }))
    expect(() => registry.issue(many, binding, 0)).toThrow(CollaborationError)
    expect(() => registry.issue([paper], { owner: null, generation: 1 }, 0)).toThrow(CollaborationError)
    expect(registry.issue(many.slice(0, MAX_PROJECTS), binding, 0)).toHaveLength(MAX_PROJECTS)
  })

  it('refuses to work without platform crypto.randomUUID and never falls back', () => {
    vi.stubGlobal('crypto', {})
    expect(() => secureRandomUuid()).toThrow('unavailable')
    expect(() => new ProjectSelectionRegistry().issue([paper], binding, 0)).toThrow('unavailable')
  })
})

describe('GitHubAccountService project selections', () => {
  it('rejects when signed out without network access', async () => {
    const { service, fetcher } = fixture()
    expect(await kind(service.projectSelections())).toBe('signed-out')
    expect(await kind(service.withSelectedProjectAccess('pss.1.1.x', async () => 1))).toBe('selection')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('opens a selected project once and refuses reuse of the consumed handle', async () => {
    const { service } = await signedIn()
    const [selection] = await service.projectSelections()
    expect(JSON.stringify(selection)).not.toContain(token)
    const callback = vi.fn(async (access: { project: unknown; branch: string }) => [access.project, access.branch])
    expect(await service.withSelectedProjectAccess(selection!.handle, callback)).toEqual([paper, 'main'])
    expect(await kind(service.withSelectedProjectAccess(selection!.handle, callback))).toBe('selection')
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('invalidates old handles only on a successful new selection refresh, not on projects()', async () => {
    const { service, server } = await signedIn()
    const [first] = await service.projectSelections()
    await service.projects()
    const [second] = await service.projectSelections()
    expect(await kind(service.withSelectedProjectAccess(first!.handle, async () => 1))).toBe('selection')
    server.failInstallations = true
    expect(await kind(service.projectSelections())).toBe('network')
    server.failInstallations = false
    expect(await service.withSelectedProjectAccess(second!.handle, async () => 'still valid')).toBe('still valid')
  })

  it('binds the frozen selection: a renamed repository at use time is refused', async () => {
    const { service, server } = await signedIn()
    const [selection] = await service.projectSelections()
    server.repositories = { total_count: 1, repositories: [repo({ name: 'renamed' })] }
    server.detail = { ...repo({ name: 'renamed' }), default_branch: 'main' }
    const callback = vi.fn(async () => 1)
    // Access failures keep the existing sanitized RepositoryOperationError envelope.
    expect(await kind(service.withSelectedProjectAccess(selection!.handle, callback))).toMatch(/^other:RepositoryOperationError/)
    expect(callback).not.toHaveBeenCalled()
    expect(await kind(service.withSelectedProjectAccess(selection!.handle, callback))).toBe('selection')
  })

  it('logout, cancel and expiry invalidate every issued handle', async () => {
    const { service } = await signedIn()
    const [beforeLogout] = await service.projectSelections()
    await service.logout()
    expect(await kind(service.withSelectedProjectAccess(beforeLogout!.handle, async () => 1))).toBe('signed-out')

    const second = await signedIn()
    const [beforeCancel] = await second.service.projectSelections()
    await second.service.cancelAndWait()
    expect(await kind(second.service.withSelectedProjectAccess(beforeCancel!.handle, async () => 1))).toBe('selection')
    const [beforeExpiry] = await second.service.projectSelections()
    vi.advanceTimersByTime(SELECTION_TTL_MS)
    expect(await kind(second.service.withSelectedProjectAccess(beforeExpiry!.handle, async () => 1))).toBe('selection')
  })

  it('a late discovery result after logout cannot issue (resurrect) selections', async () => {
    const { service, server } = await signedIn()
    const issue = vi.spyOn(ProjectSelectionRegistry.prototype, 'issue')
    let release!: () => void
    server.hold = new Promise<void>(done => { release = done })
    const pending = service.projectSelections()
    await flush()
    const stopped = service.logout()
    release()
    expect(await kind(pending)).toBe('cancelled')
    await stopped
    expect(service.status().phase).toBe('signed-out')
    expect(issue).not.toHaveBeenCalled()
  })

  it('consumes the handle even when the callback or options are invalid', async () => {
    const { service } = await signedIn()
    const [first, second] = [(await service.projectSelections())[0]!, (await service.projectSelections())[0]!]
    expect(await kind(service.withSelectedProjectAccess(first.handle, async () => 1))).toBe('selection')
    const invalidAction = undefined as unknown as () => Promise<number>
    expect(await kind(service.withSelectedProjectAccess(second.handle, invalidAction))).toBe('response')
    expect(await kind(service.withSelectedProjectAccess(second.handle, async () => 1))).toBe('selection')
    const [third] = await service.projectSelections()
    await expect(service.withSelectedProjectAccess(third!.handle, async () => 1, { timeoutMs: -1 })).rejects.toThrow()
    expect(await kind(service.withSelectedProjectAccess(third!.handle, async () => 1))).toBe('selection')
  })

  it('consumes a handle refused because another access is still running', async () => {
    const { service } = await signedIn()
    const [busy, refused] = (await service.projectSelections()).concat(await service.projectSelections())
    let release!: () => void
    const held = service.withProjectAccess(42, () => new Promise<void>(done => { release = done }))
    await flush()
    expect(await kind(service.withSelectedProjectAccess(refused!.handle, async () => 1))).toBe('cancelled')
    release()
    await held
    expect(await kind(service.withSelectedProjectAccess(refused!.handle, async () => 1))).toBe('selection')
    expect(busy!.handle).not.toBe(refused!.handle)
  })

  it('session expiry invalidates handles as signed-out', async () => {
    const { service } = await signedIn()
    const [selection] = await service.projectSelections()
    vi.advanceTimersByTime(3600 * 1000)
    expect(service.status().phase).toBe('signed-out')
    expect(await kind(service.withSelectedProjectAccess(selection!.handle, async () => 1))).toBe('signed-out')
  })

  it('a handle issued by one service is refused by another signed-in service', async () => {
    const left = await signedIn()
    const right = await signedIn()
    const [selection] = await left.service.projectSelections()
    expect(await kind(right.service.withSelectedProjectAccess(selection!.handle, async () => 1))).toBe('selection')
    expect(await left.service.withSelectedProjectAccess(selection!.handle, async () => 'left only')).toBe('left only')
  })

  it('coalesces concurrent selection refreshes into one batch', async () => {
    const { service, fetcher } = await signedIn()
    const before = fetcher.mock.calls.length
    const [left, right] = await Promise.all([service.projectSelections(), service.projectSelections()])
    expect(left).toBe(right)
    expect(fetcher.mock.calls.length - before).toBe(2)
  })
})
