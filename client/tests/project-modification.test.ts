import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '../src/shared/workspace-contracts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) }
})
import { LIMITS, SafeProject } from '../src/main/local/paths'
import { readProjectLastModified } from '../src/main/workspace/project-modification'
import { ProjectLibrary } from '../src/main/workspace/project-library'
const actual = await vi.importActual<typeof files>('node:fs/promises')
const roots: string[] = []
const SOURCE = '2024-01-02T03:04:05.000Z', UPDATED = '2025-02-03T04:05:06.000Z', GENERATED = '2030-06-07T08:09:10.000Z'
async function folder(): Promise<string> {
  const root = await actual.mkdtemp(join(await actual.realpath(tmpdir()), 'paperstudio-modification-'))
  roots.push(root); return root
}
async function content(root: string, path: string, stamp = SOURCE): Promise<string> {
  const file = join(root, path)
  await actual.mkdir(dirname(file), { recursive: true }); await actual.writeFile(file, `owned fixture ${path}`)
  await actual.utimes(file, new Date(stamp), new Date(stamp)); return file
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(files.lstat).mockImplementation(actual.lstat) })
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await actual.rm(root, { recursive: true, force: true }) })

describe('read-only display metadata for real project modification', () => {
  it('changes with source mtime while opened metadata and legacy four-field v1 storage stay unchanged', async () => {
    const root = await folder(), source = await content(root, 'main.tex'), data = await folder()
    const info: ProjectInfo = { id: 'fixture', name: 'Paper', root, files: [], defaultMain: 'main.tex' }
    const library = new ProjectLibrary(data)
    await library.remember({ ...info, lastModifiedAt: GENERATED } as ProjectInfo)
    const before = (await library.list())[0]!, registry = join(data, 'project-library.json')
    const registryBytes = await actual.readFile(registry)
    expect(await readProjectLastModified(root)).toBe((await actual.stat(source)).mtime.toISOString())
    await actual.writeFile(source, 'edited owned source'); await actual.utimes(source, new Date(UPDATED), new Date(UPDATED))
    expect(await readProjectLastModified(root)).toBe((await actual.stat(source)).mtime.toISOString())
    expect((await new ProjectLibrary(data).list())[0]).toEqual(before)
    expect(await actual.readFile(registry)).toEqual(registryBytes)
    const stored = JSON.parse(registryBytes.toString('utf8'))
    expect(stored.version).toBe(1); expect(Object.keys(stored.entries[0]).sort()).toEqual(['id', 'lastOpenedAt', 'name', 'root'])
  })
  it('uses source/asset mtimes but ignores Git, app history, generated files and output folders', async () => {
    const root = await folder(); await content(root, 'main.tex')
    const asset = await content(root, 'figures/chart.png', UPDATED)
    for (const path of ['.git/config', '.paperstudio/history.json', '.paperstudio-output/main.tex', 'out/main.tex',
      'build/main.tex', 'dist/main.tex', 'main.pdf', 'main.aux', 'main.bbl', 'main.blg', 'main.bcf', 'main.run.xml',
      'main.synctex.gz', 'main.log', 'scratch.tmp', 'draft.tex~', '.DS_Store']) await content(root, path, GENERATED)
    expect(await readProjectLastModified(root)).toBe((await actual.stat(asset)).mtime.toISOString())
  })
  it('includes PDF image assets without mistaking a paired TeX output PDF for an edit', async () => {
    const root = await folder(); await content(root, 'main.tex')
    const figure = await content(root, 'figures/chart.pdf', UPDATED)
    await content(root, 'main.pdf', GENERATED)
    expect(await readProjectLastModified(root)).toBe((await actual.stat(figure)).mtime.toISOString())
  })
  it('reads filesystem metadata only and does not change project bytes or file metadata', async () => {
    const root = await folder(), source = await content(root, 'main.tex'), before = await actual.stat(source)
    const bytes = await actual.readFile(source), readBytes = vi.spyOn(SafeProject.prototype, 'readBytes')
    vi.mocked(files.open).mockClear(); vi.mocked(files.readFile).mockClear()
    expect(await readProjectLastModified(root)).toBe(before.mtime.toISOString())
    expect(files.open).not.toHaveBeenCalled(); expect(files.readFile).not.toHaveBeenCalled(); expect(readBytes).not.toHaveBeenCalled()
    const after = await actual.stat(source)
    expect(after.mtimeMs).toBe(before.mtimeMs); expect(after.ctimeMs).toBe(before.ctimeMs); expect(after.mode).toBe(before.mode)
    expect(after.ino).toBe(before.ino); expect(await actual.readFile(source)).toEqual(bytes)
  })
  it('takes each time from the walk that verified the file instead of looking every file up again', async () => {
    // Arrange
    const root = await folder()
    for (let index = 0; index < 30; index++) await content(root, `chapters/part/section${index}.tex`, index === 17 ? UPDATED : SOURCE)
    vi.mocked(files.lstat).mockClear()

    // Act
    const latest = await readProjectLastModified(root)

    // Assert
    expect(latest).toBe(UPDATED)
    const inProject = vi.mocked(files.lstat).mock.calls.filter(([path]) => String(path).startsWith(join(root, 'chapters')))
    expect(inProject.length).toBe(32) // the two folders and the thirty files, once each
  })
  it('shows unknown for a missing root, an empty project or projects containing only build output', async () => {
    const parent = await folder(); expect(await readProjectLastModified(join(parent, 'missing'))).toBeNull()
    const root = await folder(); expect(await readProjectLastModified(root)).toBeNull()
    await content(root, 'main.pdf', GENERATED); await content(root, '.paperstudio/history.json', GENERATED)
    expect(await readProjectLastModified(root)).toBeNull()
  })
  it('shows unknown for inaccessible metadata instead of failing the project list or inventing now', async () => {
    const root = await folder(); await content(root, 'main.tex')
    vi.mocked(files.lstat).mockRejectedValueOnce(Object.assign(new Error('owned denial fixture'), { code: 'EACCES' }))
    expect(await readProjectLastModified(root)).toBeNull()
    expect(await readProjectLastModified(root)).toBe(SOURCE)
  })
  it('does not follow a linked root or linked ancestor and leaves the link and target unchanged', async () => {
    const parent = await folder(), outside = join(parent, 'outside'), linked = join(parent, 'linked')
    await actual.mkdir(outside); const source = await content(outside, 'nested/main.tex', GENERATED)
    await actual.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const bytes = await actual.readFile(source), info = await actual.lstat(linked)
    expect(await readProjectLastModified(linked)).toBeNull()
    expect(await readProjectLastModified(join(linked, 'nested'))).toBeNull()
    expect((await actual.lstat(linked)).isSymbolicLink()).toBe(true)
    expect((await actual.lstat(linked)).ino).toBe(info.ino); expect(await actual.readFile(source)).toEqual(bytes)
  })
  it('skips a linked descendant rather than allowing outside content to set the timestamp', async () => {
    const parent = await folder(), root = join(parent, 'paper'), outside = join(parent, 'outside')
    await actual.mkdir(root); await actual.mkdir(outside); await content(root, 'main.tex')
    const target = await content(outside, 'secret.tex', GENERATED)
    await actual.symlink(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    const bytes = await actual.readFile(target)
    expect(await readProjectLastModified(root)).toBe(SOURCE); expect(await actual.readFile(target)).toEqual(bytes)
    expect((await actual.lstat(join(root, 'external'))).isSymbolicLink()).toBe(true)
  })
  it('keeps unsafe paths and an incomplete bounded scan unknown', async () => {
    expect(await readProjectLastModified('../relative')).toBeNull()
    const root = await folder(); await content(root, 'main.tex')
    const scan = vi.spyOn(SafeProject.prototype, 'list').mockRejectedValueOnce(new Error('项目超过 10000 个目录项限制'))
    expect(await readProjectLastModified(root)).toBeNull(); expect(scan).toHaveBeenCalledTimes(1)
    expect(LIMITS.entries).toBe(10000); expect(LIMITS.depth).toBe(32)
  })
})
