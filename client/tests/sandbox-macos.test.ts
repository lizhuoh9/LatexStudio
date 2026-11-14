import type { Stats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMacSandboxProfile, MAC_SANDBOX_STATUS, macSandboxEnvironment,
  macTexReadRoots, prepareMacSandbox } from '../src/main/sandbox/macos'

vi.mock('node:fs/promises', () => ({ lstat: vi.fn(), realpath: vi.fn(), open: vi.fn() }))
const ROOT = '/usr/local/texlive/2026'
const ENGINE = `${ROOT}/bin/universal-darwin/pdftex`
const WORK = '/Users/test/Library/Caches/PaperStudio/paperstudio-abc123/source'
const RUNNER = '/usr/bin/sandbox-exec'
const ID = 'abcdef01-2345-4678-9abc-def012345678'
const CONTAINER = `/Users/test/Library/Application Support/PaperStudio/tex/runtimes/paperstudio-tex-${ID}`
const INSTALL = `${CONTAINER}/install`
const PDF = `${INSTALL}/bin/universal-darwin/pdftex`
const CONVERTER = `${INSTALL}/bin/universal-darwin/xdvipdfmx`
const MANIFEST = `${CONTAINER}/paperstudio-runtime.json`
const PDF_PATH = 'install/bin/universal-darwin/pdflatex'
const XE_PATH = 'install/bin/universal-darwin/xelatex'
const CONVERTER_PATH = 'install/bin/universal-darwin/xdvipdfmx'
const files = new Map<string, Buffer>()
function runtimeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, id: ID, ready: true, platform: 'darwin', distribution: 'texlive', version: '2026.11',
    assetSha256: 'a'.repeat(64), chineseResources: false, engines: { pdflatex: PDF_PATH, xelatex: XE_PATH },
    tools: { xdvipdfmx: CONVERTER_PATH },
    binaryHashes: { [PDF_PATH]: 'b'.repeat(64), [XE_PATH]: 'c'.repeat(64), [CONVERTER_PATH]: 'd'.repeat(64) }, ...overrides }
}
function setManifest(overrides: Record<string, unknown> = {}): void {
  files.set(MANIFEST, Buffer.from(JSON.stringify(runtimeManifest(overrides))))
}
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
const links = new Set<string>()
const missing = new Set<string>()
const redirects = new Map<string, string>()
let magic = 'cffaedfe'
let privateParent = true
let runnerOwner = 0
let runtimeOwner = 1000
const closed = vi.fn()
function metadata(path: string): Stats {
  const file = /\/(?:pdftex|pdflatex|xetex|xelatex|xdvipdfmx|sandbox-exec)$/.test(path) || files.has(path)
  const mode = links.has(path) ? 0o120777 : file ? 0o100755 : 0o040700
  return { mode: !privateParent && path.endsWith('paperstudio-abc123') ? 0o040755 : mode,
    uid: path === RUNNER ? runnerOwner : path.startsWith(CONTAINER) ? runtimeOwner : 1000,
    size: files.get(path)?.length ?? (file ? 4 : 0), dev: 1, ino: 1,
    isFile: () => file && !links.has(path), isDirectory: () => !file && !links.has(path),
    isSymbolicLink: () => links.has(path) } as Stats
}
function platform(value: string): void { Object.defineProperty(process, 'platform', { value, configurable: true }) }
beforeEach(() => {
  vi.clearAllMocks(); links.clear(); missing.clear(); redirects.clear(); files.clear()
  magic = 'cffaedfe'; privateParent = true; runnerOwner = 0; runtimeOwner = 1000
  setManifest()
  redirects.set(`${INSTALL}/bin/universal-darwin/pdflatex`, PDF)
  redirects.set(`${INSTALL}/bin/universal-darwin/xelatex`, `${INSTALL}/bin/universal-darwin/xetex`)
  platform('darwin')
  Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true })
  vi.mocked(lstat).mockImplementation(async (path) => {
    const name = String(path)
    if (missing.has(name)) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' })
    return metadata(name)
  })
  vi.mocked(realpath).mockImplementation(async (path) => redirects.get(String(path)) ?? String(path))
  vi.mocked(open).mockImplementation(async (path) => ({
    stat: async () => metadata(String(path)), close: async () => { closed() },
    read: async (buffer: Buffer) => {
      const content = files.get(String(path)) ?? Buffer.from(magic, 'hex')
      return { bytesRead: content.copy(buffer), buffer }
    }
  }) as unknown as FileHandle)
})
afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid)
  else Reflect.deleteProperty(process, 'getuid')
  vi.unstubAllEnvs()
})

describe('pure macOS policy fixtures (not real Mac evidence)', () => {
  it('uses default deny, no network/fork, one initial executable and snapshot-only writes', () => {
    const profile = buildMacSandboxProfile(ENGINE, WORK, [ROOT])
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny process-fork)')
    expect(profile.match(/\(allow process-exec/g)).toHaveLength(1)
    expect(profile).toContain(`(allow process-exec (literal "${ENGINE}"))`)
    expect(profile).toContain(`(allow file-write* (subpath "${WORK}"))`)
    expect(profile).not.toContain('(allow network')
    expect(profile).not.toContain('(allow mach-lookup')
    expect(profile).not.toContain('(allow file-read-metadata (subpath "/"))')
    expect(profile).not.toContain('(allow file-write* (subpath "/Users")')
    expect(MAC_SANDBOX_STATUS).toContain('deprecated')
  })
  it.each(['relative', '/', '//server/share', 'C:/project', '/tmp/a/../b', '/tmp/a//b',
    `${WORK}/`, `${WORK}\n`, `${WORK}\0`, `${WORK}\uD800`, '/a'.repeat(600)])('rejects malformed or unsafe work paths: %j', (path) => {
    expect(() => buildMacSandboxProfile(ENGINE, path, [ROOT])).toThrow()
  })
  it.each([[], ['/usr'], ['/Users/test'], ['/Users/test/Library'], ['/Library'],
    ['/usr/local/texlive'], [`${ROOT}/texmf-dist`], [ROOT, '/usr/lib']].map((roots) => ({ roots })))('never accepts broader caller read roots: $roots', ({ roots }) => {
    expect(() => buildMacSandboxProfile(ENGINE, WORK, roots)).toThrow()
  })
  it('rejects an arbitrary project executable or a script engine', () => {
    expect(() => buildMacSandboxProfile(`${WORK}/pdflatex`, WORK, [ROOT])).toThrow()
    expect(() => buildMacSandboxProfile(`${ROOT}/bin/universal-darwin/latexmk`, WORK, [ROOT])).toThrow()
    expect(() => buildMacSandboxProfile(`${ROOT}/bin/universal-darwin/luatex`, WORK, [ROOT])).toThrow()
  })
  it('requires a disposable job child, separate from the install root', () => {
    expect(() => buildMacSandboxProfile(ENGINE, '/Users/test/real-project', [ROOT])).toThrow('独立快照')
    expect(() => buildMacSandboxProfile(ENGINE, `${ROOT}/paperstudio-abc123/source`, [ROOT])).toThrow('独立')
  })
  it('quotes hostile Scheme characters as data rather than accepting profile injection', () => {
    const account = 'test\\name") (allow default) ("'
    const root = `/Users/${account}/Library/Application Support/PaperStudio/tex/${'a'.repeat(64)}/TinyTeX`
    const engine = `${root}/bin/universal-darwin/pdftex`
    const work = `/Users/${account}/cache/paperstudio-abc123/source`
    const profile = buildMacSandboxProfile(engine, work, [root])
    const outsideStrings = profile.replace(/"(?:\\.|[^"\\])*"/g, '""')
    expect(outsideStrings).not.toContain('(allow default)')
    expect(profile).toContain('\\"')
    expect(profile).toContain('\\\\')
  })
  it('allows only digest-named app-specific TinyTeX layouts, not arbitrary user Library', () => {
    const root = `/Users/test/Library/Application Support/PaperStudio/tex/${'b'.repeat(64)}/TinyTeX`
    expect(buildMacSandboxProfile(`${root}/bin/arm64-darwin/pdftex`, WORK, [root])).toContain(root)
    const unpinned = root.replace('b'.repeat(64), 'latest')
    expect(() => buildMacSandboxProfile(`${unpinned}/bin/arm64-darwin/pdftex`, WORK, [unpinned])).toThrow()
  })
  it('rebuilds all environment values without secrets, hooks or user font/TeX trees', () => {
    vi.stubEnv('GITHUB_TOKEN', 'never inherited')
    vi.stubEnv('DYLD_INSERT_LIBRARIES', '/tmp/evil.dylib')
    vi.stubEnv('TEXINPUTS', '/Users/test/secrets')
    vi.stubEnv('FONTCONFIG_FILE', '/Users/test/fonts.conf')
    const env = macSandboxEnvironment(WORK, ENGINE)
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
    expect(env.FONTCONFIG_FILE).toBeUndefined()
    expect(env.HOME).toBe(WORK)
    expect(env.TEXINPUTS).toBe('.:')
    expect(env.TEXMFHOME).toBe(WORK)
    expect(env.openin_any).toBe('p')
    expect(env.openout_any).toBe('p')
    expect(env.shell_escape).toBe('f')
    expect(env.MKTEXFMT).toBe('0')
    expect(env.PATH).not.toContain('/Users/test/secrets')
  })
})

describe('app-owned UUIDv4 runtime contract (fixtures, not provenance evidence)', () => {
  it('checks parent manifest identity but grants only install and snapshot data, not the manifest container', async () => {
    expect(await macTexReadRoots(PDF)).toEqual([INSTALL])
    const prepared = await prepareMacSandbox(PDF, WORK, [INSTALL])
    expect(prepared.argsPrefix.at(-1)).toBe(PDF)
    expect(prepared.argsPrefix[1]).toContain(`(subpath "${INSTALL}")`)
    expect(prepared.argsPrefix[1]).not.toContain(`(subpath "${CONTAINER}")`)
  })
  it('gives the app-owned converter its own single-executable policy without enabling fork/network/shell', async () => {
    const prepared = await prepareMacSandbox(CONVERTER, WORK, [INSTALL])
    const profile = prepared.argsPrefix[1] ?? ''
    expect(prepared.argsPrefix.at(-1)).toBe(CONVERTER)
    expect(profile).toContain(`(allow process-exec (literal "${CONVERTER}"))`)
    expect(profile.match(/\(allow process-exec/g)).toHaveLength(1)
    expect(profile).toContain('(deny process-fork)')
    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain(`(allow process-exec (literal "${PDF}"))`)
    expect(prepared.env.shell_escape).toBe('f')
  })
  it.each([true, false])('accepts boolean resource metadata without treating it as sandbox/PDF proof: %s', async (value) => {
    setManifest({ chineseResources: value })
    expect(await macTexReadRoots(PDF)).toEqual([INSTALL])
  })
  it('does not allow a system or legacy digest-layout converter', () => {
    expect(() => buildMacSandboxProfile(`${ROOT}/bin/universal-darwin/xdvipdfmx`, WORK, [ROOT])).toThrow('converter')
    const legacy = `/Users/test/Library/Application Support/PaperStudio/tex/${'a'.repeat(64)}/TinyTeX`
    expect(() => buildMacSandboxProfile(`${legacy}/bin/universal-darwin/xdvipdfmx`, WORK, [legacy])).toThrow('converter')
  })
  it.each([
    { schema: 2 }, { id: ID.replace('abcdef01', '11111111') }, { ready: false }, { platform: 'win32' },
    { distribution: 'miktex' }, { version: '2027.1' }, { assetSha256: 'bad' }, { chineseResources: 'ready' },
    { env: { TOKEN: 'must not be logged' } },
    { engines: null }, { tools: { xdvipdfmx: '/usr/bin/xdvipdfmx' } },
    { tools: { xdvipdfmx: 'install/bin/universal-darwin/../xdvipdfmx' } },
    { tools: { xdvipdfmx: 'install/bin/universal-darwin/latexmk' } },
    { tools: { xdvipdfmx: CONVERTER_PATH, shell: 'install/bin/universal-darwin/sh' } },
    { binaryHashes: {} }, { binaryHashes: { [PDF_PATH]: 'not-a-sha256' } },
    { engines: { pdflatex: 'install/bin/universal-darwin/%2e%2e/pdftex', xelatex: XE_PATH } }
  ])('fails closed on malformed/nonready manifest: %j', async (change) => {
    setManifest(change)
    await expect(macTexReadRoots(PDF)).rejects.toThrow(/runtime manifest/)
  })
  it('rejects missing, linked, malformed UTF-8/JSON, and oversized manifests without executing anything', async () => {
    missing.add(MANIFEST)
    await expect(macTexReadRoots(PDF)).rejects.toThrow('manifest')
    missing.clear(); links.add(MANIFEST)
    await expect(macTexReadRoots(PDF)).rejects.toThrow('符号链接')
    links.clear()
    for (const content of [Buffer.from([0xff]), Buffer.from('{'), Buffer.alloc(64 * 1024 + 1)]) {
      files.set(MANIFEST, content)
      await expect(macTexReadRoots(PDF)).rejects.toThrow('manifest')
    }
  })
  it('requires canonical UUIDv4 and refuses arbitrary roots even with a self-authored ready manifest', async () => {
    const v1 = INSTALL.replace('-4678-', '-1678-')
    expect(() => buildMacSandboxProfile(`${v1}/bin/universal-darwin/pdftex`, WORK, [v1])).toThrow('布局')
    await expect(macTexReadRoots('/Users/test/project/install/bin/universal-darwin/pdftex')).rejects.toThrow('布局')
    expect(open).not.toHaveBeenCalled()
  })
  it('requires app-owned runtime and refuses manifest aliases that resolve away from the selected native executable', async () => {
    runtimeOwner = 2000
    await expect(macTexReadRoots(PDF)).rejects.toThrow('当前用户')
    runtimeOwner = 1000
    redirects.set(`${CONTAINER}/${PDF_PATH}`, '/Users/test/project/pdftex')
    await expect(macTexReadRoots(PDF)).rejects.toThrow('不属于该 runtime manifest')
  })
})

describe('mocked native adapter validation (no Mac process is run)', () => {
  it('prepares an exact system wrapper argument array and never a shell command', async () => {
    const result = await prepareMacSandbox(ENGINE, WORK, [ROOT])
    expect(result.command).toBe(RUNNER)
    expect(result.argsPrefix).toEqual(['-p', buildMacSandboxProfile(ENGINE, WORK, [ROOT]), ENGINE])
    expect(result.env.HOME).toBe(WORK)
    expect(closed).toHaveBeenCalledTimes(2)
  })
  it('resolves the known MacTeX alias, returns only its dedicated root and never invents format flags', async () => {
    const alias = '/Library/TeX/texbin/pdflatex'
    redirects.set(alias, ENGINE)
    expect(await macTexReadRoots(alias)).toEqual([ROOT])
    expect((await prepareMacSandbox(alias, WORK, [ROOT])).argsPrefix.at(-1)).toBe(ENGINE)
  })
  it('rejects Windows/Linux even if mock paths resemble a Mac', async () => {
    platform('win32')
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('真实 macOS')
    await expect(macTexReadRoots(ENGINE)).rejects.toThrow('真实 macOS')
    expect(open).not.toHaveBeenCalled()
  })
  it('fails closed if sandbox-exec is missing; never returns the direct engine', async () => {
    missing.add(RUNNER)
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('不会降级')
  })
  it('rejects linked work directories and linked install ancestors', async () => {
    links.add(WORK)
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('符号链接')
    links.clear(); links.add(ROOT)
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('符号链接')
  })
  it('rejects arbitrary project aliases even when they point to a real engine', async () => {
    const alias = '/Users/test/project/pdflatex'
    redirects.set(alias, ENGINE)
    await expect(macTexReadRoots(alias)).rejects.toThrow('任意路径')
  })
  it('requires a private current-user job parent', async () => {
    privateParent = false
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('仅当前用户')
  })
  it('rejects scripts/non-Mach-O data and closes the file handle', async () => {
    magic = '23212f62'
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('Mach-O')
    expect(closed).toHaveBeenCalledTimes(1)
  })
  it('requires the system wrapper to be root-owned', async () => {
    runnerOwner = 1000
    await expect(prepareMacSandbox(ENGINE, WORK, [ROOT])).rejects.toThrow('权限不可信')
  })
})
