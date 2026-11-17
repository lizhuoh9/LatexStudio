import fs from 'node:fs'
import { cp, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { afterEach, expect, it, vi } from 'vitest'
import type { TransferOptions } from '../src/main/github/transport'
import type { GitHubTarget } from '../src/main/github/remote-policy'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const audit = vi.hoisted(() => ({ closed: vi.fn(), clients: [] as Array<{ readOnly?: boolean }>, failClose: false }))
vi.mock('../src/main/github/transport', async original => {
  const actual = await original<typeof import('../src/main/github/transport')>()
  return { ...actual, verifyGitHub: vi.fn(async () => { throw new Error('Legacy PAT verification is forbidden in App fixtures') }),
    githubHttp: (target: GitHubTarget, token: string, options: TransferOptions = {}) => {
      const client = actual.githubHttp(target, token, options)
      audit.clients.push({ readOnly: options.readOnly })
      return { request: client.request, close: async () => {
        audit.closed(); await client.close()
        if (audit.failClose) throw new Error('Synthetic provider close failure')
      } }
    } }
})
import { GitHubAccountService } from '../src/main/collaboration/service'
import type { WritableProjectAccess } from '../src/main/collaboration/project-access'
import { CredentialVault } from '../src/main/github/credentials'
import { readCloudBinding, writeCloudBinding } from '../src/main/github/cloud-binding'
import { CloudRepository } from '../src/main/github/cloud-repository'
import { GitHubRepository } from '../src/main/github/repository'
import { verifyGitHub } from '../src/main/github/transport'
import { readRepositoryOperationFailure } from '../src/main/github/repository-operation'

// Actual memory-session leases + real local Git/FS. All API/Git transport bytes are synthetic; no real account/network.
const roots: string[] = [], accounts: GitHubAccountService[] = []
const token = 'ghu_cloud-repository-fixture-only'
const author = { name: 'Fixture', email: 'fixture@example.invalid' }
const binding = { projectId: 42, owner: 'lab-team', name: 'paper', branch: 'main', accountId: 123 }
const repo = () => ({ id: 42, name: 'paper', private: true, owner: { login: 'lab-team' } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-cloud-repo-')); roots.push(root); return root
}
async function session() {
  let clock = 100000
  const server = { profile: { id: 123, login: 'lab-user', name: 'Lab User' },
    list: [repo()],
    detail: { ...repo(), default_branch: 'main', permissions: { push: true, admin: false } },
    git: null as ((init?: RequestInit) => Promise<Response>) | null }
  const extra = new Map<string, typeof server.detail>()
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/login/device/code') return json({ device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url.pathname === '/login/oauth/access_token') return json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
    if (url.href === 'https://api.github.com/user') return json(server.profile)
    if (url.pathname === '/user/repos') return json(server.list)
    if (url.pathname === '/repos/lab-team/paper') return json(server.detail)
    if (extra.has(url.pathname)) return json(extra.get(url.pathname))
    if (url.origin === 'https://github.com' && (url.pathname.startsWith('/lab-team/paper.git/') ||
      [...extra.values()].some(detail => url.pathname.startsWith(`/${detail.owner.login}/${detail.name}.git/`))))
      return server.git ? server.git(init) : new Response('synthetic Git bytes')
    throw new Error('Unexpected fixture endpoint; no external network permitted')
  })
  const account = new GitHubAccountService({ clientId: 'Iv1.cloud-repository-fixture', fetcher, now: () => clock, sleep: async ms => { clock += ms } })
  accounts.push(account); account.startLogin()
  await vi.waitFor(() => expect(account.status().phase).toBe('signed-in'))
  return { account, server, fetcher, extra }
}
async function connected() {
  const { account, server, fetcher } = await session(), root = await folder()
  const vault = new CredentialVault(join(await folder(), 'vault.json'))
  const forbidden = ['load', 'save', 'remove'] as const
  for (const key of forbidden) vi.spyOn(vault, key).mockRejectedValue(new Error(`Vault.${key} forbidden`))
  const legacy = new GitHubRepository(root, vault), cloud = new CloudRepository(root, account, vault)
  const selections = await account.projectSelections()
  await account.withSelectedProjectAccess(selections[0]!.handle, access => legacy.connectWithAccess(access))
  return { account, server, fetcher, root, vault, legacy, cloud }
}
async function connectedPair() {
  const { account, server, fetcher, extra } = await session()
  const second = { ...repo(), id: 84, name: 'paper-b' }
  server.list.push(second)
  extra.set('/repos/lab-team/paper-b', { ...second, default_branch: 'main', permissions: { push: true, admin: false } })
  const vaultPath = join(await folder(), 'vault.json'), vault = new CredentialVault(vaultPath)
  for (const key of ['load', 'save', 'remove'] as const) vi.spyOn(vault, key).mockRejectedValue(new Error(`Vault.${key} forbidden`))
  const selections = await account.projectSelections()
  const connect = async (id: number) => {
    const selected = selections.find(value => value.project.id === id)!
    const root = await folder(), legacy = new GitHubRepository(root, vault)
    await account.withSelectedProjectAccess(selected.handle, access => legacy.connectWithAccess(access))
    return { root, cloud: new CloudRepository(root, account, vault), id,
      url: `https://github.com/${selected.project.owner}/${selected.project.name}.git` }
  }
  return { account, fetcher, vault, vaultPath, a: await connect(42), b: await connect(84) }
}
async function commit(root: string, text: string): Promise<string> {
  await writeFile(join(root, 'main.tex'), text); await git.add({ fs, dir: root, filepath: 'main.tex' })
  return git.commit({ fs, dir: root, author, message: text })
}
async function remoteFrom(root: string): Promise<string> {
  const remote = await folder(); await cp(join(root, '.git'), join(remote, '.git'), { recursive: true })
  await git.checkout({ fs, dir: remote, ref: 'main' }); return remote
}
function fetchFrom(remote: string) {
  return vi.spyOn(git, 'fetch').mockImplementation(async options => {
    await cp(join(remote, '.git', 'objects'), join(options.dir!, '.git', 'objects'), { recursive: true })
    const oid = await git.resolveRef({ fs, dir: remote, ref: 'HEAD' })
    return { defaultBranch: 'refs/heads/main', fetchHead: oid, fetchHeadDescription: 'main' }
  })
}
async function dangerousCommit(root: string): Promise<void> {
  const oid = await git.writeBlob({ fs, dir: root, blob: Buffer.from('../outside') })
  const tree = await git.writeTree({ fs, dir: root, tree: [{ mode: '120000', path: 'escape.tex', oid, type: 'blob' }] })
  const parent = await git.resolveRef({ fs, dir: root, ref: 'HEAD' })
  const who = { ...author, timestamp: 1700000000, timezoneOffset: 0 }
  const head = await git.writeCommit({ fs, dir: root, commit: { tree, parent: [parent], author: who, committer: who, message: 'unsafe tree fixture' } })
  await git.writeRef({ fs, dir: root, ref: 'refs/heads/main', value: head, force: true })
}
afterEach(async () => {
  await Promise.allSettled(accounts.splice(0).map(account => account.logout()))
  expect(verifyGitHub).not.toHaveBeenCalled()
  audit.failClose = false; audit.clients.length = 0; audit.closed.mockClear()
  vi.restoreAllMocks(); vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('uses explicit selected readonly access to bind, without PAT verification, Vault or secrets on disk', async () => {
  const { root, vault, cloud } = await connected()
  expect(await readCloudBinding(root)).toEqual(binding)
  expect((await cloud.status()).message).toContain('内存登录会话')
  for (const name of ['paperstudio-app.json', 'paperstudio.json', 'config']) expect(await readFile(join(root, '.git', name), 'utf8')).not.toContain(token)
  expect(Object.keys(JSON.parse(await readFile(join(root, '.git', 'paperstudio-app.json'), 'utf8'))).sort()).toEqual(Object.keys(binding).sort())
  for (const key of ['load', 'save', 'remove'] as const) expect(vault[key]).not.toHaveBeenCalled()
  expect(audit.clients).toEqual([{ readOnly: true }]); expect(audit.closed).toHaveBeenCalledTimes(1)
  await expect(cloud.connect({ url: 'https://github.com/other/project', token: 'fixture-only' })).rejects.toThrow('PAT')
})

it('persists only canonical target fields, never extra Main capability properties', async () => {
  const { root, account, legacy } = await connected()
  const result = await account.withProjectAccess(42, access => legacy.connectWithAccess({ ...access,
    target: Object.assign({}, access.target, { unexpectedCredential: token }) }))
  expect(JSON.stringify(result)).not.toContain(token)
  expect(await readFile(join(root, '.git', 'paperstudio.json'), 'utf8')).not.toContain(token)
  expect(await readCloudBinding(root)).toEqual(binding)
})

it('clones a validated real Git tree through a borrowed readonly lease and records no credential', async () => {
  const { account } = await session(), remote = await folder(), root = await folder()
  await git.init({ fs, dir: remote, defaultBranch: 'main' }); await commit(remote, 'downloaded fixture')
  const clone = vi.spyOn(git, 'clone').mockImplementation(async options => {
    expect(options).toMatchObject({ noCheckout: true, singleBranch: true, noTags: true, ref: 'refs/heads/main' })
    await cp(join(remote, '.git'), join(options.dir, '.git'), { recursive: true })
    await rm(join(options.dir, '.git', 'index'), { force: true })
    await git.addRemote({ fs, dir: options.dir, remote: 'origin', url: 'https://github.com/lab-team/paper.git' })
  })
  const vault = new CredentialVault(join(await folder(), 'vault.json')), service = new GitHubRepository(root, vault)
  await account.withProjectAccess(42, access => service.cloneWithAccess(access))
  expect(clone).toHaveBeenCalledTimes(1); expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('downloaded fixture')
  expect(await readCloudBinding(root)).toEqual(binding); expect(audit.closed).toHaveBeenCalledTimes(1)
})

it('does not expand readonly access, accept structural write forgeries, or reuse expired capabilities', async () => {
  const { account, legacy } = await connected(), fetch = vi.spyOn(git, 'fetch')
  await account.withProjectAccess(42, async access => {
    await expect(legacy.syncWithAccess(access as WritableProjectAccess, 'readonly')).rejects.toThrow()
    await expect(legacy.syncWithAccess({ ...access, mode: 'write' }, 'forged')).rejects.toThrow()
  })
  let expired!: WritableProjectAccess
  await account.withWritableProjectAccess(42, async access => { expired = access })
  await expect(legacy.syncWithAccess(expired, 'expired')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

it('refreshes authorization on every sync and uploads only descendants with force:false and account authorship', async () => {
  const { account, root, cloud, fetcher, vault } = await connected()
  await writeFile(join(root, 'main.tex'), 'base'); await cloud.snapshot('base')
  const remote = await remoteFrom(root); fetchFrom(remote)
  const push = vi.spyOn(git, 'push').mockResolvedValue({ ok: true, error: null, refs: { 'refs/heads/main': { ok: true, error: '' } } })
  const before = fetcher.mock.calls.filter(([url]) => String(url) === 'https://api.github.com/user').length
  await writeFile(join(root, 'main.tex'), 'local update')
  expect(await cloud.sync('upload local')).toMatchObject({ uploaded: true, downloaded: false })
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ force: false, remoteRef: 'refs/heads/main', url: 'https://github.com/lab-team/paper.git' }))
  expect(fetcher.mock.calls.filter(([url]) => String(url) === 'https://api.github.com/user')).toHaveLength(before + 1)
  const latest = (await cloud.history())[0]!
  expect((await git.readCommit({ fs, dir: root, oid: latest.id })).commit.author.email).toBe('123+lab-user@users.noreply.github.com')
  await account.logout(); await writeFile(join(root, 'main.tex'), 'offline retained')
  await expect(cloud.sync('offline recovery')).rejects.toThrow()
  expect((await cloud.history())[0]?.summary).toBe('offline recovery')
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('offline retained')
  expect(vault.load).not.toHaveBeenCalled(); expect(vault.save).not.toHaveBeenCalled()
})

it.each(['account', 'branch', 'project', 'permissions', 'private', 'origin'])('rejects fresh %s drift before Git transfer and retains local history', async drift => {
  const { root, server, cloud } = await connected()
  await writeFile(join(root, 'main.tex'), 'retained before authorization failure')
  if (drift === 'account') server.profile.id = 124
  if (drift === 'branch') server.detail.default_branch = 'other'
  if (drift === 'project') { server.list[0]!.id = 43; server.detail.id = 43 }
  if (drift === 'permissions') server.detail.permissions.push = false
  if (drift === 'private') { server.detail.private = false; server.list[0]!.private = false }
  if (drift === 'origin') await git.setConfig({ fs, dir: root, path: 'remote.origin.url', value: 'https://github.com/other/paper.git' })
  const fetch = vi.spyOn(git, 'fetch'), push = vi.spyOn(git, 'push')
  await expect(cloud.sync('retain drift recovery')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled()
  expect((await cloud.history())[0]?.summary).toBe('retain drift recovery')
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('retained before authorization failure')
})

it('downloads only a validated fast-forward object, preserving existing shared safety checks', async () => {
  const { root, cloud } = await connected()
  await writeFile(join(root, 'main.tex'), 'base'); await cloud.snapshot('base')
  const remote = await remoteFrom(root), oid = await commit(remote, 'remote update'), fetch = fetchFrom(remote), push = vi.spyOn(git, 'push')
  expect(await cloud.sync('before download')).toMatchObject({ uploaded: false, downloaded: true })
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('remote update')
  expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(oid)
  expect(fetch).toHaveBeenCalledTimes(1); expect(push).not.toHaveBeenCalled()
})

it('preserves divergent snapshots and reports conflict rather than merging or force pushing', async () => {
  const { root, cloud } = await connected()
  await writeFile(join(root, 'main.tex'), 'base'); await cloud.snapshot('base')
  const remote = await remoteFrom(root); await commit(remote, 'remote divergence'); fetchFrom(remote)
  await writeFile(join(root, 'main.tex'), 'local divergence')
  const push = vi.spyOn(git, 'push')
  expect(await cloud.sync('recover divergence')).toMatchObject({ uploaded: false, downloaded: false, status: { conflict: true } })
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('local divergence')
  expect((await cloud.history())[0]?.summary).toBe('recover divergence'); expect(push).not.toHaveBeenCalled()
})

it('rejects unsafe fetched symlink trees before checkout', async () => {
  const { root, cloud } = await connected()
  await writeFile(join(root, 'main.tex'), 'base'); await cloud.snapshot('base')
  const remote = await remoteFrom(root); await dangerousCommit(remote); fetchFrom(remote)
  await expect(cloud.sync('before unsafe fetch')).rejects.toThrow()
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('base')
  expect(await readdir(root)).not.toContain('escape.tex')
})

it('passes the true cancellation signal through fresh authorization and borrowed Git HTTP', async () => {
  const { root, server, cloud } = await connected(), controller = new AbortController()
  await writeFile(join(root, 'main.tex'), 'work before cancel')
  let observed: AbortSignal | null = null
  server.git = async init => new Promise((_done, fail) => {
    observed = init!.signal as AbortSignal
    observed.addEventListener('abort', () => fail(new DOMException('fixture cancel', 'AbortError')), { once: true })
  })
  vi.spyOn(git, 'fetch').mockImplementation(async options => {
    await options.http!.request({ url: 'https://github.com/lab-team/paper.git/info/refs?service=git-upload-pack', method: 'GET' })
    throw new Error('aborted request must not succeed')
  })
  const result = cloud.sync('cancel recovery', { signal: controller.signal }).catch(error => error as Error)
  await vi.waitFor(() => expect(observed).not.toBeNull()); controller.abort()
  const error = await result
  expect(readRepositoryOperationFailure(error)?.cancelled).toBe(true)
  expect((observed as unknown as AbortSignal).aborted).toBe(true)
  expect((await cloud.history())[0]?.summary).toBe('cancel recovery')
  expect(audit.closed).toHaveBeenCalledTimes(2)
})

it('aborts borrowed HTTP on a shorter inner repository deadline, not only the outer account deadline', async () => {
  const { account, legacy, root, server } = await connected()
  await writeFile(join(root, 'main.tex'), 'keep on inner timeout')
  let observed: AbortSignal | null = null
  server.git = async init => new Promise((_done, fail) => {
    observed = init!.signal as AbortSignal
    observed.addEventListener('abort', () => fail(new DOMException('inner fixture timeout', 'AbortError')), { once: true })
  })
  vi.spyOn(git, 'fetch').mockImplementation(async options => {
    await options.http!.request({ url: 'https://github.com/lab-team/paper.git/info/refs?service=git-upload-pack', method: 'GET' })
    throw new Error('timed out request must not succeed')
  })
  await expect(account.withWritableProjectAccess(42, access => legacy.syncWithAccess(access, 'inner timeout recovery', { timeoutMs: 200 }))).rejects.toThrow()
  expect(observed).not.toBeNull(); expect((observed as unknown as AbortSignal).aborted).toBe(true)
  expect((await legacy.history())[0]?.summary).toBe('inner timeout recovery')
})

it('preserves a known account-client cleanup veto after a successful Git result', async () => {
  const { root, cloud } = await connected()
  await writeFile(join(root, 'main.tex'), 'base'); await cloud.snapshot('base')
  fetchFrom(await remoteFrom(root)); audit.failClose = true
  const error = await cloud.sync('before failed close').catch(error => error as Error)
  expect(readRepositoryOperationFailure(error)?.cleanupFailed).toBe(true)
  expect(String(error)).not.toContain(token)
  expect(await cloud.history()).toHaveLength(1); expect(audit.closed).toHaveBeenCalledTimes(2)
})

it('rejects invalid clone targets and unsafe cloned trees without checkout or a binding', async () => {
  const { account } = await session(), remote = await folder(), root = await folder()
  await git.init({ fs, dir: remote, defaultBranch: 'main' }); await commit(remote, 'base'); await dangerousCommit(remote)
  const vault = new CredentialVault(join(await folder(), 'vault.json')), service = new GitHubRepository(root, vault)
  const clone = vi.spyOn(git, 'clone').mockImplementation(async options => {
    await cp(join(remote, '.git'), join(options.dir, '.git'), { recursive: true })
    await rm(join(options.dir, '.git', 'index'), { force: true })
  })
  await account.withProjectAccess(42, async access => { await expect(service.cloneWithAccess(access)).rejects.toThrow() })
  expect(clone).toHaveBeenCalledTimes(1); expect(await readdir(root)).toEqual(['.git'])
  expect(await readCloudBinding(root)).toBeNull()
  clone.mockClear()
  await account.withProjectAccess(42, async access => { await expect(service.cloneWithAccess(access)).rejects.toThrow() })
  expect(clone).not.toHaveBeenCalled()
})

it.each(['owner', 'name', 'branch', 'accountId'] as const)('treats persisted binding %s as untrusted routing, never fresh authority', async field => {
  const { root, cloud } = await connected()
  await writeCloudBinding(root, { ...binding, [field]: field === 'accountId' ? 999 : 'different' })
  const fetch = vi.spyOn(git, 'fetch'), push = vi.spyOn(git, 'push')
  await expect(cloud.sync('check persisted target')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled()
})

it('disconnects the App association without deleting snapshots, clearing the account session or touching Vault', async () => {
  const { root, cloud, account, vault } = await connected()
  await writeFile(join(root, 'main.tex'), 'keep history'); await cloud.snapshot('keep history')
  await cloud.disconnect()
  expect(await readCloudBinding(root)).toBeNull(); expect(await cloud.history()).toHaveLength(1)
  expect(account.status().phase).toBe('signed-in')
  for (const key of ['load', 'save', 'remove'] as const) expect(vault[key]).not.toHaveBeenCalled()
})

it.each(['extra', 'branch', 'large', 'hardlink', 'git-link'])('fails closed on malformed or redirected binding: %s', async mode => {
  const { root } = await connected(), path = join(root, '.git', 'paperstudio-app.json')
  if (mode === 'extra') await writeFile(path, JSON.stringify({ ...binding, unexpected: true }))
  if (mode === 'branch') await writeFile(path, JSON.stringify({ ...binding, branch: '../escape' }))
  if (mode === 'large') await writeFile(path, 'x'.repeat(4096))
  if (mode === 'hardlink') {
    const outside = join(await folder(), 'binding.json'); await writeFile(outside, JSON.stringify(binding))
    await rm(path); await link(outside, path)
  }
  if (mode === 'git-link') {
    const outside = await folder(); await rm(join(root, '.git'), { recursive: true }); await symlink(outside, join(root, '.git'), 'junction')
  }
  await expect(readCloudBinding(root)).rejects.toThrow()
})

it('never falls back to the developer Vault path when the App binding is present', async () => {
  const { root, legacy, vault } = await connected()
  await writeFile(join(root, 'main.tex'), 'local work')
  await expect(legacy.sync('wrong route')).rejects.toThrow()
  await expect(legacy.connect({ url: 'https://github.com/lab-team/paper', token: 'fixture-only' })).rejects.toThrow()
  expect(vault.load).not.toHaveBeenCalled(); expect(vault.save).not.toHaveBeenCalled()
  expect((await legacy.history())[0]?.summary).toBe('wrong route')
})

it('keeps a valid binding unchanged when a write of invalid metadata is requested', async () => {
  const { root } = await connected()
  await expect(writeCloudBinding(root, { ...binding, accountId: -1 })).rejects.toThrow()
  expect(await readCloudBinding(root)).toEqual(binding)
})

it('isolates two private repositories, working files and histories in one actual memory account session', async () => {
  const { account, fetcher, vault, vaultPath, a, b } = await connectedPair()
  for (const [project, label] of [[a, 'A'], [b, 'B']] as const) {
    await writeFile(join(project.root, 'main.tex'), `${label} base only`); await project.cloud.snapshot(`${label} base history`)
  }
  const routes = new Map([[a.url, { root: a.root, remote: await remoteFrom(a.root) }],
    [b.url, { root: b.root, remote: await remoteFrom(b.root) }]])
  const fetch = vi.spyOn(git, 'fetch').mockImplementation(async options => {
    const route = routes.get(options.url!)!
    expect(route).toBeDefined(); expect(options.dir).toBe(route.root)
    const response = await options.http!.request({ url: `${options.url}/info/refs?service=git-upload-pack`, method: 'GET' })
    if (response.body) for await (const _chunk of response.body) { /* consume only synthetic Git transport bytes */ }
    await cp(join(route.remote, '.git/objects'), join(route.root, '.git/objects'), { recursive: true })
    return { fetchHead: await git.resolveRef({ fs, dir: route.remote, ref: 'HEAD' }), defaultBranch: 'refs/heads/main', fetchHeadDescription: 'main' }
  })
  const push = vi.spyOn(git, 'push').mockImplementation(async options => {
    expect(options.dir).toBe(routes.get(options.url!)?.root); expect(options.force).toBe(false)
    return { ok: true, error: null, refs: { 'refs/heads/main': { ok: true, error: '' } } }
  })
  const bMetadata = await readFile(join(b.root, '.git/paperstudio.json'), 'utf8')
  await writeFile(join(a.root, 'main.tex'), 'A changed only'); await writeFile(join(b.root, 'main.tex'), 'B changed only')
  expect(await a.cloud.sync('A sync only')).toMatchObject({ uploaded: true, downloaded: false })
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ dir: a.root, url: a.url }))
  expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ dir: a.root, url: a.url }))
  expect(await readFile(join(b.root, '.git/paperstudio.json'), 'utf8')).toBe(bMetadata)
  expect((await b.cloud.history()).map(entry => entry.summary)).toEqual(['B base history'])
  expect(await readFile(join(b.root, 'main.tex'), 'utf8')).toBe('B changed only')
  expect(await b.cloud.sync('B sync only')).toMatchObject({ uploaded: true, downloaded: false })
  expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ dir: b.root, url: b.url }))
  expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ dir: b.root, url: b.url }))
  expect(fetch).toHaveBeenCalledTimes(2); expect(push).toHaveBeenCalledTimes(2)
  for (const [project, label, name] of [[a, 'A', 'paper'], [b, 'B', 'paper-b']] as const) {
    expect(await readCloudBinding(project.root)).toEqual({ ...binding, projectId: project.id, name })
    expect(await git.getConfig({ fs, dir: project.root, path: 'remote.origin.url' })).toBe(project.url)
    const metadata = await readFile(join(project.root, '.git/paperstudio.json'), 'utf8')
    expect(JSON.parse(metadata).connection).toMatchObject({ url: project.url, repository: name })
    expect((await project.cloud.history()).map(entry => entry.summary)).toEqual([`${label} sync only`, `${label} base history`])
    expect(await readFile(join(project.root, 'main.tex'), 'utf8')).toBe(`${label} changed only`)
    const oid = await git.resolveRef({ fs, dir: project.root, ref: 'HEAD' })
    expect(Buffer.from((await git.readBlob({ fs, dir: project.root, oid, filepath: 'main.tex' })).blob).toString()).toBe(`${label} changed only`)
    for (const file of ['paperstudio-app.json', 'paperstudio.json', 'config'])
      expect(await readFile(join(project.root, '.git', file), 'utf8')).not.toContain(token)
    expect(fetcher.mock.calls.some(([url]) => String(url) === `${project.url}/info/refs?service=git-upload-pack`)).toBe(true)
  }
  const aIds = new Set((await a.cloud.history()).map(entry => entry.id))
  expect((await b.cloud.history()).every(entry => !aIds.has(entry.id))).toBe(true)
  expect(account.status().phase).toBe('signed-in')
  for (const key of ['load', 'save', 'remove'] as const) expect(vault[key]).not.toHaveBeenCalled()
  await expect(readFile(vaultPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects an A binding copied into B without rerouting B origin, pushing or overwriting either project', async () => {
  const { a, b, vault, vaultPath } = await connectedPair()
  await writeFile(join(a.root, 'main.tex'), 'A private source'); await a.cloud.snapshot('A private history')
  await writeFile(join(b.root, 'main.tex'), 'B private source'); await b.cloud.snapshot('B private history')
  const aHistory = await a.cloud.history(), aMetadata = await readFile(join(a.root, '.git/paperstudio.json'), 'utf8')
  const bMetadata = await readFile(join(b.root, '.git/paperstudio.json'), 'utf8')
  await cp(join(a.root, '.git/paperstudio-app.json'), join(b.root, '.git/paperstudio-app.json'))
  expect(await readCloudBinding(b.root)).toEqual(binding)
  expect(await git.getConfig({ fs, dir: b.root, path: 'remote.origin.url' })).toBe(b.url)
  await writeFile(join(b.root, 'main.tex'), 'B unsynced draft retained')
  const fetch = vi.spyOn(git, 'fetch').mockRejectedValue(new Error('No transfer allowed after binding copy'))
  const push = vi.spyOn(git, 'push').mockRejectedValue(new Error('No push allowed after binding copy'))
  await expect(b.cloud.sync('B rejected copy recovery')).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled()
  expect(await git.getConfig({ fs, dir: b.root, path: 'remote.origin.url' })).toBe(b.url)
  expect(await readFile(join(b.root, '.git/paperstudio.json'), 'utf8')).toBe(bMetadata)
  expect(await readFile(join(a.root, '.git/paperstudio.json'), 'utf8')).toBe(aMetadata)
  expect(await readFile(join(a.root, 'main.tex'), 'utf8')).toBe('A private source')
  expect(await readFile(join(b.root, 'main.tex'), 'utf8')).toBe('B unsynced draft retained')
  expect(await a.cloud.history()).toEqual(aHistory)
  expect((await b.cloud.history()).map(entry => entry.summary)).toEqual(['B rejected copy recovery', 'B private history'])
  for (const project of [a, b]) for (const file of ['paperstudio-app.json', 'paperstudio.json', 'config'])
    expect(await readFile(join(project.root, '.git', file), 'utf8')).not.toContain(token)
  for (const key of ['load', 'save', 'remove'] as const) expect(vault[key]).not.toHaveBeenCalled()
  await expect(readFile(vaultPath)).rejects.toMatchObject({ code: 'ENOENT' })
})
