import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) }
})
import { ProjectLibrary, projectIdForRoot } from '../src/main/workspace/project-library'
import { ProjectService } from '../src/main/local/project'
import type { ProjectInfo } from '../src/shared/workspace-contracts'

const folders: string[] = []
async function folder(): Promise<string> {
  const root = await files.mkdtemp(join(tmpdir(), 'paperstudio-project-library-'))
  folders.push(root); return root
}
async function paper(name = 'paper'): Promise<ProjectInfo> {
  const root = join(await folder(), name)
  await files.mkdir(root); await files.writeFile(join(root, 'main.tex'), `Content of ${name}`)
  return new ProjectService(root).initialize()
}
const registry = (root: string): string => join(root, 'project-library.json')
beforeEach(() => { vi.clearAllMocks(); vi.mocked(files.rename).mockReset(); vi.mocked(files.open).mockReset() })
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(files.rename).mockReset(); vi.mocked(files.open).mockReset()
  for (const path of folders.splice(0)) await files.rm(path, { recursive: true, force: true })
})

it('lists an empty library without creating metadata and persists projects across a fresh store', async () => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), info = await paper()
  expect(await library.list()).toEqual([]); expect(await files.readdir(dataRoot)).toEqual([])
  const id = await library.remember(info), fresh = new ProjectLibrary(dataRoot)
  expect(id).toMatch(/^[a-f0-9]{32}$/); expect(id).not.toContain(info.root)
  expect(await fresh.list()).toEqual([{ id, name: info.name, root: info.root, lastOpenedAt: expect.any(String) }])
  expect(await fresh.resolve(id)).toMatchObject({ id, root: info.root })
  expect((await files.stat(registry(dataRoot))).nlink).toBe(1)
  if (process.platform !== 'win32') expect((await files.stat(registry(dataRoot))).mode & 0o077).toBe(0)
  expect(await files.readdir(dataRoot)).toEqual(['project-library.json'])
})

it('uses stable case-insensitive Windows IDs without allowing relative or device roots', () => {
  if (process.platform === 'win32') {
    expect(projectIdForRoot('C:\\Papers\\Study')).toBe(projectIdForRoot('c:/papers/study/'))
    expect(projectIdForRoot('C:\\Papers\\Study')).not.toBe(projectIdForRoot('C:\\Papers\\Other'))
  }
  expect(() => projectIdForRoot('../paper')).toThrow()
  expect(() => projectIdForRoot('\\\\?\\C:\\Papers')).toThrow()
})

it('updates and sorts recency without duplicating a remembered project or sharing caller objects', async () => {
  const library = new ProjectLibrary(await folder()), first = await paper('first'), second = await paper('second')
  const now = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
  const firstId = await library.remember(first)
  now.mockReturnValue(1700000001000); const secondId = await library.remember(second)
  expect((await library.list()).map(value => value.id)).toEqual([secondId, firstId])
  now.mockReturnValue(1700000002000); await library.remember({ ...first, name: 'Renamed display' })
  const listed = await library.list(); listed[0]!.name = 'Caller mutation'
  expect(await library.list()).toMatchObject([{ id: firstId, name: 'Renamed display' }, { id: secondId }])
})

it('captures Main ProjectInfo once and stores only four whitelist fields, not derived GitHub data or secrets', async () => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), info = await paper(), other = await paper('other')
  const decorated = { ...info, github: { owner: 'team', name: 'private' }, syncIssue: true, token: 'PRIVATE-FIXTURE', id: 'forged' }
  const pending = library.remember(decorated); decorated.root = other.root; decorated.name = 'changed later'
  const id = await pending, body = await files.readFile(registry(dataRoot), 'utf8'), saved = JSON.parse(body)
  expect(id).toBe(projectIdForRoot(info.root)); expect(saved.entries[0].root).toBe(info.root)
  expect(Object.keys(saved.entries[0]).sort()).toEqual(['id', 'lastOpenedAt', 'name', 'root'])
  expect(body).not.toMatch(/PRIVATE-FIXTURE|github|syncIssue|forged/)
})

it('resolves only enrolled IDs, never a renderer-supplied path or a guessed unknown ID', async () => {
  const library = new ProjectLibrary(await folder()), info = await paper()
  await library.remember(info)
  await expect(library.resolve(info.root)).rejects.toThrow()
  await expect(library.resolve('0'.repeat(32))).rejects.toThrow('不在已保存列表')
  await expect(library.forget('..')).rejects.toThrow()
  expect(await library.list()).toHaveLength(1)
})

it('keeps unavailable projects listed, rejects opening them, and forgets metadata without recreating a removed folder', async () => {
  const library = new ProjectLibrary(await folder()), info = await paper(), id = await library.remember(info)
  await files.rm(info.root, { recursive: true })
  expect(await library.list()).toHaveLength(1)
  await expect(library.resolve(id)).rejects.toThrow('目录已不可用')
  await library.forget(id); expect(await library.list()).toEqual([])
  await expect(files.lstat(info.root)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('forget removes only local library metadata, never project content, Git data or linked cloud metadata', async () => {
  const library = new ProjectLibrary(await folder()), info = await paper()
  await files.mkdir(join(info.root, '.git'))
  await files.writeFile(join(info.root, '.git', 'paperstudio-app.json'), 'fixture cloud binding stays private to this project')
  await files.writeFile(join(info.root, '.git', 'config'), 'fixture origin')
  const before = await files.readFile(join(info.root, 'main.tex'), 'utf8'), id = await library.remember(info)
  await library.forget(id)
  expect(await library.list()).toEqual([])
  expect(await files.readFile(join(info.root, 'main.tex'), 'utf8')).toBe(before)
  expect(await files.readFile(join(info.root, '.git', 'config'), 'utf8')).toBe('fixture origin')
  expect(await files.readFile(join(info.root, '.git', 'paperstudio-app.json'), 'utf8')).toContain('stays private')
})

it.each(['json', 'invalid-utf8', 'unknown-field', 'invalid-entry', 'derived-field', 'duplicate-id', 'invalid-date', 'relative-root', 'oversized'])('refuses %s metadata and does not overwrite it on remember/forget', async kind => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), info = await paper(), id = await library.remember(info)
  const valid = JSON.parse(await files.readFile(registry(dataRoot), 'utf8'))
  let bytes: Buffer
  if (kind === 'json') bytes = Buffer.from('{broken')
  else if (kind === 'invalid-utf8') bytes = Buffer.from([0xff, 0xfe, 0xff])
  else if (kind === 'oversized') bytes = Buffer.alloc(1024 * 1024 + 1, 'x')
  else {
    if (kind === 'unknown-field') valid.token = 'PRIVATE-FIXTURE'
    if (kind === 'invalid-entry') valid.entries[0].id = '0'.repeat(32)
    if (kind === 'derived-field') valid.entries[0].github = { owner: 'team', name: 'repo' }
    if (kind === 'duplicate-id') valid.entries.push({ ...valid.entries[0] })
    if (kind === 'invalid-date') valid.entries[0].lastOpenedAt = 'not-an-ISO-date'
    if (kind === 'relative-root') valid.entries[0].root = '../relative'
    bytes = Buffer.from(JSON.stringify(valid))
  }
  await files.writeFile(registry(dataRoot), bytes)
  await expect(library.list()).rejects.toThrow('安全读取')
  await expect(library.remember(info)).rejects.toThrow('安全读取')
  await expect(library.forget(id)).rejects.toThrow('安全读取')
  expect(await files.readFile(registry(dataRoot))).toEqual(bytes)
})

it('rejects hardlinked metadata without changing either name', async () => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), info = await paper()
  await library.remember(info)
  const other = join(await folder(), 'copy.json'); await files.link(registry(dataRoot), other)
  const before = await files.readFile(other)
  await expect(library.list()).rejects.toThrow(); await expect(library.remember(info)).rejects.toThrow()
  expect(await files.readFile(other)).toEqual(before)
})

it('rejects a linked data root and linked project folder before writing their targets', async () => {
  const target = await folder(), linked = join(await folder(), 'shortcut'), info = await paper()
  await files.symlink(target, linked, 'junction')
  await expect(new ProjectLibrary(linked).remember(info)).rejects.toThrow()
  expect(await files.readdir(target)).toEqual([])
  const profile = await folder(), paperLink = join(await folder(), 'paper-shortcut')
  await files.symlink(info.root, paperLink, 'junction')
  await expect(new ProjectLibrary(profile).remember({ ...info, root: paperLink })).rejects.toThrow('经过链接')
  expect(await files.readdir(profile)).toEqual([])
})

it('refuses a data root replaced after initialization instead of treating its missing registry as an empty library', async () => {
  const parent = await folder(), root = join(parent, 'profile'), library = new ProjectLibrary(root), info = await paper()
  await library.remember(info)
  const before = await files.readFile(registry(root)), moved = join(parent, 'old-profile')
  await files.rename(root, moved); await files.mkdir(root)
  await expect(library.list()).rejects.toThrow()
  await expect(library.remember(info)).rejects.toThrow()
  expect(await files.readFile(registry(moved))).toEqual(before)
  expect(await files.readdir(root)).toEqual([])
})

it('preserves the previous JSON and project when atomic publication fails, with no temporary file left behind', async () => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), first = await paper(), second = await paper('second')
  await library.remember(first)
  const before = await files.readFile(registry(dataRoot))
  vi.mocked(files.rename).mockRejectedValueOnce(Object.assign(new Error('PRIVATE provider path'), { code: 'EPERM' }))
  const failure = await library.remember(second).catch((error: unknown) => error)
  expect(String(failure)).not.toContain('PRIVATE'); expect(String(failure)).toContain('安全读取或保存')
  expect(await files.readFile(registry(dataRoot))).toEqual(before)
  expect(await files.readdir(dataRoot)).toEqual(['project-library.json'])
  expect(await files.readFile(join(second.root, 'main.tex'), 'utf8')).toBe('Content of second')
})

it('detects an external valid metadata edit before publication and keeps that edit instead of replacing it', async () => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), first = await paper(), second = await paper('second')
  await library.remember(first)
  const changed = JSON.parse(await files.readFile(registry(dataRoot), 'utf8'))
  changed.entries[0].name = 'External metadata edit'
  const external = Buffer.from(JSON.stringify(changed))
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(files.open).mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).includes('.paperstudio-library-')) await files.writeFile(registry(dataRoot), external)
    return handle
  })
  await expect(library.remember(second)).rejects.toThrow('已被其他程序更改')
  expect(await files.readFile(registry(dataRoot))).toEqual(external)
  expect(await library.list()).toMatchObject([{ name: 'External metadata edit', root: first.root }])
  expect(await files.readdir(dataRoot)).toEqual(['project-library.json'])
})

it('does not publish new metadata after a failed durable-file close acknowledgement', async () => {
  const dataRoot = await folder(), library = new ProjectLibrary(dataRoot), first = await paper(), second = await paper('second')
  await library.remember(first)
  const before = await files.readFile(registry(dataRoot))
  const { open } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(files.open).mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).includes('.paperstudio-library-')) {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); throw new Error('close failure') })
    }
    return handle
  })
  await expect(library.remember(second)).rejects.toThrow()
  expect(await files.readFile(registry(dataRoot))).toEqual(before)
  expect(await files.readdir(dataRoot)).toEqual(['project-library.json'])
})

it('serializes independent store instances through the existing cooperative profile lock without losing projects', async () => {
  const dataRoot = await folder(), first = new ProjectLibrary(dataRoot), second = new ProjectLibrary(dataRoot)
  const a = await paper('first'), b = await paper('second')
  const ids = await Promise.all([first.remember(a), second.remember(b)])
  expect((await new ProjectLibrary(dataRoot).list()).map(value => value.id).sort()).toEqual(ids.sort())
  expect(await files.readdir(dataRoot)).toEqual(['project-library.json'])
})

it('keeps at most 50 entries with an explicit non-destructive limit; an existing project can still be refreshed', async () => {
  const library = new ProjectLibrary(await folder()), papers: ProjectInfo[] = []
  for (let i = 0; i < 50; i++) { const info = await paper(`paper-${i}`); papers.push(info); await library.remember(info) }
  const extra = await paper('paper-51')
  await expect(library.remember(extra)).rejects.toThrow('50 个')
  expect(await library.list()).toHaveLength(50)
  await library.remember(papers[0]!)
  expect(await library.list()).toHaveLength(50)
  expect(await files.readFile(join(extra.root, 'main.tex'), 'utf8')).toBe('Content of paper-51')
}, 15_000)
