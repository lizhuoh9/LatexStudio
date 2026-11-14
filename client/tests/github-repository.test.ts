import fs from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('../src/main/github/transport', () => ({
  verifyGitHub: vi.fn(async () => ({ login: 'alice', id: 42, branch: 'main' })),
  githubHttp: vi.fn(() => ({ request: vi.fn(() => { throw new Error('No real network in fixtures') }), close: vi.fn(async () => {}) }))
}))
import { CredentialVault } from '../src/main/github/credentials'
import { GitHubRepository } from '../src/main/github/repository'
import { githubTarget, safeBranch, safePath } from '../src/main/github/policy'
import { githubHttp, verifyGitHub } from '../src/main/github/transport'

const folders: string[] = []
const settings = { url: 'https://github.com/team/paper', token: 'ghp_fixturetoken' }
const author = { name: 'Fixture', email: 'fixture@users.noreply.github.com' }
afterEach(async () => {
  for (const result of vi.mocked(githubHttp).mock.results) if (result.type === 'return') expect(result.value.close).toHaveBeenCalledTimes(1)
  vi.restoreAllMocks()
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
beforeEach(() => {
  vi.mocked(githubHttp).mockClear()
  vi.mocked(verifyGitHub).mockResolvedValue({ login: 'alice', id: 42, branch: 'main' })
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-github-'))
  folders.push(root)
  return root
}
async function repository(): Promise<{ root: string; service: GitHubRepository }> {
  const root = await folder()
  return { root, service: new GitHubRepository(root, new CredentialVault(join(await folder(), 'vault.json'))) }
}
async function commit(root: string, text: string): Promise<string> {
  await writeFile(join(root, 'main.tex'), text)
  await git.add({ fs, dir: root, filepath: 'main.tex' })
  return git.commit({ fs, dir: root, author, message: text })
}
async function remoteFrom(root: string): Promise<string> {
  const remote = await folder()
  await cp(join(root, '.git'), join(remote, '.git'), { recursive: true })
  await git.checkout({ fs, dir: remote, ref: 'main' })
  return remote
}
function fetchFrom(remote: string): void {
  vi.spyOn(git, 'fetch').mockImplementation(async (options) => {
    const root = options.dir!
    await cp(join(remote, '.git', 'objects'), join(root, '.git', 'objects'), { recursive: true })
    const oid = await git.resolveRef({ fs, dir: remote, ref: 'HEAD' })
    await git.writeRef({ fs, dir: root, ref: 'refs/remotes/origin/main', value: oid, force: true })
    return { defaultBranch: 'refs/heads/main', fetchHead: oid, fetchHeadDescription: 'main' }
  })
}
async function dangerousCommit(root: string, mode: string, path: string): Promise<void> {
  const oid = await git.writeBlob({ fs, dir: root, blob: Buffer.from('../outside') })
  const tree = await git.writeTree({ fs, dir: root, tree: [{ mode, path, oid, type: 'blob' }] })
  const parent = await git.resolveRef({ fs, dir: root, ref: 'HEAD' }).catch(() => null)
  const head = await git.writeCommit({ fs, dir: root, commit: { tree, parent: parent ? [parent] : [],
    author: { ...author, timestamp: 1_700_000_000, timezoneOffset: 0 },
    committer: { ...author, timestamp: 1_700_000_000, timezoneOffset: 0 }, message: 'unsafe fixture' } })
  await git.writeRef({ fs, dir: root, ref: 'refs/heads/main', value: head, force: true })
}
function cloneFrom(remote: string): void {
  vi.spyOn(git, 'clone').mockImplementation(async (options) => {
    expect(options.noCheckout).toBe(true)
    await cp(join(remote, '.git'), join(options.dir, '.git'), { recursive: true })
    await rm(join(options.dir, '.git', 'index'), { force: true }) // noCheckout clone has no populated index
    await git.addRemote({ fs, dir: options.dir, remote: 'origin', url: 'https://github.com/team/paper.git', force: true })
  })
}

  it('keeps local snapshots offline, honors ignores and excludes credentials/build artifacts', async () => {
    const { root, service } = await repository()
    await writeFile(join(root, 'main.tex'), 'first')
    await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(root, 'ignored.txt'), 'ignored')
    await writeFile(join(root, '.env'), 'TOKEN=fixture')
    await writeFile(join(root, 'main.aux'), 'build artifact')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'package.json'), '{}')
    expect((await service.status()).changes.map((item) => item.path).sort()).toEqual(['.gitignore', 'main.tex'])
    const first = await service.snapshot('first local version')
    expect(first?.summary).toBe('first local version')
    expect(await service.snapshot('unchanged')).toBeNull()
    expect(await git.listFiles({ fs, dir: root })).toEqual(['.gitignore', 'main.tex'])
    const history = await service.history()
    expect(history).toHaveLength(1)
    expect((await git.readCommit({ fs, dir: root, oid: history[0]!.id })).commit.author.email).toBe('paperstudio@users.noreply.github.com')
    await writeFile(join(root, 'main.tex'), 'second')
    expect((await service.sync('second local version')).uploaded).toBe(false)
    expect(await service.history()).toHaveLength(2)
    await rm(join(root, 'main.tex'))
    expect((await service.status()).changes).toContainEqual({ path: 'main.tex', kind: 'deleted' })
    await service.snapshot('remove file')
    expect(await git.listFiles({ fs, dir: root })).toEqual(['.gitignore'])
  })

  it('associates only the intended existing remote and stores no token in metadata or URL', async () => {
    const { root, service } = await repository()
    const connection = await service.connect(settings)
    expect(connection).toEqual({ url: `${settings.url}.git`, owner: 'team', repository: 'paper', login: 'alice', branch: 'main' })
    expect(verifyGitHub).toHaveBeenCalledWith(githubTarget(settings.url), settings.token, { signal: expect.any(AbortSignal) })
    expect(JSON.stringify(await service.status())).not.toContain(settings.token)
    expect((await service.status()).message).toContain('仅保留在内存')
    expect(await readFile(join(root, '.git', 'paperstudio.json'), 'utf8')).not.toContain(settings.token)
    expect(await readFile(join(root, '.git', 'config'), 'utf8')).not.toContain(settings.token)
    vi.mocked(verifyGitHub).mockClear()
    await expect(service.connect({ ...settings, url: 'https://github.com/other/paper' })).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(verifyGitHub).not.toHaveBeenCalled()
    expect(githubHttp).not.toHaveBeenCalled()
    expect(await git.getConfig({ fs, dir: root, path: 'remote.origin.url' })).toBe(`${settings.url}.git`)
    await service.disconnect()
    expect((await service.status()).connection).toBeNull()
    expect((await service.status()).message).not.toContain(settings.token)
  })

  it('reads the actual remote default branch and refuses silently changing existing local history', async () => {
    const empty = await repository()
    vi.mocked(verifyGitHub).mockResolvedValue({ login: 'alice', id: 42, branch: 'papers/default' })
    expect((await empty.service.connect(settings)).branch).toBe('papers/default')
    expect(await git.currentBranch({ fs, dir: empty.root })).toBe('papers/default')
    const existing = await repository()
    await writeFile(join(existing.root, 'main.tex'), 'local')
    await existing.service.snapshot('local first')
    await expect(existing.service.connect(settings)).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(await existing.service.history()).toHaveLength(1)
    expect(await git.currentBranch({ fs, dir: existing.root })).toBe('main')
  })

  it('saves a recoverable local snapshot before any failing network request and sanitizes failures', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'unsaved local work')
    vi.mocked(verifyGitHub).mockRejectedValueOnce(new Error(`Authorization: Bearer ${settings.token}`))
    const result = await service.sync('recover me').catch((error: Error) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result).toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(String(result)).not.toContain(settings.token)
    expect((await service.history())[0]?.summary).toBe('recover me')
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('unsaved local work')
  })

  it('rejects downloads into nonempty directories before making network requests', async () => {
    const { root, service } = await repository()
    await writeFile(join(root, 'keep.tex'), 'keep me')
    vi.mocked(verifyGitHub).mockClear()
    await expect(service.clone(settings)).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: false })
    expect(githubHttp).not.toHaveBeenCalled()
    expect(verifyGitHub).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'keep.tex'), 'utf8')).toBe('keep me')
  })

  it('downloads only a validated fast-forward object and never performs a second network fetch', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'base')
    await service.snapshot('base')
    const remote = await remoteFrom(root)
    const oid = await commit(remote, 'remote update')
    fetchFrom(remote)
    const push = vi.spyOn(git, 'push')
    const result = await service.sync('no local changes')
    expect(result).toMatchObject({ uploaded: false, downloaded: true })
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('remote update')
    expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(oid)
    expect(git.fetch).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })

  it('returns an explicit conflict without overwriting divergent local snapshots or force pushing', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'base')
    await service.snapshot('base')
    const remote = await remoteFrom(root)
    await commit(remote, 'remote side')
    await writeFile(join(root, 'main.tex'), 'local side')
    fetchFrom(remote)
    const push = vi.spyOn(git, 'push')
    const result = await service.sync('local before conflict')
    expect(result.status.conflict).toBe(true)
    expect(result).toMatchObject({ uploaded: false, downloaded: false })
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('local side')
    expect((await service.history())[0]?.summary).toBe('local before conflict')
    expect(push).not.toHaveBeenCalled()
  })

  it('uploads only a descendant using force:false and public noreply authorship', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'base')
    await service.snapshot('base')
    const remote = await remoteFrom(root)
    fetchFrom(remote)
    const push = vi.spyOn(git, 'push').mockResolvedValue({ ok: true, error: null, refs: { 'refs/heads/main': { ok: true, error: '' } } })
    await writeFile(join(root, 'main.tex'), 'local update')
    const result = await service.sync('upload local')
    expect(result).toMatchObject({ uploaded: true, downloaded: false })
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ force: false, ref: 'refs/heads/main', remoteRef: 'refs/heads/main', url: `${settings.url}.git` }))
    const latest = (await service.history())[0]!
    expect((await git.readCommit({ fs, dir: root, oid: latest.id })).commit.author.email).toBe('42+alice@users.noreply.github.com')
  })

  it('reports explicit conflict when the remote rejects an upload after a concurrent update', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'base')
    await service.snapshot('base')
    const remote = await remoteFrom(root)
    fetchFrom(remote)
    vi.spyOn(git, 'push').mockResolvedValue({ ok: false, error: 'Authorization: ghp_do-not-display', refs: {} })
    await writeFile(join(root, 'main.tex'), 'recoverable local update')
    const result = await service.sync('saved before rejected upload')
    expect(result.status.conflict).toBe(true)
    expect(result.uploaded).toBe(false)
    expect(JSON.stringify(result)).not.toContain('ghp_do-not-display')
    expect((await service.history())[0]?.summary).toBe('saved before rejected upload')
  })

  it.each(['120000', '160000'])('rejects remote mode %s before clone checkout or project writes', async (mode) => {
    const remote = await folder()
    await git.init({ fs, dir: remote, defaultBranch: 'main' })
    await dangerousCommit(remote, mode, 'escape')
    cloneFrom(remote)
    const target = await repository()
    const checkout = vi.spyOn(git, 'checkout')
    await expect(target.service.clone(settings)).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(checkout).not.toHaveBeenCalled()
    expect(await readdir(target.root)).toEqual(['.git'])
  })

  it('rejects a remote symlink during sync before replacing local files', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'safe local')
    await service.snapshot('base')
    const remote = await remoteFrom(root)
    await dangerousCommit(remote, '120000', 'escape')
    fetchFrom(remote)
    await expect(service.sync('before unsafe remote')).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('safe local')
    expect(await readdir(root)).not.toContain('escape')
  })

  it('keeps ignored local files untouched if an incoming tracked file collides', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, '.gitignore'), 'notes.txt\n')
    await writeFile(join(root, 'main.tex'), 'base')
    await service.snapshot('base')
    const remote = await remoteFrom(root)
    await writeFile(join(remote, 'notes.txt'), 'remote content')
    await git.add({ fs, dir: remote, filepath: 'notes.txt', force: true })
    await git.commit({ fs, dir: remote, author, message: 'track notes' })
    await writeFile(join(root, 'notes.txt'), 'ignored local content')
    fetchFrom(remote)
    await expect(service.sync('before collision')).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('ignored local content')
  })

  it.each(['../outside', '.git', 'C:escape'])('rejects a malicious remote tree path %s before checkout', async (path) => {
    const remote = await folder()
    await git.init({ fs, dir: remote, defaultBranch: 'main' })
    await dangerousCommit(remote, '100644', path)
    cloneFrom(remote)
    const { service } = await repository()
    const checkout = vi.spyOn(git, 'checkout')
    await expect(service.clone(settings)).rejects.toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: true })
    expect(checkout).not.toHaveBeenCalled()
  })

  it('rejects local junctions without reading or saving their outside contents', async () => {
    const { root, service } = await repository()
    const outside = await folder()
    await writeFile(join(outside, 'secret.tex'), 'outside data')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.snapshot('must not follow links')).rejects.toThrow('符号链接')
    expect(await service.history()).toEqual([])
    expect(await readFile(join(outside, 'secret.tex'), 'utf8')).toBe('outside data')
  })

  it('initializes an empty remote default history before the first local snapshot', async () => {
    const { root, service } = await repository()
    vi.mocked(verifyGitHub).mockResolvedValue({ login: 'alice', id: 42, branch: 'papers/default' })
    vi.spyOn(git, 'clone').mockImplementation(async (options) => {
      await git.init({ fs, dir: options.dir, defaultBranch: 'master' })
      await git.addRemote({ fs, dir: options.dir, remote: 'origin', url: `${settings.url}.git` })
    })
    await service.clone(settings)
    await writeFile(join(root, 'main.tex'), 'first local work')
    await service.snapshot('first')
    expect(await git.currentBranch({ fs, dir: root })).toBe('papers/default')
  })

  it('uploads a local snapshot to a verified empty remote without force', async () => {
    const { root, service } = await repository()
    await service.connect(settings)
    await writeFile(join(root, 'main.tex'), 'first local work')
    vi.spyOn(git, 'fetch').mockResolvedValue({ defaultBranch: null, fetchHead: null, fetchHeadDescription: null })
    const push = vi.spyOn(git, 'push').mockResolvedValue({ ok: true, error: null,
      refs: { 'refs/heads/main': { ok: true, error: '' } } })
    expect((await service.sync('first sync')).uploaded).toBe(true)
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  })

  it('does not confuse a tag sharing the remote default branch name with that branch', async () => {
    const remote = await folder()
    await git.init({ fs, dir: remote, defaultBranch: 'main' })
    const old = await commit(remote, 'older tag contents')
    await git.writeRef({ fs, dir: remote, ref: 'refs/tags/main', value: old })
    await commit(remote, 'actual default branch contents')
    cloneFrom(remote)
    const { root, service } = await repository()
    await service.clone(settings)
    expect(git.clone).toHaveBeenCalledWith(expect.objectContaining({ ref: 'refs/heads/main' }))
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('actual default branch contents')
  })

  it('performs a validated checkout only after noCheckout clone inspection succeeds', async () => {
    const remote = await folder()
    await git.init({ fs, dir: remote, defaultBranch: 'main' })
    await commit(remote, 'safe download')
    cloneFrom(remote)
    const { root, service } = await repository()
    await service.clone(settings)
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('safe download')
    expect((await service.status()).changes).toEqual([])
  })

  it.each(['http://github.com/a/b', 'https://github.com.evil/a/b', 'https://user:secret@github.com/a/b',
    'https://github.com/a/b?token=secret', 'https://github.com/a/b#secret', 'https://github.com/a/b/../other',
    'https://github.com/a/%2e%2e', 'https://github.com/a/b/extra', 'https://github.com:444/a/b'])('rejects unsafe repository URL %s', (url) => {
    expect(() => githubTarget(url)).toThrow()
  })
  it.each(['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'C:/escape', '.git/config', 'a/.GiT/config', 'a/CON.tex', 'a/trailing.'])('rejects unsafe path %s', (path) => {
    expect(() => safePath('D:/fixture', path)).toThrow()
  })
  it.each(['../escape', 'a.lock', 'a..b', 'a\\b', 'HEAD', 'a@{b', '/absolute'])('rejects unsafe default branch %s', (branch) => {
    expect(() => safeBranch(branch)).toThrow()
  })
