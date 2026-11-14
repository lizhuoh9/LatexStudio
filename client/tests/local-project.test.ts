import { mkdtemp, mkdir, readFile, readdir, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService } from '../src/main/local/project'
import { decodeText, encodeText, LIMITS, projectPath, SafeProject } from '../src/main/local/paths'
import { copyProject } from '../src/main/local/build'

const folders: string[] = []
const services: ProjectService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function fixture(): Promise<{ root: string; project: ProjectService }> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-project-test-'))
  folders.push(root)
  const project = new ProjectService(root)
  services.push(project)
  return { root, project }
}

describe('local project path and encoding boundaries', () => {
  it.each(['', '/etc/passwd', '../file.tex', 'a/../b.tex', './main.tex', 'a//b', 'C:/file.tex',
    'C:file.tex', 'C:\\file.tex', '\\\\server\\share', '//server/share', 'a\\b', 'x:stream',
    'nul.tex', 'dir/COM1.txt', 'trailing.', 'trailing ', 'a\0.tex', 'a\n.tex', '%2e%2e/file',
    '.git/config', 'node_modules/x', 'out/x', 'foo.aux', 'texmf.cnf', 'pdflatex.fmt',
    'CONIN$', 'CONOUT$.tex', 'CLOCK$', 'COM¹.txt', 'LPT².txt', '\ud800.tex'])('rejects %j', (path) => {
    expect(() => projectPath(path)).toThrow()
  })
  it('accepts portable Unicode relative filenames, rejects excessive depth', () => {
    expect(projectPath('章节/正文 😀.tex')).toBe('章节/正文 😀.tex')
    expect(() => projectPath(Array(34).fill('a').join('/'))).toThrow()
  })
  it('rejects malformed UTF-8, NUL, unpaired surrogates and large text', () => {
    expect(() => decodeText(Buffer.from([0xc3, 0x28]))).toThrow('UTF-8')
    expect(() => decodeText(Buffer.from([65, 0, 66]))).toThrow('UTF-8')
    expect(() => encodeText('\ud800')).toThrow('编码')
    expect(() => encodeText('x'.repeat(LIMITS.text + 1))).toThrow('4 MiB')
    expect(() => decodeText(Buffer.alloc(LIMITS.text + 1, 65))).toThrow('4 MiB')
  })
})

describe('explicit GUI directory listings', () => {
  it('returns empty and populated subdirectories with size zero and retains full relative paths', async () => {
    const { root, project } = await fixture()
    await mkdir(join(root, 'notes/empty'), { recursive: true })
    await mkdir(join(root, 'chapters'))
    await writeFile(join(root, 'chapters/method.tex'), 'method')
    const info = await project.initialize()
    expect(info.files).toEqual([
      { path: 'chapters', kind: 'directory', size: 0 },
      { path: 'chapters/method.tex', kind: 'text', size: 6 },
      { path: 'notes', kind: 'directory', size: 0 },
      { path: 'notes/empty', kind: 'directory', size: 0 }
    ])
    expect(await project.list()).toEqual(info.files)
  })
  it('keeps SafeProject default snapshots file-only, including after a previous explicit directory request', async () => {
    const { root } = await fixture(), safe = new SafeProject(root)
    await mkdir(join(root, 'empty')); await mkdir(join(root, 'chapters'))
    await writeFile(join(root, 'chapters/main.tex'), 'paper')
    await safe.initialize()
    expect((await safe.list(true)).filter(file => file.kind === 'directory').map(file => file.path)).toEqual(['chapters', 'empty'])
    expect(await safe.list()).toEqual([{ path: 'chapters/main.tex', kind: 'text', size: 5 }])
    expect(await safe.list(false)).toEqual(await safe.list())
    expect(await safe.list('true' as unknown as boolean)).toEqual(await safe.list())
  })
  it('never selects a directory ending in .tex as the main document', async () => {
    const { root, project } = await fixture()
    await mkdir(join(root, 'main.tex'))
    expect((await project.initialize()).defaultMain).toBeNull()
    await writeFile(join(root, 'chapter.tex'), 'actual document')
    expect((await project.initialize()).defaultMain).toBe('chapter.tex')
  })
  it('does not expose ignored private/build directories even when they are empty', async () => {
    const { root, project } = await fixture()
    for (const path of ['.git', '.paperstudio', '.paperstudio-write-lock', 'node_modules', 'out', 'generated.aux']) await mkdir(join(root, path))
    await mkdir(join(root, 'visible'))
    expect((await project.initialize()).files).toEqual([{ path: 'visible', kind: 'directory', size: 0 }])
  })
  it('does not include or traverse a linked directory in explicit directory mode', async () => {
    const { root } = await fixture(), outside = await fixture(), safe = new SafeProject(root)
    await writeFile(join(outside.root, 'private.tex'), 'outside')
    await symlink(outside.root, join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir')
    await safe.initialize()
    expect(await safe.list(true)).toEqual([])
    expect(await readFile(join(outside.root, 'private.tex'), 'utf8')).toBe('outside')
  })
  it('keeps the real compilation snapshot copy file-only and does not copy empty GUI directories', async () => {
    const { root } = await fixture(), output = await fixture(), safe = new SafeProject(root)
    await mkdir(join(root, 'chapters/empty'), { recursive: true })
    await writeFile(join(root, 'chapters/main.tex'), 'paper content')
    await safe.initialize(); await safe.list(true)
    const destination = join(output.root, 'snapshot')
    await copyProject(safe, destination, new AbortController().signal)
    expect(await readFile(join(destination, 'chapters/main.tex'), 'utf8')).toBe('paper content')
    expect(await readdir(join(destination, 'chapters'))).toEqual(['main.tex'])
  })
  it('reports addition and removal of an empty directory through the existing watcher', async () => {
    const { root, project } = await fixture()
    await project.initialize()
    let stage = 'add', added!: () => void, removed!: () => void
    const addition = new Promise<void>(done => { added = done })
    const removal = new Promise<void>(done => { removed = done })
    const stop = project.watch(paths => { if (paths.includes('empty')) (stage === 'add' ? added : removed)() }, 20)
    await mkdir(join(root, 'empty')); await addition
    stage = 'remove'
    await rmdir(join(root, 'empty')); await removal
    stop()
    expect(await project.list()).toEqual([])
  })
})

describe('local project files and compare-and-swap', () => {
  it('initializes with stable identity and main file; ignores dependencies/build products', async () => {
    const { root, project } = await fixture()
    for (const name of ['.git', 'node_modules', 'out', 'build']) {
      await mkdir(join(root, name)); await writeFile(join(root, name, 'hidden.tex'), 'hidden')
    }
    await writeFile(join(root, 'main.tex'), '正文')
    await writeFile(join(root, 'figure.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(join(root, 'main.aux'), 'generated')
    const info = await project.initialize()
    expect(info).toMatchObject({ root, defaultMain: 'main.tex' })
    expect(info.id).toHaveLength(64)
    expect(info.files.map((file) => file.path)).toEqual(['figure.png', 'main.tex'])
    expect(info.files[0]?.kind).toBe('binary')
    expect((await project.initialize()).id).toBe(info.id)
  })
  it('hashes actual bytes and saves atomically with SHA256 revisions', async () => {
    const { root, project } = await fixture()
    const initial = await project.create('main.tex', 'old\n')
    expect(initial.revision).toBe(createHash('sha256').update('old\n').digest('hex'))
    const saved = await project.save('main.tex', 'new\n', initial.revision)
    expect(saved).toEqual(await project.read('main.tex'))
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('new\n')
    expect((await project.list()).map((file) => file.path)).toEqual(['main.tex'])
  })
  it('never overwrites external edits or creates over an existing file', async () => {
    const { root, project } = await fixture()
    const initial = await project.create('main.tex', 'old')
    await writeFile(join(root, 'main.tex'), 'external AI edit')
    await expect(project.save('main.tex', 'mine', initial.revision)).rejects.toThrow('外部程序修改')
    await expect(project.create('main.tex', 'mine')).rejects.toThrow('已存在')
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('external AI edit')
    await expect(project.save('main.tex', 'mine', 'wrong revision')).rejects.toThrow('版本')
  })
  it('serializes competing saves; a second stale writer conflicts', async () => {
    const { project } = await fixture()
    const initial = await project.create('main.tex', 'old')
    const results = await Promise.allSettled([project.save('main.tex', 'first', initial.revision),
      project.save('main.tex', 'second', initial.revision)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((await project.read('main.tex')).content).toBe('first')
  })
  it('does not resurrect an externally deleted file or silently decode invalid data', async () => {
    const { root, project } = await fixture()
    const initial = await project.create('main.tex', 'old')
    await unlink(join(root, 'main.tex'))
    await expect(project.save('main.tex', 'new', initial.revision)).rejects.toThrow()
    await writeFile(join(root, 'bad.tex'), Buffer.from([0xff, 0xfe, 0x61]))
    await expect(project.read('bad.tex')).rejects.toThrow('UTF-8')
  })
  it('rejects directory junction escapes for reads, writes and creates; does not traverse them', async () => {
    const { root, project } = await fixture()
    const outside = await fixture()
    await writeFile(join(outside.root, 'secret.tex'), 'not project data')
    await symlink(outside.root, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(project.read('escape/secret.tex')).rejects.toThrow('符号链接')
    await expect(project.create('escape/new.tex', 'unsafe')).rejects.toThrow('符号链接')
    expect(await project.list()).toEqual([])
    await expect(project.read('../secret.tex')).rejects.toThrow()
    expect(await readFile(join(outside.root, 'secret.tex'), 'utf8')).toBe('not project data')
  })
  it('rejects a linked root and detects replacement of an initialized root', async () => {
    const { root, project } = await fixture()
    await project.initialize()
    const moved = `${root}-moved`
    folders.push(moved)
    await rename(root, moved)
    await symlink(moved, root, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(project.list()).rejects.toThrow('替换')
    const linked = new ProjectService(root)
    services.push(linked)
    await expect(linked.initialize()).rejects.toThrow('符号链接')
  })
  it('detects an ordinary replacement directory even if its pathname is unchanged', async () => {
    const { root, project } = await fixture()
    await project.initialize()
    const moved = `${root}-moved`
    folders.push(moved)
    await rename(root, moved)
    await mkdir(root)
    await expect(project.list()).rejects.toThrow('替换')
  })
  it('reports external changes and stops after unsubscribe/disposal', async () => {
    const { root, project } = await fixture()
    await project.initialize()
    const events: string[][] = []
    const changed = new Promise<void>((resolve) => {
      project.watch((paths) => { events.push(paths); resolve() })
    })
    await writeFile(join(root, 'external.tex'), 'AI wrote this')
    await changed
    expect(events.flat()).toContain('external.tex')
    project.dispose()
    await expect(project.list()).rejects.toThrow('已关闭')
    expect(() => project.watch(() => undefined)).toThrow('已关闭')
  })
})
