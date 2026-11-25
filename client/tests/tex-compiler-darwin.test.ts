import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectTexEnvironment, LocalCompiler, type CompilerDependencies } from '../src/main/tex/compiler'
import { ConfirmedCancellation, SessionNotStarted, type SandboxRunOptions, type SandboxSession, type SandboxSessionOptions } from '../src/main/sandbox/session'
import { DARWIN_TOOLS } from '../src/main/tex/darwin-runtime'
import { runMacSelfTest } from '../src/main/sandbox/macos-selftest'
import type { MacSandboxSession } from '../src/main/sandbox/macos-session'

// Synthetic session that keeps its outputs "remotely" until pulled, like the Mac helper's container. It proves the
// compiler's control flow for such a backend, not native isolation and not that any Mac compiles anything.
const PDF = Buffer.from(`%PDF-1.5\n${'x'.repeat(2048)}\n%%EOF\n`)
const REMOTE = '/Users/u/Library/Containers/org.paperstudio.desktop.compiler.v1/Data/tmp/paperstudio-ab12cd/source'
const prepared = { root: '/Applications/LatexStudio.app/Contents/Resources/tex-darwin',
  manifest: { platform: 'darwin', engines: { pdflatex: DARWIN_TOOLS.pdflatex, xelatex: DARWIN_TOOLS.xelatex }, tools: { xdvipdfmx: DARWIN_TOOLS.xdvipdfmx } } }
const roots: string[] = []
type Step = (args: string[], options: SandboxRunOptions, remote: Map<string, Buffer>, signal: AbortSignal) => Promise<{ code: number }>

async function fixture(step: Step) {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-darwin-'))
  roots.push(root)
  const source = join(root, 'project'), builds = join(root, 'builds')
  await mkdir(source)
  await writeFile(join(source, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n')
  const sessions: Array<{ options: SandboxSessionOptions; run: ReturnType<typeof vi.fn>; pull: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }> = []
  const createSession = vi.fn(async (options: SandboxSessionOptions): Promise<SandboxSession> => {
    const remote = new Map<string, Buffer>()
    const session = { remoteRoot: REMOTE, runsBibtex: true,
      run: vi.fn((args: string[], _cwd: string, runOptions: SandboxRunOptions = {}) => step(args, runOptions, remote, options.signal!)),
      pull: vi.fn(async (names: readonly string[]) => {
        for (const name of names) { const data = remote.get(name); if (data) await writeFile(join(options.workDirs[0]!, '.paperstudio-output', name), data) }
      }),
      cancel: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) }
    sessions.push({ options, ...session })
    return session
  })
  const deps: CompilerDependencies = { platform: 'darwin', macAccepted: true, runtimes: { get: vi.fn(async () => prepared) } as never,
    createSession, latch: { latched: false } }
  return { builds, sessions, deps, compiler: new LocalCompiler(source, builds, '/data', undefined, deps) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('compiler with a backend that owns its work directory (macOS shape)', () => {
  it('stays disabled on macOS while the release pins are unset', async () => {
    const t = await fixture(async () => ({ code: 0 }))
    const result = await new LocalCompiler(join(t.builds, '..', 'project'), t.builds, '/data', undefined, { ...t.deps, macAccepted: false })
      .run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(false); expect(result.log).toContain('此平台的隔离编译尚未验收，未启用。')
    expect(t.sessions).toHaveLength(0)
  })

  it('pulls the PDF and SyncTeX back, and maps SyncTeX paths from the remote root', async () => {
    const synctex = gzipSync(Buffer.from(`SyncTeX Version:1\nInput:1:${REMOTE}/./main.tex\nContent:\n{1\n[1,1:0,0:0,0,0\n]\n}1\n`))
    const t = await fixture(async (_args, _options, remote) => {
      remote.set('paperstudio.pdf', PDF); remote.set('paperstudio.synctex.gz', synctex); return { code: 0 }
    })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(true); expect(result.pdf).toEqual(Uint8Array.from(PDF))
    expect(result.synctex?.files).toEqual(['main.tex'])
    const session = t.sessions[0]!
    expect(session.options.executable).toBe(join(prepared.root, ...DARWIN_TOOLS.pdflatex.split('/')))
    expect(session.pull.mock.calls.map(call => call[0])).toEqual([['paperstudio.aux', 'paperstudio.bcf'], ['paperstudio.pdf', 'paperstudio.synctex.gz']])
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(await readdir(t.builds)).toEqual([])
  })

  it('runs BibTeX in the same session and never opens a second one', async () => {
    const t = await fixture(async (args, options, remote) => {
      if (options.tool === 'bibtex') return { code: 0 }
      remote.set('paperstudio.aux', Buffer.from('\\citation{knuth}\n\\bibdata{refs}\n')); remote.set('paperstudio.pdf', PDF)
      return { code: args.length ? 0 : 1 }
    })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(true); expect(t.sessions).toHaveLength(1)
    const calls = t.sessions[0]!.run.mock.calls
    expect(calls).toHaveLength(4)
    expect(calls[1]![0]).toEqual(['-terse', 'paperstudio']); expect(calls[1]![2]).toMatchObject({ tool: 'bibtex' })
    expect(result.log).toContain('第 3/3 遍'); expect(result.log).toContain('BibTeX：处理参考文献')
  })

  it('converts XeLaTeX output with the bound converter in the same session', async () => {
    const t = await fixture(async (_args, options, remote) => { if (options.tool === 'xdvipdfmx') remote.set('paperstudio.pdf', PDF); return { code: 0 } })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'xelatex' })
    expect(result.ok).toBe(true)
    expect(t.sessions[0]!.options.tools).toEqual({ xdvipdfmx: join(prepared.root, ...DARWIN_TOOLS.xdvipdfmx.split('/')) })
    expect(t.sessions[0]!.run.mock.calls.at(-1)![2]).toMatchObject({ tool: 'xdvipdfmx' })
  })

  it('keeps the compiler usable after a confirmed cancellation and latches after any other session failure', async () => {
    const clean = await fixture(() => Promise.reject(new ConfirmedCancellation('macOS 原生隔离不可用，已拒绝编译：编译已取消')))
    await clean.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(clean.deps.latch).toEqual({ latched: false })
    const dirty = await fixture(async () => ({ code: 0 }))
    dirty.deps.createSession = vi.fn(async () => { throw new Error('macOS 原生隔离不可用，已拒绝编译：编译助手没有在应用沙箱中运行') })
    const result = await new LocalCompiler(join(dirty.builds, '..', 'project'), dirty.builds, '/data', undefined, dirty.deps).run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(false); expect(dirty.deps.latch).toEqual({ latched: true })
    expect(result.log).toContain('没有在应用沙箱中运行')
  })

  it('does not latch when the backend refused before starting anything', async () => {
    const t = await fixture(async () => ({ code: 0 }))
    t.deps.createSession = vi.fn(async () => { throw new SessionNotStarted('macOS 原生隔离不可用，已拒绝编译：编译组件尚未通过本机自检') })
    const result = await new LocalCompiler(join(t.builds, '..', 'project'), t.builds, '/data', undefined, t.deps).run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(false); expect(result.log).toContain('尚未通过本机自检')
    expect(t.deps.latch).toEqual({ latched: false })
  })

  it('offers and runs only the engines the runtime accepted on this machine', async () => {
    const t = await fixture(async () => ({ code: 0 }))
    const runtimes = { get: vi.fn(async () => ({ ...prepared, engines: ['pdflatex'] })) } as never
    expect(await detectTexEnvironment(undefined, '/data', { platform: 'darwin', macAccepted: true, runtimes })).toMatchObject({ engines: ['pdflatex'] })
    const result = await new LocalCompiler(join(t.builds, '..', 'project'), t.builds, '/data', undefined, { ...t.deps, runtimes })
      .run({ mainFile: 'main.tex', engine: 'xelatex' })
    expect(result.ok).toBe(false); expect(result.log).toContain('没有通过这台电脑的隔离自检')
    expect(t.sessions).toHaveLength(0); expect(t.deps.latch).toEqual({ latched: false })
  })
})

describe('Mac isolation self-test (scripted session)', () => {
  type Verdicts = Partial<Record<'read-in' | 'exec-in' | 'read-out' | 'exec-out' | 'write' | 'connect', boolean>>
  function session(verdicts: Verdicts = {}, code = 0, pdf: Buffer | null = PDF, errno = 1, xelatexCode = 0) {
    const probes: string[] = []
    const fake = { remoteRoot: REMOTE, runsBibtex: true as const, cancel: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined),
      run: vi.fn(async (args: string[]) => ({ code: args.includes('-progname=xelatex') ? xelatexCode : code })),
      pull: vi.fn(async () => { if (pdf) await writeFile(join(fake.source, '.paperstudio-output', 'paperstudio.pdf'), pdf) }),
      probe: vi.fn(async (kind: string, argument: string) => {
        const inside = argument.startsWith(REMOTE)
        const key = kind === 'read' ? (inside ? 'read-in' : 'read-out') : kind === 'exec-read' ? (inside ? 'exec-in' : 'exec-out') : kind
        probes.push(key)
        return { allowed: verdicts[key as keyof Verdicts] ?? inside, errno }
      }), source: '' }
    const createSession = vi.fn(async (options: SandboxSessionOptions) => { fake.source = options.workDirs[0]!; return fake as unknown as MacSandboxSession })
    const listen = async () => ({ port: 40000, connections: () => 1, close: async () => undefined, reachable: async () => true })
    return { fake, probes, deps: { createSession, listen } }
  }
  async function data(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'paperstudio-selftest-')); roots.push(root); return root }

  it('passes only when the sandbox compiled a PDF, allowed the controls and refused every probe', async () => {
    const t = session(), root = await data()
    await expect(runMacSelfTest('/app/tex-darwin', root, t.deps)).resolves.toEqual({ xelatex: true })
    expect(t.probes).toEqual(['read-in', 'exec-in', 'write', 'read-out', 'exec-out', 'write', 'connect'])
    expect(t.fake.dispose).toHaveBeenCalledTimes(2) // the required session, then the XeLaTeX session
    expect(t.deps.createSession.mock.calls[1]![0].tools?.xdvipdfmx).toMatch(/xdvipdfmx$/)
    expect(await readdir(join(root, 'tex', 'selftest'))).toEqual([]) // scratch folder and sentinel removed
  })

  it.each([
    [{ 'read-out': true }, '沙箱内仍能读取用户数据目录'], [{ 'exec-out': true }, '沙箱内启动的程序仍能读取用户数据目录'],
    [{ write: true }, '沙箱内仍能向工作目录之外写入'], [{ connect: true }, '沙箱内仍能联网'],
    [{ 'read-in': false }, '对照读取失败'], [{ 'exec-in': false }, '对照读取失败']
  ] as const)('fails closed for %j', async (verdicts, reason) => {
    const t = session(verdicts), root = await data()
    await expect(runMacSelfTest('/app/tex-darwin', root, t.deps)).rejects.toThrow(reason)
    expect(t.fake.dispose).toHaveBeenCalled()
    expect(await readdir(join(root, 'tex', 'selftest'))).toEqual([])
  })

  it('does not count a refusal that is not the sandbox saying no (missing file, timeout, full table)', async () => {
    for (const errno of [2, 24, 60, 111]) {
      await expect(runMacSelfTest('/app/tex-darwin', await data(), session({}, 0, PDF, errno).deps)).rejects.toThrow('沙箱内仍能读取用户数据目录')
    }
    await expect(runMacSelfTest('/app/tex-darwin', await data(), session({}, 0, PDF, 13).deps)).resolves.toEqual({ xelatex: true })
  })

  it('fails when the app itself cannot reach its listener, or the sandbox reached it', async () => {
    const unreachable = session()
    unreachable.deps.listen = async () => ({ port: 40000, connections: () => 0, close: async () => undefined, reachable: async () => false })
    await expect(runMacSelfTest('/app/tex-darwin', await data(), unreachable.deps)).rejects.toThrow('无法建立本机监听端口')
    const reached = session()
    let seen = 1
    reached.fake.probe.mockImplementation(async (kind: string, argument: string) => {
      if (kind === 'connect') seen++ // the listener saw a connection although the probe says denied
      return { allowed: argument.startsWith(REMOTE), errno: 1 }
    })
    reached.deps.listen = async () => ({ port: 40000, connections: () => seen, close: async () => undefined, reachable: async () => true })
    await expect(runMacSelfTest('/app/tex-darwin', await data(), reached.deps)).rejects.toThrow('沙箱内仍能联网')
  })

  it('counts its own control connection before probing (real loopback listener, repeated)', async () => {
    for (let round = 0; round < 20; round++) {
      const t = session()
      await expect(runMacSelfTest('/app/tex-darwin', await data(), { createSession: t.deps.createSession })).resolves.toEqual({ xelatex: true })
    }
  })

  it('passes without XeLaTeX when only that engine fails inside the sandbox', async () => {
    await expect(runMacSelfTest('/app/tex-darwin', await data(), session({}, 0, PDF, 1, 1).deps)).resolves.toEqual({ xelatex: false })
  })

  it('removes scratch folders left by a run that crashed', async () => {
    const root = await data(), stale = join(root, 'tex', 'selftest', 'paperstudio-stale')
    await mkdir(stale, { recursive: true }); await writeFile(join(stale, 'outside.txt'), 'old')
    await runMacSelfTest('/app/tex-darwin', root, session().deps)
    expect(await readdir(join(root, 'tex', 'selftest'))).toEqual([])
  })

  it('fails when the compile fails, yields no real PDF, or cleanup is not confirmed', async () => {
    await expect(runMacSelfTest('/app/tex-darwin', await data(), session({}, 1).deps)).rejects.toThrow('编译失败')
    await expect(runMacSelfTest('/app/tex-darwin', await data(), session({}, 0, Buffer.from('not a pdf')).deps)).rejects.toThrow('完整的 PDF')
    await expect(runMacSelfTest('/app/tex-darwin', await data(), session({}, 0, null).deps)).rejects.toThrow('完整的 PDF')
    const unclean = session(); unclean.fake.dispose.mockRejectedValue(new Error('残留风险'))
    await expect(runMacSelfTest('/app/tex-darwin', await data(), unclean.deps)).rejects.toThrow('残留风险')
  })
})
