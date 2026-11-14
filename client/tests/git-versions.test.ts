import fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { afterEach, expect, it, vi } from 'vitest'
import { GitVersions } from '../src/main/github/git-versions'
import { digest, LIMITS } from '../src/main/local/paths'

const folders: string[] = []
const alice = { name: 'Alice', email: 'alice@example.invalid', timestamp: 1_700_000_000, timezoneOffset: 0 }
const bob = { name: 'Bob', email: 'bob@example.invalid', timestamp: 1_700_000_100, timezoneOffset: 0 }
const id = (oid: string, path: string): string => `git:${oid}:${Buffer.from(path).toString('hex')}`
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(folders.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function folder(initialize = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-git-versions-'))
  folders.push(root)
  if (initialize) await git.init({ fs, dir: root, defaultBranch: 'main' })
  return root
}
async function commit(root: string, files: Record<string, string | Buffer | null>, who = alice, message = 'paper changes'): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) { await rm(join(root, path), { force: true }); await git.remove({ fs, dir: root, filepath: path }) }
    else {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), content)
      await git.add({ fs, dir: root, filepath: path })
    }
  }
  return git.commit({ fs, dir: root, author: who, message })
}
async function rawCommit(root: string, tree: string, parents: string[], who = bob): Promise<string> {
  return git.writeCommit({ fs, dir: root, commit: { tree, parent: parents, author: who, committer: who, message: 'raw commit' } })
}
async function pointHead(root: string, oid: string): Promise<void> {
  await git.writeRef({ fs, dir: root, ref: 'refs/heads/main', value: oid, force: true })
}

it('does not initialize missing Git metadata and reads empty existing repositories', async () => {
  const root = await folder(false)
  await writeFile(join(root, 'main.tex'), 'draft')
  expect(await new GitVersions(root).list()).toEqual([])
  expect(await readdir(root)).toEqual(['main.tex'])
  await expect(new GitVersions(root).detail(id('a'.repeat(40), 'main.tex'))).rejects.toThrow('有限历史')
  expect(await new GitVersions(await folder()).list()).toEqual([])
})

it('shows two commit authors, timestamps, per-file before/after and content revisions without writing the index', async () => {
  const root = await folder()
  const first = await commit(root, { 'main.tex': 'first 中文\n', 'refs.bib': '@article{one}\n' }, alice, 'initial paper')
  const second = await commit(root, { 'main.tex': 'second 中文\n' }, bob, 'revise paper')
  const index = await readFile(join(root, '.git', 'index'))
  const head = await readFile(join(root, '.git', 'refs', 'heads', 'main'))
  const versions = new GitVersions(root)
  const entries = await versions.list()
  expect(entries).toHaveLength(3)
  expect(entries[0]).toMatchObject({ id: id(second, 'main.tex'), path: 'main.tex', author: 'Bob', kind: 'save',
    date: new Date(bob.timestamp * 1000).toISOString(), beforeRevision: digest(Buffer.from('first 中文\n')), afterRevision: digest(Buffer.from('second 中文\n')) })
  expect(entries[0]!.summary).toContain('Git 提交：revise paper')
  expect(entries[0]!.summary).toContain('非实际编辑者归因')
  expect(await versions.detail(id(second, 'main.tex'))).toMatchObject({ before: 'first 中文\n', after: 'second 中文\n' })
  expect(await versions.detail(id(first, 'main.tex'))).toMatchObject({ entry: { kind: 'create', beforeRevision: null, author: 'Alice' }, before: null, after: 'first 中文\n' })
  expect(await readFile(join(root, '.git', 'index'))).toEqual(index)
  expect(await readFile(join(root, '.git', 'refs', 'heads', 'main'))).toEqual(head)
})

it('refuses existing unreachable objects without reading the requested commit or blob', async () => {
  const root = await folder()
  const head = await commit(root, { 'main.tex': 'visible' })
  const tree = (await git.readCommit({ fs, dir: root, oid: head })).commit.tree
  const orphan = await rawCommit(root, tree, [])
  const spy = vi.spyOn(git, 'readCommit')
  const blobs = vi.spyOn(git, 'readBlob')
  await expect(new GitVersions(root).detail(id(orphan, 'main.tex'))).rejects.toThrow('有限历史')
  expect(spy.mock.calls.map(([options]) => options.oid)).not.toContain(orphan)
  expect(blobs).not.toHaveBeenCalled()
  await expect(new GitVersions(root).detail(id('f'.repeat(40), 'main.tex'))).rejects.toThrow('有限历史')
})

it('rejects malformed IDs, unsafe paths, private metadata and unsupported extensions before traversing Git', async () => {
  const root = await folder()
  const oid = await commit(root, { 'main.tex': 'safe' })
  const spy = vi.spyOn(git, 'readCommit')
  const paths = ['../main.tex', '/main.tex', 'folder/../main.tex', 'C:/main.tex', 'folder\\main.tex', '.git/config',
    '.paperstudio/history.json', '.env', 'secrets.txt', 'main.aux', 'image.png', 'CON.txt', 'main.tex:stream']
  for (const path of paths) await expect(new GitVersions(root).detail(id(oid, path))).rejects.toThrow()
  for (const value of ['git:bad:00', `git:${oid}:f`, `git:${oid}:ff`, `git:${oid.toUpperCase()}:6d`, `git:${oid}:6D`, 'x'.repeat(9000)])
    await expect(new GitVersions(root).detail(value)).rejects.toThrow()
  expect(spy).not.toHaveBeenCalled()
})

it('skips binary bytes, invalid UTF-8, excluded paths and deleted files; deleted after snapshots cannot be restored', async () => {
  const root = await folder()
  const first = await commit(root, { 'main.tex': 'safe', 'gone.tex': 'delete me', 'binary.tex': Buffer.from([65, 0, 66]),
    'invalid.tex': Buffer.from([0xc3, 0x28]), '.env': 'secret', 'secrets.txt': 'secret', 'image.png': 'not a text extension' })
  const second = await commit(root, { 'gone.tex': null }, bob)
  const versions = new GitVersions(root)
  expect((await versions.list()).map(entry => entry.path)).toEqual(['main.tex'])
  for (const [oid, path] of [[first, 'gone.tex'], [second, 'gone.tex'], [first, 'binary.tex'], [first, 'invalid.tex']])
    await expect(versions.detail(id(oid!, path!))).rejects.toThrow()
})

it('requires a currently present, safe UTF-8 text target even if the historical blob is text', async () => {
  const root = await folder()
  const oid = await commit(root, { 'main.tex': 'original' })
  await writeFile(join(root, 'main.tex'), Buffer.from([0xff]))
  expect(await new GitVersions(root).list()).toEqual([])
  await expect(new GitVersions(root).detail(id(oid, 'main.tex'))).rejects.toThrow('可恢复')
})

it('handles canonical UTF-8 path IDs and preserves BOM and Unicode text', async () => {
  const root = await folder()
  const path = '章节/论文.tex', content = '\ufeff中文 α 😀\n'
  const oid = await commit(root, { [path]: content })
  const versions = new GitVersions(root)
  expect((await versions.list())[0]).toMatchObject({ id: id(oid, path), path })
  expect((await versions.detail(id(oid, path))).after).toBe(content)
})

it('skips oversized historical blobs before decoding, even if the current file is small', async () => {
  const root = await folder()
  const oid = await commit(root, { 'main.tex': Buffer.alloc(LIMITS.text + 1, 97) })
  await writeFile(join(root, 'main.tex'), 'current small draft')
  const versions = new GitVersions(root)
  expect(await versions.list()).toEqual([])
  await expect(versions.detail(id(oid, 'main.tex'))).rejects.toThrow('可恢复')
})

it('does not invent changes for an unchanged file in a later commit', async () => {
  const root = await folder()
  await commit(root, { 'main.tex': 'unchanged' })
  const oid = await commit(root, { 'notes.txt': 'new file' }, bob)
  expect((await new GitVersions(root).list()).filter(entry => entry.path === 'main.tex')).toHaveLength(1)
  await expect(new GitVersions(root).detail(id(oid, 'main.tex'))).rejects.toThrow('没有可恢复')
})

it('compares merge commits only against their first parent while including reachable branch commits', async () => {
  const root = await folder()
  const base = await commit(root, { 'main.tex': 'base' })
  const left = await commit(root, { 'main.tex': 'left' }, bob)
  const rightBlob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('right') })
  const rightTree = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', type: 'blob', path: 'main.tex', oid: rightBlob }] })
  const right = await rawCommit(root, rightTree, [base], { ...alice, timestamp: bob.timestamp + 10 })
  const merged = await rawCommit(root, rightTree, [left, right], { ...bob, timestamp: bob.timestamp + 20 })
  await pointHead(root, merged)
  await writeFile(join(root, 'main.tex'), 'right')
  const versions = new GitVersions(root)
  expect(await versions.detail(id(merged, 'main.tex'))).toMatchObject({ before: 'left', after: 'right' })
  expect((await versions.list()).some(entry => entry.id === id(right, 'main.tex'))).toBe(true)
})

it('sorts entries by Git author time rather than traversal order', async () => {
  const root = await folder()
  const first = await commit(root, { 'main.tex': 'first' }, bob)
  const second = await commit(root, { 'main.tex': 'second' }, alice)
  expect((await new GitVersions(root).list()).map(entry => entry.id)).toEqual([id(first, 'main.tex'), id(second, 'main.tex')])
})

it('caps the visible file entries at 200', async () => {
  const root = await folder()
  const paths = Array.from({ length: 201 }, (_, index) => `f${String(index).padStart(3, '0')}.txt`)
  await Promise.all(paths.map(path => writeFile(join(root, path), 'file contents')))
  const blob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('file contents') })
  const tree = await git.writeTree({ fs, dir: root, tree: paths.map(path => ({ mode: '100644', type: 'blob', path, oid: blob })) })
  await pointHead(root, await rawCommit(root, tree, []))
  expect(await new GitVersions(root).list()).toHaveLength(200)
}, 15_000)

it('rejects IDs beyond the current 100-commit traversal window', async () => {
  const root = await folder()
  const first = await commit(root, { 'main.tex': 'oldest' })
  let parent = first
  const tree = (await git.readCommit({ fs, dir: root, oid: first })).commit.tree
  for (let index = 0; index < 100; index++) parent = await rawCommit(root, tree, [parent], { ...bob, timestamp: bob.timestamp + index })
  await pointHead(root, parent)
  const spy = vi.spyOn(git, 'readCommit')
  await expect(new GitVersions(root).detail(id(first, 'main.tex'))).rejects.toThrow('有限历史')
  expect(spy).toHaveBeenCalledTimes(100)
  expect(spy.mock.calls.map(([options]) => options.oid)).not.toContain(first)
})

it('skips dangerous tree entries and symlink blobs instead of exposing them', async () => {
  const root = await folder()
  const first = await commit(root, { 'main.tex': 'safe' })
  const blob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('unsafe contents') })
  const tree = await git.writeTree({ fs, dir: root, tree: [
    { mode: '100644', type: 'blob', path: '.env', oid: blob },
    { mode: '120000', type: 'blob', path: 'linked.tex', oid: blob }, { mode: '100644', type: 'blob', path: 'main.tex', oid: blob }
  ] })
  await pointHead(root, await rawCommit(root, tree, [first]))
  expect((await new GitVersions(root).list()).every(entry => entry.path === 'main.tex')).toBe(true)
})

it('fails closed when the Git library rejects a traversal path encoded in a real tree', async () => {
  const root = await folder()
  await commit(root, { 'main.tex': 'safe' })
  const blob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('outside') })
  const tree = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', type: 'blob', path: '..', oid: blob }] })
  await pointHead(root, await rawCommit(root, tree, []))
  await expect(new GitVersions(root).list()).rejects.toThrow('unsafe')
})
