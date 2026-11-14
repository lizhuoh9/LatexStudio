import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/main/local/tools', () => { throw new Error('Production must not load PATH discovery') })
vi.mock('../src/main/local/compiler', () => { throw new Error('Production must not load the research compiler') })
import { detectTexEnvironment, LocalCompiler, type CompilerDependencies } from '../src/main/tex/compiler'
import type { WindowsSandboxRunOptions, WindowsSandboxSession, WindowsSandboxSessionOptions } from '../src/main/sandbox/windows'

// Synthetic sandbox session only: proves the compiler's control flow, not native isolation (see native tests).
const CANCELED = 'Windows 系统沙箱不可用，已拒绝编译：编译已取消'
const PDF = Buffer.from(`%PDF-1.5\n${'x'.repeat(2048)}\n%%EOF\n`)
const prepared = { root: 'C:\\data\\tex\\runtimes\\paperstudio-tex-00000000-0000-4000-8000-000000000000',
  manifest: { engines: { pdflatex: 'install/bin/paperstudio-x64/pdflatex.exe', xelatex: 'install/bin/paperstudio-x64/xelatex.exe' },
    tools: { xdvipdfmx: 'install/bin/paperstudio-x64/xdvipdfmx.exe' } } }
const roots: string[] = []
type Run = (args: string[], cwd: string, options: WindowsSandboxRunOptions, signal: AbortSignal) => Promise<{ code: number }>

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-gate-'))
  roots.push(root)
  const source = join(root, 'project'), builds = join(root, 'builds')
  await mkdir(source)
  await writeFile(join(source, 'main.tex'), '\\documentclass{article}\\begin{document}x\\end{document}\n')
  return { source, builds }
}
function writesPdf(code = 0): Run {
  return async (_args, cwd) => { await writeFile(join(cwd, '.paperstudio-output', 'paperstudio.pdf'), PDF); return { code } }
}
const untilAborted: Run = (_args, _cwd, _options, signal) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(new Error(CANCELED)), { once: true })
})
function harness(run: Run, extra: Partial<CompilerDependencies> & { dispose?: () => Promise<void>; start?: () => Promise<void> } = {}) {
  type FakeSession = { run: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
  const sessions: Array<{ options: WindowsSandboxSessionOptions; session: FakeSession }> = []
  const createSession = vi.fn(async (options: WindowsSandboxSessionOptions) => {
    await extra.start?.()
    const session = { run: vi.fn((args: string[], cwd: string, runOptions: WindowsSandboxRunOptions = {}) => run(args, cwd, runOptions, options.signal!)),
      cancel: vi.fn(async () => undefined), dispose: vi.fn(extra.dispose ?? (async () => undefined)) }
    sessions.push({ options, session })
    return session as unknown as WindowsSandboxSession
  })
  const deps: CompilerDependencies = { platform: 'win32', runtimes: { get: vi.fn(async () => prepared) } as never,
    createSession, latch: { latched: false }, ...extra }
  return { deps, sessions, createSession }
}
async function compiler(run: Run, extra: Parameters<typeof harness>[1] = {}) {
  const paths = await project(), h = harness(run, extra)
  return { ...paths, ...h, compiler: new LocalCompiler(paths.source, paths.builds, 'C:\\data', undefined, h.deps) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('environment detection', () => {
  it('enables only pdflatex when a trusted runtime exists', async () => {
    const get = vi.fn(async () => prepared)
    expect(await detectTexEnvironment(undefined, 'C:\\data', { platform: 'win32', runtimes: { get } as never }))
      .toMatchObject({ available: true, engines: ['pdflatex', 'xelatex'] })
  })
  it('stays unavailable without a runtime, off Windows, and does no lookup after cancellation', async () => {
    const get = vi.fn(async () => null)
    expect(await detectTexEnvironment(undefined, 'C:\\data', { platform: 'win32', runtimes: { get } })).toMatchObject({ available: false, engines: [] })
    expect(await detectTexEnvironment(undefined, '/data', { platform: 'darwin', runtimes: { get } })).toMatchObject({ available: false })
    await expect(detectTexEnvironment(AbortSignal.abort(), 'C:\\data', { platform: 'win32', runtimes: { get } })).rejects.toThrow()
    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('managed pdflatex compile', () => {
  it('runs two sandboxed passes on a snapshot, returns the PDF and removes the snapshot', async () => {
    const t = await compiler(writesPdf())
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result).toMatchObject({ ok: true, canceled: false })
    expect(Buffer.from(result.pdf!).equals(PDF)).toBe(true)
    const { options, session } = t.sessions[0]!
    expect(options.executable).toBe(join(prepared.root, 'install/bin/paperstudio-x64/pdflatex.exe'))
    expect(options.workDirs).toHaveLength(2)
    expect(session.run).toHaveBeenCalledTimes(2)
    const args = session.run.mock.calls[0]![0] as string[]
    expect(args).toContain('-no-shell-escape'); expect(args).toContain('./main.tex')
    expect(args).toContain('-fmt=pdflatex')
    expect(session.dispose).toHaveBeenCalledTimes(1); expect(session.cancel).not.toHaveBeenCalled()
    expect(await readdir(t.builds)).toEqual([])
  })

  it('runs XeLaTeX as two -no-pdf passes then the bound xdvipdfmx tool, with the converter in the session policy', async () => {
    const t = await compiler(async (args, cwd, options) => {
      if (options.tool === 'xdvipdfmx') await writeFile(join(cwd, '.paperstudio-output', 'paperstudio.pdf'), PDF)
      return { code: args.includes('-no-pdf') || options.tool === 'xdvipdfmx' ? 0 : 1 }
    })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'xelatex' })
    expect(result).toMatchObject({ ok: true, canceled: false })
    const { options, session } = t.sessions[0]!
    expect(options.executable).toBe(join(prepared.root, 'install/bin/paperstudio-x64/xelatex.exe'))
    expect(options.tools).toEqual({ xdvipdfmx: join(prepared.root, 'install/bin/paperstudio-x64/xdvipdfmx.exe') })
    const calls = session.run.mock.calls as Array<[string[], string, WindowsSandboxRunOptions?]>
    expect(calls).toHaveLength(3)
    expect(calls.slice(0, 2).every(([args]) => args.includes('-no-pdf') && args.includes('-fmt=xelatex'))).toBe(true)
    expect(calls[2]![2]?.tool).toBe('xdvipdfmx')
    expect(calls[2]![0]).toEqual(['-D', '', '-o', './.paperstudio-output/paperstudio.pdf', './.paperstudio-output/paperstudio.xdv'])
    expect(await readdir(t.builds)).toEqual([])
  })

  it('runs BibTeX in its own session between pass 1 and the remaining two passes when \\bibdata is present', async () => {
    const t = await compiler(async (args, cwd) => {
      const out = join(cwd, '.paperstudio-output')
      if (args[0] === '-terse') await writeFile(join(out, 'paperstudio.bbl'), '\\begin{thebibliography}{1}\\end{thebibliography}')
      else { await writeFile(join(out, 'paperstudio.aux'), '\\citation{knuth}\n\\bibdata{refs}\n'); await writeFile(join(out, 'paperstudio.pdf'), PDF) }
      return { code: 0 }
    })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(true)
    expect(t.sessions).toHaveLength(2)
    expect(t.sessions[1]!.options.executable).toBe(join(prepared.root, 'install', 'bin', 'paperstudio-x64', 'bibtex.exe'))
    expect(t.sessions[1]!.session.run.mock.calls[0]![0]).toEqual(['-terse', './.paperstudio-output/paperstudio'])
    expect(t.sessions[1]!.session.dispose).toHaveBeenCalledTimes(1)
    expect(t.sessions[0]!.session.run).toHaveBeenCalledTimes(3)
    expect(result.log).toContain('第 3/3 遍'); expect(result.log).toContain('BibTeX：处理参考文献')
  })

  it('keeps two passes without \\bibdata, logs a Biber note, and treats a BibTeX error as a warning', async () => {
    const plain = await compiler(writesPdf())
    expect((await plain.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).log).toContain('第 2/2 遍')
    expect(plain.sessions).toHaveLength(1)
    const biber = await compiler(async (_args, cwd) => {
      await writeFile(join(cwd, '.paperstudio-output', 'paperstudio.bcf'), '<bcf/>'); await writeFile(join(cwd, '.paperstudio-output', 'paperstudio.pdf'), PDF)
      return { code: 0 }
    })
    const noted = await biber.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(noted.ok).toBe(true); expect(noted.log).toContain('backend=bibtex'); expect(biber.sessions).toHaveLength(1)
    const erring = await compiler(async (args, cwd) => {
      if (args[0] === '-terse') return { code: 2 }
      await writeFile(join(cwd, '.paperstudio-output', 'paperstudio.aux'), '\\bibdata{missing}\n'); await writeFile(join(cwd, '.paperstudio-output', 'paperstudio.pdf'), PDF)
      return { code: 0 }
    })
    const warned = await erring.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(warned.ok).toBe(true); expect(warned.log).toContain('BibTeX 报告错误（退出码 2）')
  })

  it('reports a failed xdvipdfmx conversion without a PDF', async () => {
    const t = await compiler(async (_args, _cwd, options) => ({ code: options.tool === 'xdvipdfmx' ? 3 : 0 }))
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'xelatex' })
    expect(result).toMatchObject({ ok: false, pdf: null }); expect(result.log).toContain('PDF 转换失败')
  })

  it('refuses unaccepted engines, non-.tex files and a missing runtime before any session', async () => {
    const t = await compiler(writesPdf())
    const unsupported = await t.compiler.run({ mainFile: 'main.tex', engine: 'lualatex' })
    expect(unsupported).toMatchObject({ ok: false, pdf: null })
    expect(unsupported.log).toContain('编译引擎不可用')
    expect((await t.compiler.run({ mainFile: 'main.txt', engine: 'pdflatex' })).ok).toBe(false)
    t.deps.runtimes = { get: async () => null }
    const missing = new LocalCompiler(t.source, t.builds, 'C:\\data', undefined, t.deps)
    const unavailable = await missing.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(unavailable).toMatchObject({ ok: false, pdf: null })
    expect(unavailable.log).toContain('编译组件尚未就绪')
    expect(t.createSession).not.toHaveBeenCalled()
  })

  it('reports a TeX error with its log, cleans up and stays usable', async () => {
    let code = 1
    const t = await compiler(async (args, cwd, options) => {
      options.onStdout?.(Buffer.from('! Undefined control sequence.\n'))
      return writesPdf(code)(args, cwd, options, new AbortController().signal)
    })
    const failed = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(failed).toMatchObject({ ok: false, canceled: false, pdf: null })
    expect(failed.log).toContain('Undefined control sequence'); expect(failed.log).toContain('TeX 编译失败')
    expect(t.sessions[0]!.session.dispose).toHaveBeenCalled()
    expect(await readdir(t.builds)).toEqual([])
    code = 0
    expect((await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).ok).toBe(true)
  })

  it('cancels a running pass with confirmed cleanup and stays usable', async () => {
    const t = await compiler(untilAborted)
    const pending = t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    await vi.waitFor(() => expect(t.sessions[0]?.session.run).toHaveBeenCalled())
    t.compiler.cancel()
    expect(await pending).toMatchObject({ ok: false, canceled: true, pdf: null })
    expect(t.sessions[0]!.session.cancel).toHaveBeenCalled()
    expect(await readdir(t.builds)).toEqual([])
    expect(t.deps.latch!.latched).toBe(false)
  })

  it('stops at the time limit with the same cleanup', async () => {
    const t = await compiler(untilAborted, { timeoutMs: 150 })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result).toMatchObject({ ok: false, canceled: false, pdf: null })
    expect(result.log).toContain('编译超过 0 秒限制'.replace('0', String(Math.round(150 / 1000))))
    expect(t.sessions[0]!.session.cancel).toHaveBeenCalled()
    expect(await readdir(t.builds)).toEqual([])
  })

  it('latches process-wide when sandbox cleanup is not confirmed, and keeps the snapshot', async () => {
    const t = await compiler(writesPdf(), { dispose: async () => { throw new Error('助手退出但未确认完整清理；存在残留风险') } })
    const first = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(first.ok).toBe(true)
    expect(first.log).toContain('请重新启动 LatexStudio')
    expect(await readdir(t.builds)).toHaveLength(1)
    expect((await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).log).toContain('请重新启动 LatexStudio')
    const other = new LocalCompiler(t.source, t.builds, 'C:\\data', undefined, t.deps)
    expect((await other.run({ mainFile: 'main.tex', engine: 'pdflatex' })).log).toContain('请重新启动 LatexStudio')
    expect(t.createSession).toHaveBeenCalledTimes(1)
  })

  it('latches on an abnormal helper exit during a pass', async () => {
    const exited: Run = async () => { throw new Error('Windows 系统沙箱不可用，已拒绝编译：助手退出但未确认完整清理；存在残留风险') }
    const t = await compiler(exited, { dispose: async () => { throw new Error('会话未正常清理') } })
    const result = await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(result.ok).toBe(false); expect(t.deps.latch!.latched).toBe(true)
  })

  it('latches on a failed session start but not on a cancelled one', async () => {
    const broken = await compiler(writesPdf(), { start: async () => { throw new Error('无法启动原生助手') } })
    await broken.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(broken.deps.latch!.latched).toBe(true)
    const canceled = await compiler(writesPdf(), { start: async () => { throw new Error(CANCELED) } })
    await canceled.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    expect(canceled.deps.latch!.latched).toBe(false)
  })

  it('refuses a concurrent run and cancels the active run on dispose', async () => {
    const t = await compiler(untilAborted)
    const pending = t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    await vi.waitFor(() => expect(t.sessions[0]?.session.run).toHaveBeenCalled())
    expect((await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).log).toContain('已有编译任务')
    t.compiler.dispose()
    expect(await pending).toMatchObject({ canceled: true, ok: false })
    expect((await t.compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).log).toContain('已关闭')
  })
})
