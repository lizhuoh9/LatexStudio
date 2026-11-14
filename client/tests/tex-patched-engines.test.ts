import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installationDigest } from '../src/main/tex/catalog'
import { hashFile } from '../src/main/tex/manifest'
import { findPatchedEngineSource, installPatchedEngines, PATCHED_ENGINE_DIR, PATCHED_WINDOWS_ENGINES, USABLE_WINDOWS_ENGINES,
  verifyPatchedEngines, type PatchedEngine } from '../src/main/tex/patched-engines'

const roots: string[] = []
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const pins: PatchedEngine[] = [{ name: 'pdflatex.exe', source: 'pdftex.exe', sha256: sha('MZ-pdftex') },
  { name: 'xdvipdfmx.exe', source: 'xdvipdfmx.exe', sha256: sha('MZ-xdvipdfmx') }]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-patched-'))
  roots.push(root)
  const source = join(root, 'engines'), install = join(root, 'install')
  await mkdir(source); await mkdir(join(install, 'bin'), { recursive: true })
  await writeFile(join(source, 'pdftex.exe'), 'MZ-pdftex'); await writeFile(join(source, 'xdvipdfmx.exe'), 'MZ-xdvipdfmx')
  await writeFile(join(install, 'texmf.cnf'), 'base tree')
  return { root, source, install, overlay: join(install, ...PATCHED_ENGINE_DIR.split('/')) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('patched engine overlay', () => {
  it('ships real 64-hex pins for the accepted Windows overlay', () => {
    expect(PATCHED_WINDOWS_ENGINES.map(engine => engine.name)).toEqual(['pdflatex.exe', 'xelatex.exe', 'xdvipdfmx.exe', 'bibtex.exe', 'fonts.conf'])
    for (const engine of PATCHED_WINDOWS_ENGINES) expect(engine.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(PATCHED_WINDOWS_ENGINES)).toBe(true)
  })

  it('installs pinned bytes under fixed names and leaves the base-tree digest unchanged when excluded', async () => {
    const { source, install } = await fixture()
    const before = await installationDigest(install)
    await installPatchedEngines(install, source, undefined, pins)
    await verifyPatchedEngines(install, undefined, pins)
    expect(await installationDigest(install, undefined, PATCHED_ENGINE_DIR)).toBe(before)
    expect(await installationDigest(install)).not.toBe(before)
  })

  it('refuses mismatching source bytes without creating the overlay', async () => {
    const { source, install, overlay } = await fixture()
    await writeFile(join(source, 'xdvipdfmx.exe'), 'MZ-tampered')
    await expect(installPatchedEngines(install, source, undefined, pins)).rejects.toThrow('校验值不符')
    await expect(verifyPatchedEngines(install, undefined, pins)).rejects.toThrow()
    await expect(mkdir(overlay)).resolves.toBeUndefined()
  })

  it('refuses an existing overlay instead of overwriting it', async () => {
    const { source, install, overlay } = await fixture()
    await mkdir(overlay)
    await expect(installPatchedEngines(install, source, undefined, pins)).rejects.toThrow()
  })

  it('rejects extra, missing and changed overlay entries', async () => {
    const { source, install, overlay } = await fixture()
    await installPatchedEngines(install, source, undefined, pins)
    await writeFile(join(overlay, 'extra.dll'), 'x')
    await expect(verifyPatchedEngines(install, undefined, pins)).rejects.toThrow('内容不符')
    await rm(join(overlay, 'extra.dll'))
    await writeFile(join(overlay, 'pdflatex.exe'), 'MZ-changed')
    await expect(verifyPatchedEngines(install, undefined, pins)).rejects.toThrow('校验失败')
    await rm(join(overlay, 'pdflatex.exe'))
    await expect(verifyPatchedEngines(install, undefined, pins)).rejects.toThrow('内容不符')
  })

  it('rejects a linked overlay directory', async context => {
    const { root, install, overlay } = await fixture()
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    try { await symlink(elsewhere, overlay, 'junction') } catch { context.skip('Junction creation unavailable') }
    await expect(verifyPatchedEngines(install, undefined, pins)).rejects.toThrow()
  })

  it('ships resource binaries whose bytes match the pins', async () => {
    const shipped = resolve('resources/win32/tex-engines')
    for (const engine of PATCHED_WINDOWS_ENGINES) expect(await hashFile(join(shipped, engine.source))).toBe(engine.sha256)
    expect(await findPatchedEngineSource([shipped])).toBe(shipped)
    expect(USABLE_WINDOWS_ENGINES).toEqual(['pdflatex', 'xelatex'])
  })

  it('excludes exactly the overlay path: case variants, nested copies and other files stay in the digest', async () => {
    const { install } = await fixture()
    const before = await installationDigest(install, undefined, PATCHED_ENGINE_DIR)
    for (const path of ['BIN/PaperStudio-x64', 'texmf/bin/paperstudio-x64']) {
      await mkdir(join(install, ...path.split('/')), { recursive: true })
      await writeFile(join(install, ...path.split('/'), 'hidden.exe'), 'MZ-hidden')
      expect(await installationDigest(install, undefined, PATCHED_ENGINE_DIR)).not.toBe(before)
      await rm(join(install, path.split('/')[0]!), { recursive: true, force: true })
    }
    await writeFile(join(install, 'texmf.cnf'), 'changed base tree')
    expect(await installationDigest(install, undefined, PATCHED_ENGINE_DIR)).not.toBe(before)
  })

  it('skips a stale candidate and takes the first whose bytes match every pin', async () => {
    const { root, source } = await fixture()
    const stale = join(root, 'stale')
    await mkdir(stale)
    await writeFile(join(stale, 'pdftex.exe'), 'MZ-old'); await writeFile(join(stale, 'xdvipdfmx.exe'), 'MZ-xdvipdfmx')
    expect(await findPatchedEngineSource([stale, source], undefined, pins)).toBe(source)
    await expect(findPatchedEngineSource([stale], undefined, pins)).rejects.toThrow('校验不符')
  })

  it('refuses placeholder or malformed pins before touching files', async () => {
    const { source, install } = await fixture()
    const bad = [{ name: 'pdflatex.exe', source: 'pdftex.exe', sha256: 'PENDING' }]
    await expect(installPatchedEngines(install, source, undefined, bad)).rejects.toThrow('未附可信')
    await expect(verifyPatchedEngines(install, undefined, [{ ...pins[0]!, name: '../escape.exe' }])).rejects.toThrow('未附可信')
  })

  it('keeps the XPDF crash fix limited to safe pointer initialization and applies both reviewed patches', async () => {
    const directory = resolve('resources/win32/tex-patches')
    const patch = await readFile(join(directory, 'xpdf-state-paths-init.patch'), 'utf8')
    const addedCode = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'))
      .map(line => line.slice(1).trim()).filter(line => line && !line.startsWith('//'))
    expect(addedCode).toEqual(['pagesFile = NULL;', 'tabStateFile = NULL;', 'sessionFile = NULL;'])
    expect(patch).toContain('void GlobalParams::initStateFilePaths()')
    const build = await readFile(join(directory, 'build-engines.sh'), 'utf8')
    const first = build.indexOf('apply --whitespace=nowarn "$PATCH"')
    const second = build.indexOf('apply --whitespace=nowarn "$STATE_PATCH"')
    expect(first).toBeGreaterThan(-1); expect(second).toBeGreaterThan(first)
    expect(build).toContain('sha256sum $PROGRAMS "$PATCH" "$STATE_PATCH"')
    expect(build).toContain('strip --strip-all $PROGRAMS')
    expect(build).toContain('embed-manifest.sh')
  })

  it('finds only a listed candidate directory and never falls back to PATH', async () => {
    const { root, source } = await fixture()
    expect(await findPatchedEngineSource([join(root, 'missing'), source], undefined, pins)).toBe(source)
    await expect(findPatchedEngineSource([join(root, 'missing')], undefined, pins)).rejects.toThrow('未随软件打包')
  })
})
