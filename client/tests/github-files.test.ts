import fs from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import git from 'isomorphic-git'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertWorkingFiles, hasRepository, validateTree, type ValidatedTrees } from '../src/main/github/files'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-github-files-')); roots.push(root); return root
}
async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content)
  }
}
const LINK = process.platform === 'win32' ? 'junction' : 'dir'
const author = { name: 'fixture', email: 'fixture@example.invalid' }
async function commit(root: string, files: Record<string, string>): Promise<string> {
  await write(root, files)
  for (const path of Object.keys(files)) await git.add({ fs, dir: root, filepath: path })
  return git.commit({ fs, dir: root, author, message: 'fixture' })
}

describe('working folder check before a snapshot or sync', () => {
  it('accepts ordinary nested files without asking Git about ignore rules for each of them', async () => {
    // Arrange
    const root = await folder(), ignored = vi.spyOn(git, 'isIgnored')
    await write(root, { 'main.tex': 'm', 'chapters/one.tex': '1', 'chapters/deep/two.tex': '2', 'main.aux': 'build output',
      '.gitignore': '*.aux\n', 'node_modules/pkg/index.js': 'dependency' })

    // Act
    const result = await assertWorkingFiles(root)

    // Assert
    expect(result).toBeUndefined()
    expect(ignored).not.toHaveBeenCalled()
  })

  it('refuses a link deep in the folder, and a link whose own name is one that is never synced', async () => {
    const root = await folder(), outside = await folder()
    await write(root, { 'main.tex': 'm', 'a/b/one.tex': '1' })
    await symlink(outside, join(root, 'node_modules'), LINK)
    await expect(assertWorkingFiles(root)).rejects.toThrow('符号链接')
    await rm(join(root, 'node_modules'), { recursive: true, force: true })
    await expect(assertWorkingFiles(root)).resolves.toBeUndefined()
    await symlink(outside, join(root, 'a/b/away'), LINK)
    await expect(assertWorkingFiles(root)).rejects.toThrow('符号链接')
  })

  it('does not look inside the project history folder and does not descend into unsynced directories', async () => {
    const root = await folder(), outside = await folder()
    await write(root, { 'main.tex': 'm', '.git/config': 'c', 'build/deep/out.txt': 'x' })
    await symlink(outside, join(root, '.git/away'), LINK)
    await symlink(outside, join(root, 'build/deep/away'), LINK)
    await expect(assertWorkingFiles(root)).resolves.toBeUndefined()
  })

  it('stops at the entry budget across all folders', async () => {
    const root = await folder()
    await write(root, { 'a/1.tex': '1', 'a/2.tex': '2', 'b/3.tex': '3' })
    await expect(assertWorkingFiles(root, '', { remaining: 4 })).rejects.toThrow('项目文件过多')
    await expect(assertWorkingFiles(root, '', { remaining: 5 })).resolves.toBeUndefined()
  })

  it('refuses a name that is unsafe for the project before touching it', async () => {
    const root = await folder()
    await write(root, { 'main.tex': 'm', 'sub/.git/config': 'nested history' })
    await expect(assertWorkingFiles(root)).rejects.toThrow()
  })
})

describe('project history folder check', () => {
  it('reports a missing history folder and accepts one made of plain files and folders', async () => {
    const root = await folder()
    expect(await hasRepository(root)).toBe(false)
    await write(root, Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`.git/objects/${index.toString(16).padStart(2, '0')}/object`, 'x'])))
    await write(root, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': 'x' })
    expect(await hasRepository(root)).toBe(true)
  })

  it('refuses a link at any depth of the history folder', async () => {
    const root = await folder(), outside = await folder()
    await write(root, Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`.git/objects/aa/${index}`, 'x'])))
    await symlink(outside, join(root, '.git/objects/aa/away'), LINK)
    await expect(hasRepository(root)).rejects.toThrow('符号链接或特殊文件')
  })

  it('refuses a history folder that is itself a link', async () => {
    const root = await folder(), outside = await folder()
    await symlink(outside, join(root, '.git'), LINK)
    await expect(hasRepository(root)).rejects.toThrow('不安全')
  })
})

describe('checking many commits of one outgoing history', () => {
  it('reads an unchanged folder once per pass and still checks every changed one', async () => {
    // Arrange
    const root = await folder()
    await git.init({ fs, dir: root, defaultBranch: 'main' })
    const first = await commit(root, { 'main.tex': '1', 'figures/a.png': 'a', 'figures/deep/b.png': 'b', 'chapters/one.tex': 'one' })
    const second = await commit(root, { 'chapters/one.tex': 'one, revised' })
    const reads = vi.spyOn(git, 'readTree')
    const validated: ValidatedTrees = new Map(), cache = {}

    // Act
    const all = await validateTree(root, first, cache, validated)
    const firstReads = reads.mock.calls.length
    const changedOnly = await validateTree(root, second, cache, validated)

    // Assert
    expect(all.sort()).toEqual(['chapters/one.tex', 'figures/a.png', 'figures/deep/b.png', 'main.tex'])
    expect(firstReads).toBe(4) // root, chapters, figures, figures/deep
    expect(reads.mock.calls.length - firstReads).toBe(2) // new root and the changed chapters folder only
    expect(changedOnly.sort()).toEqual(['chapters/one.tex', 'main.tex'])
    // Each commit's root is charged for all 7 entries against the size limit, including the folder that was skipped.
    const roots = [...validated].filter(([key]) => key.startsWith('\0')).map(([, entries]) => entries)
    expect(roots).toEqual([7, 7])
    expect((await validateTree(root, second)).sort()).toEqual(all.sort()) // without the pass set the list is complete
  })

  it('checks the same folder contents again when they appear under a path that is not allowed', async () => {
    const root = await folder()
    await git.init({ fs, dir: root, defaultBranch: 'main' })
    const allowed = await commit(root, { 'main.tex': 'm', 'notes/x.tex': 'same bytes' })
    // The same tree object (one file x.tex with the same bytes) now also sits under a directory that must not be synced.
    const blob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('same bytes') })
    const shared = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', path: 'x.tex', oid: blob, type: 'blob' }] })
    const main = await git.writeBlob({ fs, dir: root, blob: Buffer.from('m') })
    const tree = await git.writeTree({ fs, dir: root, tree: [
      { mode: '100644', path: 'main.tex', oid: main, type: 'blob' }, { mode: '040000', path: 'node_modules', oid: shared, type: 'tree' },
      { mode: '040000', path: 'notes', oid: shared, type: 'tree' }] })
    const refused = await git.writeCommit({ fs, dir: root, commit: { tree, parent: [allowed], message: 'bad\n',
      author: { ...author, timestamp: 1, timezoneOffset: 0 }, committer: { ...author, timestamp: 1, timezoneOffset: 0 } } })
    const validated: ValidatedTrees = new Map(), cache = {}
    await validateTree(root, allowed, cache, validated)
    await expect(validateTree(root, refused, cache, validated)).rejects.toThrow('凭据或构建文件')
  })

  it('does not remember a folder whose check failed', async () => {
    const root = await folder()
    await git.init({ fs, dir: root, defaultBranch: 'main' })
    const blob = await git.writeBlob({ fs, dir: root, blob: Buffer.from('secret') })
    const bad = await git.writeTree({ fs, dir: root, tree: [{ mode: '100644', path: '.env', oid: blob, type: 'blob' }] })
    const tree = await git.writeTree({ fs, dir: root, tree: [{ mode: '040000', path: 'config', oid: bad, type: 'tree' }] })
    const stamp = { ...author, timestamp: 1, timezoneOffset: 0 }
    const oid = await git.writeCommit({ fs, dir: root, commit: { tree, parent: [], message: 'bad\n', author: stamp, committer: stamp } })
    const validated: ValidatedTrees = new Map(), cache = {}
    await expect(validateTree(root, oid, cache, validated)).rejects.toThrow('凭据或构建文件')
    await expect(validateTree(root, oid, cache, validated)).rejects.toThrow('凭据或构建文件')
    expect(validated.size).toBe(0)
  })
})
