import fs from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import git from 'isomorphic-git'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('../src/main/github/transport', () => ({
  verifyGitHub: vi.fn(async () => ({ login: 'alice', id: 42, branch: 'main' })),
  githubHttp: vi.fn(() => ({ request: vi.fn(() => { throw new Error('No real network in fixtures') }), close: vi.fn(async () => {}) }))
}))
import { CredentialVault } from '../src/main/github/credentials'
import { GitHubRepository } from '../src/main/github/repository'
import { mergeCommentDivergence } from '../src/main/github/comment-merge'
import { verifyGitHub } from '../src/main/github/transport'

const folders: string[] = []
const settings = { url: 'https://github.com/team/paper', token: 'ghp_fixturetoken' }
const author = { name: 'Fixture', email: 'fixture@users.noreply.github.com' }
const mine = `.latexstudio/comments/${'a'.repeat(32)}.jsonl`, theirs = `.latexstudio/comments/${'b'.repeat(32)}.jsonl`
const accepted = { ok: true, error: null, refs: { 'refs/heads/main': { ok: true, error: '' } } }
beforeEach(() => { vi.mocked(verifyGitHub).mockResolvedValue({ login: 'alice', id: 42, branch: 'main' }) })
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'latexstudio-merge-'))
  folders.push(root)
  return root
}
async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}
/** A linked local paper and a separate "remote" copy that share one synced base commit. */
async function linked(): Promise<{ root: string; remote: string; service: GitHubRepository }> {
  const root = await folder()
  const service = new GitHubRepository(root, new CredentialVault(join(await folder(), 'vault.json')))
  await service.connect(settings)
  await put(root, 'main.tex', 'base paper')
  await put(root, mine, 'base comment\n')
  await service.snapshot('base')
  const remote = await folder()
  await cp(join(root, '.git'), join(remote, '.git'), { recursive: true })
  await git.checkout({ fs, dir: remote, ref: 'main' })
  return { root, remote, service }
}
async function remoteCommit(remote: string, files: Record<string, string | null>): Promise<string> {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) { await unlink(join(remote, path)); await git.remove({ fs, dir: remote, filepath: path }) }
    else { await put(remote, path, text); await git.add({ fs, dir: remote, filepath: path }) }
  }
  return git.commit({ fs, dir: remote, author, message: 'remote change' })
}
function fetchFrom(remote: string): void {
  vi.spyOn(git, 'fetch').mockImplementation(async options => {
    const root = options.dir!
    await cp(join(remote, '.git', 'objects'), join(root, '.git', 'objects'), { recursive: true })
    const oid = await git.resolveRef({ fs, dir: remote, ref: 'HEAD' })
    await git.writeRef({ fs, dir: root, ref: 'refs/remotes/origin/main', value: oid, force: true })
    return { defaultBranch: 'refs/heads/main', fetchHead: oid, fetchHeadDescription: 'main' }
  })
}
async function head(root: string): Promise<{ oid: string; parents: string[] }> {
  const oid = await git.resolveRef({ fs, dir: root, ref: 'HEAD' })
  return { oid, parents: (await git.readCommit({ fs, dir: root, oid })).commit.parent }
}

it('merges my new comments with a collaborator\'s paper edit and uploads the merge without force', async () => {
  const { root, remote, service } = await linked()
  const remoteHead = await remoteCommit(remote, { 'main.tex': 'collaborator edit', 'figures/plot.txt': 'data' })
  await put(root, mine, 'base comment\nmy new comment\n')
  fetchFrom(remote)
  const push = vi.spyOn(git, 'push').mockResolvedValue(accepted)
  const result = await service.sync('my comments')
  expect(result).toMatchObject({ uploaded: true, downloaded: true, message: '已自动合并双方的评论并同步到 GitHub。' })
  expect(result.status.conflict).toBe(false)
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('collaborator edit')
  expect(await readFile(join(root, 'figures/plot.txt'), 'utf8')).toBe('data')
  expect(await readFile(join(root, mine), 'utf8')).toBe('base comment\nmy new comment\n')
  const merged = await head(root)
  expect(merged.parents).toHaveLength(2)
  expect(merged.parents[1]).toBe(remoteHead)
  expect(push).toHaveBeenCalledOnce()
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ force: false, ref: 'refs/heads/main' }))
  expect((await service.status()).changes).toEqual([])
})

it('merges a collaborator\'s comments into my paper edit', async () => {
  const { root, remote, service } = await linked()
  await remoteCommit(remote, { [theirs]: 'their comment\n' })
  await put(root, 'main.tex', 'my paper edit')
  fetchFrom(remote)
  const push = vi.spyOn(git, 'push').mockResolvedValue(accepted)
  const result = await service.sync('my edit')
  expect(result).toMatchObject({ uploaded: true, downloaded: true })
  expect(await readFile(join(root, theirs), 'utf8')).toBe('their comment\n')
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('my paper edit')
  expect((await head(root)).parents).toHaveLength(2)
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  expect((await service.status()).changes).toEqual([])
})

it('merges when both sides only added comments in their own files', async () => {
  const { root, remote, service } = await linked()
  await remoteCommit(remote, { [theirs]: 'their comment\n' })
  await put(root, mine, 'base comment\nmine too\n')
  fetchFrom(remote)
  const push = vi.spyOn(git, 'push').mockResolvedValue(accepted)
  expect((await service.sync('comments')).status.conflict).toBe(false)
  expect(await readFile(join(root, theirs), 'utf8')).toBe('their comment\n')
  expect(await readFile(join(root, mine), 'utf8')).toBe('base comment\nmine too\n')
  expect(push).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  expect((await service.status()).changes).toEqual([])
})

it.each([
  ['both sides edited the paper', { 'main.tex': 'their edit' }, { 'main.tex': 'my edit' }],
  ['both sides edited different paper files', { 'intro.tex': 'their intro' }, { 'main.tex': 'my edit' }],
  ['both sides wrote the same comment file', { [mine]: 'base comment\ntheirs\n' }, { [mine]: 'base comment\nmine\n' }],
  ['my side deleted a comment log', { 'main.tex': 'their edit' }, { [mine]: null }],
  ['their side rewrote an existing comment log instead of appending', { [mine]: 'forged line\n' }, { 'main.tex': 'my edit' }],
  ['their side truncated an existing comment log', { [mine]: '' }, { 'main.tex': 'my edit' }],
  ['my side changed a file next to the comment logs', { 'main.tex': 'their edit' }, { '.latexstudio/notes.txt': 'x' }]
])('keeps the existing conflict stop when %s', async (_name, remoteFiles, localFiles) => {
  const { root, remote, service } = await linked()
  await remoteCommit(remote, remoteFiles)
  for (const [path, text] of Object.entries(localFiles)) {
    if (text === null) await unlink(join(root, path)); else await put(root, path, text)
  }
  fetchFrom(remote)
  const push = vi.spyOn(git, 'push')
  const before = await readFile(join(root, 'main.tex'), 'utf8')
  const result = await service.sync('local work')
  expect(result.status.conflict).toBe(true)
  expect(result).toMatchObject({ uploaded: false, downloaded: false })
  expect(push).not.toHaveBeenCalled()
  expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe(before)
  expect((await head(root)).parents).toHaveLength(1)
})

it('gives up quickly instead of walking a tree that repeats one folder many times', async () => {
  const root = await folder()
  await git.init({ fs, dir: root, defaultBranch: 'main' })
  const blob = (text: string): Promise<string> => git.writeBlob({ fs, dir: root, blob: Buffer.from(text) })
  let nested = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', path: 'f.txt', oid: await blob('x'), type: 'blob' }] })
  for (let level = 0; level < 3; level++) {
    nested = await git.writeTree({ fs, dir: root, tree: Array.from({ length: 60 }, (_, i) => ({ mode: '040000', path: `d${i}`, oid: nested, type: 'tree' as const })) })
  }
  const withComment = async (path: string): Promise<string> => {
    const comments = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', path, oid: await blob('c\n'), type: 'blob' }] })
    const folderTree = await git.writeTree({ fs, dir: root, tree: [{ mode: '040000', path: 'comments', oid: comments, type: 'tree' }] })
    return git.writeTree({ fs, dir: root, tree: [{ mode: '040000', path: '.latexstudio', oid: folderTree, type: 'tree' }, { mode: '040000', path: 'big', oid: nested, type: 'tree' }] })
  }
  const stamp = { ...author, timestamp: 1_700_000_000, timezoneOffset: 0 }
  const commit = (tree: string, parent: string[]): Promise<string> => git.writeCommit({ fs, dir: root, commit: { tree, parent, author: stamp, committer: stamp, message: 'fixture' } })
  const base = await commit(await git.writeTree({ fs, dir: root, tree: [{ mode: '040000', path: 'big', oid: nested, type: 'tree' }] }), [])
  const ours = await commit(await withComment(`${'a'.repeat(32)}.jsonl`), [base]), others = await commit(await withComment(`${'b'.repeat(32)}.jsonl`), [base])
  const started = Date.now()
  expect(await mergeCommentDivergence(root, ours, others, author)).toBeNull()
  expect(Date.now() - started).toBeLessThan(20_000)
})

it('reports a rejected upload after merging and merges again on the next sync', async () => {
  const { root, remote, service } = await linked()
  await remoteCommit(remote, { 'main.tex': 'collaborator edit' })
  await put(root, mine, 'base comment\nmine\n')
  fetchFrom(remote)
  vi.spyOn(git, 'push').mockResolvedValueOnce({ ok: false, error: 'rejected', refs: {} }).mockResolvedValue(accepted)
  const rejected = await service.sync('first try')
  expect(rejected.status.conflict).toBe(true)
  expect(rejected.message).toBe('已在本地合并双方的评论，但远端拒绝上传，可能又有新的更改；请重新同步。')
  await remoteCommit(remote, { [theirs]: 'later comment\n' })
  const retried = await service.sync('second try')
  expect(retried).toMatchObject({ uploaded: true, downloaded: true })
  expect(retried.status.conflict).toBe(false)
  expect(await readFile(join(root, theirs), 'utf8')).toBe('later comment\n')
  expect(await readFile(join(root, mine), 'utf8')).toBe('base comment\nmine\n')
})
