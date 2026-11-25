import { describe, expect, it, vi } from 'vitest'
import { DARWIN_INSTALL_TREE_SHA256, DARWIN_TOOLS, darwinRuntimeCandidates, MAC_HELPER_SHA256, macCompileAccepted, MacTrustedRuntime,
  type DarwinRuntimeDependencies } from '../src/main/tex/darwin-runtime'
import { texBackend } from '../src/main/tex/platform-backend'
import { texSetupBackend } from '../src/main/tex/controller'
import { detectTexEnvironment } from '../src/main/tex/compiler'

// Injected file system and self-test: proves the gate logic, not that any Mac accepts the resources.
const TREE = 'a'.repeat(64), HELPER = 'b'.repeat(64)
function runtime(extra: DarwinRuntimeDependencies = {}) {
  const deps = {
    pins: { tree: TREE, helper: HELPER },
    candidates: () => ['/definitely/not/here'],
    digest: vi.fn(async () => TREE),
    hash: vi.fn(async (path: string) => path.includes('helper') ? HELPER : `hash:${path.replaceAll('\\', '/').split('/').pop()}`),
    executable: vi.fn(async () => undefined),
    packages: vi.fn(async (_root: string) => '/app/Resources/tex-packages/texmf-paperstudio'),
    helper: vi.fn(async (_root: string) => '/app/Resources/darwin/helper'),
    selfTest: vi.fn(async () => ({ xelatex: true })),
    createSession: vi.fn(async () => ({ remoteRoot: '/r' }) as never),
    ...extra
  }
  return { deps, instance: new MacTrustedRuntime(deps) }
}

describe('macOS release pins', () => {
  it('are both set in this build, so macOS gets the Mac backend; without them it gets none', () => {
    expect(DARWIN_INSTALL_TREE_SHA256).toMatch(/^[a-f0-9]{64}$/); expect(MAC_HELPER_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(macCompileAccepted()).toBe(true)
    expect(texBackend('darwin')?.platform).toBe('darwin')
    expect(texSetupBackend('darwin').supported).toBe(true)
    // The same build with the pins absent: nothing on macOS is offered.
    expect(macCompileAccepted({ tree: null, helper: null })).toBe(false)
    expect(texBackend('darwin', false)).toBeNull()
    expect(texSetupBackend('darwin', false).supported).toBe(false)
  })
  it('need both a tree digest and a helper digest of the right shape', () => {
    expect(macCompileAccepted({ tree: TREE, helper: HELPER })).toBe(true)
    for (const pins of [{ tree: TREE, helper: null }, { tree: null, helper: HELPER }, { tree: 'abc', helper: HELPER }, { tree: TREE, helper: TREE.toUpperCase() }])
      expect(macCompileAccepted(pins)).toBe(false)
  })
  it('select the Mac backend only when accepted, and never change Windows or other platforms', () => {
    expect(texBackend('win32')?.platform).toBe('win32')
    expect(texBackend('win32', true)?.platform).toBe('win32')
    expect(texBackend('darwin', true)?.platform).toBe('darwin')
    expect(texBackend('linux', true)).toBeNull()
    expect(texSetupBackend('darwin', true)).toMatchObject({ supported: true })
    expect(texSetupBackend('win32', true).failure).toBeUndefined()
    expect(texSetupBackend('linux', true).supported).toBe(false)
  })
  it('keep environment detection unavailable on macOS without them, even with an injected runtime', async () => {
    const get = vi.fn(async () => ({ root: '/r', manifest: {} }) as never)
    expect(await detectTexEnvironment(undefined, '/data', { platform: 'darwin', macAccepted: false, runtimes: { get } })).toMatchObject({ available: false })
    expect(get).not.toHaveBeenCalled()
    expect(await detectTexEnvironment(undefined, '/data', { platform: 'darwin', macAccepted: true, runtimes: { get } }))
      .toMatchObject({ available: true, engines: ['pdflatex', 'xelatex'] })
  })
})

describe('bundled Mac TeX resources', () => {
  it('do no lookup at all while the pins are unset', async () => {
    const t = runtime({ pins: { tree: null, helper: null } })
    expect(await t.instance.get('/data')).toBeNull()
    expect(t.deps.digest).not.toHaveBeenCalled(); expect(t.deps.selfTest).not.toHaveBeenCalled()
    await expect(t.instance.createSession({ executable: '/x', runtimeRoot: '/x', workDirs: ['/w'] })).rejects.toThrow('尚未通过本机自检')
  })

  it('report a missing bundle as a refusal with a reason, without starting the self-test', async () => {
    const t = runtime()
    expect(await t.instance.get('/data')).toBeNull()
    expect(t.instance.failure).toBe('此版本没有随附 Mac 编译组件')
    expect(t.deps.selfTest).not.toHaveBeenCalled()
  })
})

describe('where the Mac TeX tree is looked for', () => {
  it('only inside the compile helper bundle, the one place its sandbox can read', () => {
    const candidates = darwinRuntimeCandidates().map(path => path.replaceAll('\\', '/'))
    expect(candidates.length).toBeGreaterThan(0)
    for (const path of candidates) expect(path).toMatch(/\/darwin\/LatexStudioCompiler\.app\/Contents\/Resources\/tex-darwin$/)
  })
  it('takes the helper and the package tree from the same bundle as the tree (real paths, real package check)', async () => {
    const { cp, mkdir, rm, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const base = join(process.cwd(), 'tests', '__mac-bundle-fixture__')
    const contents = join(base, 'LatexStudioCompiler.app', 'Contents'), root = join(contents, 'Resources', 'tex-darwin')
    try {
      await mkdir(join(root, 'install'), { recursive: true }); await mkdir(join(contents, 'MacOS'), { recursive: true })
      await writeFile(join(contents, 'MacOS', 'latexstudio-compiler'), 'not a real helper')
      await cp(join(process.cwd(), 'resources', 'tex-packages'), join(contents, 'Resources', 'tex-packages'), { recursive: true })
      // No injected helper or package lookup: the product's own path arithmetic and manifest check run.
      const deps: DarwinRuntimeDependencies = { ...runtime().deps, candidates: () => [root],
        hash: vi.fn(async (path: string) => path.endsWith('latexstudio-compiler') ? HELPER : 'tool') }
      delete deps.helper; delete deps.packages
      const instance = new MacTrustedRuntime(deps)
      const found = await instance.get('/data')
      expect(instance.failure).toBeNull()
      await instance.createSession({ executable: '/x', runtimeRoot: found!.root, workDirs: ['/w'] })
      expect(vi.mocked(deps.createSession!).mock.calls.at(-1)![1]).toEqual({ helper: join(contents, 'MacOS', 'latexstudio-compiler'),
        overlayRoot: join(contents, 'Resources', 'tex-packages', 'texmf-paperstudio') })
      // The same tree with its neighbours missing is refused: nothing is taken from anywhere else.
      await rm(join(contents, 'MacOS'), { recursive: true, force: true })
      const alone = new MacTrustedRuntime(deps)
      expect(await alone.get('/data')).toBeNull(); expect(alone.failure).toContain('编译助手未随软件打包')
    } finally { await rm(base, { recursive: true, force: true }) }
  })
})

describe('bundled Mac TeX resources that exist', () => {
  // The repository's own client folder stands in for "a directory that exists with an install child".
  const here = (): string[] => [`${process.cwd()}/tests/__mac-runtime-fixture__`]
  async function prepared(extra: DarwinRuntimeDependencies = {}) {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(`${here()[0]}/install`, { recursive: true })
    return runtime({ candidates: here, ...extra })
  }
  async function cleanup(): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(here()[0]!, { recursive: true, force: true })
  }

  it('are accepted only after digest, tools, packages, helper and the self-test all pass', async () => {
    try {
      const t = await prepared()
      const found = await t.instance.get('/data')
      expect(found?.manifest).toMatchObject({ platform: 'darwin', engines: { pdflatex: DARWIN_TOOLS.pdflatex, xelatex: DARWIN_TOOLS.xelatex },
        tools: { xdvipdfmx: DARWIN_TOOLS.xdvipdfmx } })
      expect(found?.engines).toEqual(['pdflatex', 'xelatex'])
      expect(t.deps.executable).toHaveBeenCalledTimes(4)
      expect(t.deps.selfTest).toHaveBeenCalledTimes(1)
      expect(t.instance.failure).toBeNull()
      // A second lookup re-hashes tools, formats and helper but does not repeat the tree digest or the self-test.
      expect(await t.instance.get('/data')).toBe(found)
      expect(t.deps.digest).toHaveBeenCalledTimes(1); expect(t.deps.selfTest).toHaveBeenCalledTimes(1)
      await t.instance.createSession({ executable: '/x', runtimeRoot: found!.root, workDirs: ['/w'] })
      expect(vi.mocked(t.deps.createSession).mock.calls.at(-1)![1]).toEqual({ helper: '/app/Resources/darwin/helper', overlayRoot: '/app/Resources/tex-packages/texmf-paperstudio' })
      await expect(t.instance.createSession({ executable: '/x', runtimeRoot: '/elsewhere', workDirs: ['/w'] })).rejects.toThrow('尚未通过本机自检')
    } finally { await cleanup() }
  })

  it.each([
    ['a changed tree', { digest: vi.fn(async () => 'c'.repeat(64)) }, 'Mac 编译组件与软件内置的校验值不符'],
    ['a changed helper', { hash: vi.fn(async () => 'c'.repeat(64)) }, 'Mac 编译助手与软件内置的校验值不符'],
    ['a non-native tool', { executable: vi.fn(async () => { throw new Error('TeX 引擎不是原生程序') }) }, 'TeX 引擎不是原生程序'],
    ['a failed self-test', { selfTest: vi.fn(async () => { throw new Error('macOS 原生隔离不可用，已拒绝编译：沙箱内仍能联网') }) }, '沙箱内仍能联网']
  ] as const)('refuse %s and keep the reason', async (_name, extra, reason) => {
    try {
      const t = await prepared(extra as DarwinRuntimeDependencies)
      expect(await t.instance.get('/data')).toBeNull()
      expect(t.instance.failure).toContain(reason)
      await expect(t.instance.createSession({ executable: '/x', runtimeRoot: here()[0]!, workDirs: ['/w'] })).rejects.toThrow()
    } finally { await cleanup() }
  })

  it('do not repeat a refused check on every lookup; an explicit verify reports the reason', async () => {
    try {
      const selfTest = vi.fn(async () => { throw new Error('macOS 原生隔离不可用，已拒绝编译：沙箱内仍能联网') })
      const t = await prepared({ selfTest })
      expect(await t.instance.get('/data')).toBeNull(); expect(await t.instance.get('/data')).toBeNull()
      expect(selfTest).toHaveBeenCalledTimes(1)
      await expect(t.instance.verify('/data')).rejects.toThrow('沙箱内仍能联网')
      expect(selfTest).toHaveBeenCalledTimes(1) // the refusal is only moments old
    } finally { await cleanup() }
  })

  it('re-run a refused check when the user retries later, and by themselves once the refusal has expired', async () => {
    try {
      let clock = 1_000_000, fail = true
      const selfTest = vi.fn(async () => { if (fail) throw new Error('macOS 原生隔离不可用，已拒绝编译：沙箱内仍能联网'); return { xelatex: false } })
      const t = await prepared({ selfTest, now: () => clock })
      expect(await t.instance.get('/data')).toBeNull()
      clock += 6_000
      await expect(t.instance.verify('/data')).rejects.toThrow('沙箱内仍能联网') // explicit retry: checked again
      expect(selfTest).toHaveBeenCalledTimes(2)
      clock += 30_000
      expect(await t.instance.get('/data')).toBeNull(); expect(selfTest).toHaveBeenCalledTimes(2) // still within the refusal window
      clock += 61_000; fail = false
      const found = await t.instance.get('/data')
      expect(selfTest).toHaveBeenCalledTimes(3)
      expect(found?.engines).toEqual(['pdflatex']) // XeLaTeX did not pass on this machine: not offered
    } finally { await cleanup() }
  })

  it('let a waiting caller stop waiting when its own signal aborts', async () => {
    try {
      let release: () => void = () => undefined
      const selfTest = vi.fn(() => new Promise<{ xelatex: boolean }>(done => { release = () => done({ xelatex: true }) }))
      const t = await prepared({ selfTest }), abort = new AbortController()
      const waiting = t.instance.get('/data', abort.signal).catch((reason: unknown) => reason)
      await vi.waitFor(() => expect(selfTest).toHaveBeenCalled())
      abort.abort('canceled')
      expect(await waiting).toBe('canceled')
      release()
      await vi.waitFor(async () => expect(await t.instance.get('/data')).not.toBeNull())
    } finally { await cleanup() }
  })

  it('refuse when the package tree no longer verifies on a later lookup', async () => {
    try {
      let broken = false
      const packages = vi.fn(async () => { if (broken) throw new Error('TeX 宏包文件校验失败；请重新准备'); return '/app/Resources/tex-packages/texmf-paperstudio' })
      const t = await prepared({ packages })
      expect(await t.instance.get('/data')).not.toBeNull()
      broken = true
      expect(await t.instance.get('/data')).toBeNull()
      expect(t.instance.failure).toContain('宏包')
    } finally { await cleanup() }
  })

  it('drop the accepted entry when a tool or the helper changes afterwards', async () => {
    try {
      let changed = false
      const hash = vi.fn(async (path: string) => path.includes('helper') ? HELPER : changed && path.endsWith('pdftex') ? 'changed' : 'same')
      const t = await prepared({ hash })
      expect(await t.instance.get('/data')).not.toBeNull()
      changed = true
      await t.instance.get('/data')
      expect(t.deps.digest).toHaveBeenCalledTimes(2) // full check again
      expect(t.deps.selfTest).toHaveBeenCalledTimes(2)
    } finally { await cleanup() }
  })
})
