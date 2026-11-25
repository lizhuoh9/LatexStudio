import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CompileRequest, CompileResult, TexEnvironment } from '../../shared/workspace-contracts'
import type { SyncTexData } from '../../shared/synctex'
import { checkCanceled, copyProject, createBuild, loadPdf, loadSynctex, monitorBuild, removeBuild } from '../local/build'
import { decodeText, failure, LIMITS, projectPath, SafeProject } from '../local/paths'
import { BoundedLog } from '../local/process'
import { isConfirmedCancellation, isSessionNotStarted, type SandboxSession, type SandboxSessionFactory,
  type SandboxSessionOptions } from '../sandbox/session'
import { bibliographyTool } from './bibliography'
import { PATCHED_ENGINE_DIR, USABLE_WINDOWS_ENGINES } from './patched-engines'
import { DARWIN_TOOLS } from './darwin-runtime'
import { texBackend, type RuntimeSource } from './platform-backend'
import type { PreparedTex } from './prepare'

/** Production entry: never imports PATH discovery, direct child_process or the legacy research compiler. */
export const COMPILE_TIMEOUT_MS = 120_000
const CANCELED = 'Windows 系统沙箱不可用，已拒绝编译：编译已取消'
const ENGINE_NOT_ACCEPTED = '所选编译引擎没有通过这台电脑的隔离自检，暂不可用；请改用 pdfLaTeX。'
const LATCHED = '隔离会话未确认完整清理，本次运行已停用编译；请重新启动 LatexStudio 后再试。'
const LIMITATION = '隔离编译：应用管理的引擎两遍（XeLaTeX 另经 xdvipdfmx 生成 PDF）；不执行 latexmk、项目脚本或参考文献程序，不联网。\n'
type Engine = typeof USABLE_WINDOWS_ENGINES[number]
const LABELS: Record<Engine, string> = { pdflatex: 'pdfLaTeX', xelatex: 'XeLaTeX' }
const BIBER_NOTE = '检测到 biblatex 使用 Biber 后端；当前仅支持 BibTeX。请改用 \\usepackage[backend=bibtex]{biblatex} 或 natbib。'
interface RunContext { prepared: PreparedTex; engine: Engine; source: string; probe: string; main: string }

export interface CompilerDependencies {
  platform?: NodeJS.Platform
  runtimes?: RuntimeSource
  createSession?: SandboxSessionFactory
  /** Whether this build carries accepted macOS release pins; defaults to the application's own constants. */
  macAccepted?: boolean
  timeoutMs?: number
  /** Process-wide by default: a residual-risk latch must survive switching projects. */
  latch?: { latched: boolean }
}
const processLatch = { latched: false }
const OUTPUT_FILES = ['paperstudio.pdf', 'paperstudio.synctex.gz'] as const
const BIBLIOGRAPHY_FILES = ['paperstudio.aux', 'paperstudio.bcf'] as const
interface Backend { runtimes: RuntimeSource; createSession: SandboxSessionFactory }

/** Injected parts win; the rest comes from the platform's backend. Null means compilation is not enabled here. */
function backendFor(deps: CompilerDependencies): Backend | null {
  const backend = texBackend(deps.platform ?? process.platform, deps.macAccepted)
  return backend && { runtimes: deps.runtimes ?? backend.runtimes, createSession: deps.createSession ?? backend.createSession }
}

export async function detectTexEnvironment(signal?: AbortSignal, dataRoot?: string,
  deps: CompilerDependencies = {}): Promise<TexEnvironment> {
  signal?.throwIfAborted()
  const backend = backendFor(deps)
  if (!backend) return { available: false, engines: [], description: '当前系统暂不支持编译。' }
  const prepared = dataRoot ? await backend.runtimes.get(dataRoot, signal) : null
  signal?.throwIfAborted()
  if (!prepared) return { available: false, engines: [], description: '编译组件尚未就绪。' }
  return { available: true, engines: [...(prepared.engines ?? USABLE_WINDOWS_ENGINES)],
    description: '编译组件已就绪。' }
}

/** A clean cancellation is the only session failure that keeps the compiler usable. */
function confirmedCancellation(error: unknown): boolean {
  return isConfirmedCancellation(error) || (error instanceof Error && error.message === CANCELED)
}

interface Attempt { controller: AbortController; log: BoundedLog; folder?: string; session?: SandboxSession }

export class LocalCompiler {
  private active: AbortController | undefined
  private disposed = false
  private readonly latch: { latched: boolean }
  private readonly backend: Backend | null
  private readonly timeoutMs: number

  constructor(private readonly root: string, private readonly buildRoot: string, private readonly dataRoot: string,
    private readonly onLog?: (message: string) => void, deps: CompilerDependencies = {}) {
    this.backend = backendFor(deps)
    this.timeoutMs = deps.timeoutMs ?? COMPILE_TIMEOUT_MS
    this.latch = deps.latch ?? processLatch
  }

  async run(request: CompileRequest): Promise<CompileResult> {
    const refusal = this.disposed ? '编译器已关闭' : this.latch.latched ? LATCHED : this.active ? '已有编译任务正在进行，请取消或等待完成' : null
    if (refusal) return { ok: false, canceled: false, pdf: null, durationMs: 0, log: refusal }
    const started = Date.now()
    const attempt: Attempt = { controller: new AbortController(), log: new BoundedLog(this.onLog) }
    this.active = attempt.controller
    const timer = setTimeout(() => attempt.controller.abort('timeout'), this.timeoutMs)
    let compiled: { pdf: Uint8Array; synctex: SyncTexData | null } | null = null
    attempt.log.push(Buffer.from(LIMITATION))
    try {
      compiled = await this.compile(request, attempt)
    } catch (error) {
      // After an abort the result suffix explains why; the thrown value is often just the abort reason.
      if (!attempt.controller.signal.aborted) attempt.log.push(Buffer.from(`\n${error instanceof Error ? error.message : '编译失败'}\n`))
    } finally {
      clearTimeout(timer)
      await this.release(attempt)
      this.active = undefined
    }
    return this.result(attempt, compiled, started)
  }
  cancel(): void { this.active?.abort('canceled') }
  dispose(): void { this.disposed = true; this.cancel() }

  private async compile(request: CompileRequest, attempt: Attempt): Promise<{ pdf: Uint8Array; synctex: SyncTexData | null }> {
    const { signal } = attempt.controller
    const project = await this.prepare(request)
    const backend = this.backend
    if (!backend) throw failure('此平台的隔离编译尚未验收，未启用。')
    const prepared = await backend.runtimes.get(this.dataRoot, signal)
    if (!prepared) throw failure('编译组件尚未就绪，请稍候或重试。')
    if (prepared.engines && !prepared.engines.includes(request.engine as Engine)) throw failure(ENGINE_NOT_ACCEPTED)
    checkCanceled(signal)
    attempt.folder = await createBuild(this.root, this.buildRoot)
    const stopMonitor = monitorBuild(attempt.folder, attempt.controller)
    try {
      const source = join(attempt.folder, 'source'), probe = join(attempt.folder, 'probe')
      await copyProject(project, source, signal)
      await mkdir(join(source, '.paperstudio-output'), { mode: 0o700 }); await mkdir(probe, { mode: 0o700 })
      checkCanceled(signal)
      // Re-verify after the (possibly slow) snapshot copy so the pinned engine is checked just before launch.
      const current = await backend.runtimes.get(this.dataRoot, signal)
      if (!current || current.root !== prepared.root) throw failure('TeX 资源在编译准备期间发生变化，请重试。')
      const run: RunContext = { prepared: current, engine: request.engine as Engine, source, probe, main: request.mainFile }
      attempt.session = await this.openSession(run, attempt)
      await this.passes(attempt.session, run, attempt)
      checkCanceled(signal)
      const output = join(source, '.paperstudio-output')
      // A backend with its own work directory hands the results back first; SyncTeX then names that directory.
      await attempt.session.pull?.(OUTPUT_FILES)
      return { pdf: await loadPdf(output), synctex: await loadSynctex(output, attempt.session.remoteRoot ?? source) }
    } finally { await stopMonitor() }
  }

  private openSession(run: RunContext, attempt: Attempt): Promise<SandboxSession> {
    const { prepared, engine } = run
    const tools = engine === 'xelatex' ? { xdvipdfmx: join(prepared.root, prepared.manifest.tools.xdvipdfmx) } : undefined
    return this.startSession({ executable: join(prepared.root, prepared.manifest.engines[engine]), runtimeRoot: prepared.root,
      ...(tools ? { tools } : {}), workDirs: [run.source, run.probe], signal: attempt.controller.signal, timeoutMs: this.timeoutMs }, attempt)
  }

  /** A failed start may have spawned the helper with unknown cleanup, so only a clean cancellation, or a refusal
   * made before anything was started, stays usable. */
  private async startSession(options: SandboxSessionOptions, attempt: Attempt): Promise<SandboxSession> {
    try {
      if (!this.backend) throw failure('此平台的隔离编译尚未验收，未启用。')
      return await this.backend.createSession(options)
    } catch (error) {
      if (!confirmedCancellation(error) && !isSessionNotStarted(error)) this.latchAfter(attempt)
      throw error
    }
  }

  /** cancel() after an abort, dispose() otherwise; anything but a confirmed clean end latches the compiler. */
  private async closeSession(session: SandboxSession, attempt: Attempt): Promise<void> {
    try {
      if (attempt.controller.signal.aborted) await session.cancel()
      else await session.dispose()
    } catch (error) {
      if (!confirmedCancellation(error)) this.latchAfter(attempt)
    }
  }
  private latchAfter(attempt: Attempt): void {
    this.latch.latched = true
    attempt.log.push(Buffer.from(`\n${LATCHED}\n`))
  }

  /** Pass 1, then BibTeX when the run cites a \bibliography, then the remaining passes (2 without, 3 with BibTeX). */
  private async passes(session: SandboxSession, run: RunContext, attempt: Attempt): Promise<void> {
    const { engine, source } = run
    // The format is passed by NAME: kpathsea resolves it to the pinned runtime's file (re-hashed by the trust cache,
    // see RUNTIME_FORMATS in runtime-cache.ts), and project snapshots never contain .fmt files. An absolute path argument would break
    // XeTeX when the runtime lives under a non-ASCII (e.g. Chinese user name) path.
    const args = ['-no-shell-escape', '-no-parse-first-line', `-progname=${engine}`, `-fmt=${engine}`,
      '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-jobname=paperstudio',
      '-output-directory=./.paperstudio-output', ...(engine === 'xelatex' ? ['-no-pdf'] : []), `./${run.main}`]
    const record = (bytes: Buffer): void => attempt.log.push(bytes)
    let total = 2
    for (let pass = 1; pass <= total; pass++) {
      checkCanceled(attempt.controller.signal)
      attempt.log.push(Buffer.from(`\n${LABELS[engine]}：第 ${pass}/${total} 遍\n`))
      const result = await session.run(args, source, { onStdout: record, onStderr: record })
      if (result.code !== 0) {
        attempt.log.push(Buffer.from(`\n${LABELS[engine]} 进程退出码：${result.code}\n`))
        throw failure('TeX 编译失败，请查看日志。')
      }
      if (pass === 1 && await this.bibliography(session, run, attempt, record)) total = 3
    }
    if (engine === 'xelatex') await this.convert(session, source, attempt, record)
  }

  /** Returns true when BibTeX ran. Its warnings/errors are logged but do not abort: LaTeX still produces a PDF. */
  private async bibliography(engineSession: SandboxSession, run: RunContext, attempt: Attempt,
    record: (bytes: Buffer) => void): Promise<boolean> {
    await engineSession.pull?.(BIBLIOGRAPHY_FILES)
    const tool = await bibliographyTool(join(run.source, '.paperstudio-output'))
    if (tool === 'biber') attempt.log.push(Buffer.from(`\n${BIBER_NOTE}\n`))
    if (tool !== 'bibtex') return false
    checkCanceled(attempt.controller.signal)
    attempt.log.push(Buffer.from('\nBibTeX：处理参考文献\n'))
    const bibtexArgs = ['-terse', './.paperstudio-output/paperstudio']
    if (engineSession.runsBibtex) {
      // Same session: that backend binds its own pinned BibTeX and runs it INSIDE the output folder, because on Unix
      // kpathsea's paranoid mode refuses to write under a dot-directory named on the command line.
      this.reportBibtex(await engineSession.run(['-terse', 'paperstudio'], run.source, { tool: 'bibtex', onStdout: record, onStderr: record }), attempt)
      return true
    }
    const executable = run.prepared.manifest.platform === 'darwin' ? join(run.prepared.root, ...DARWIN_TOOLS.bibtex.split('/'))
      : join(run.prepared.root, 'install', ...PATCHED_ENGINE_DIR.split('/'), 'bibtex.exe')
    const session = await this.startSession({ executable, runtimeRoot: run.prepared.root, workDirs: [run.source, run.probe],
      signal: attempt.controller.signal, timeoutMs: this.timeoutMs }, attempt)
    try {
      this.reportBibtex(await session.run(bibtexArgs, run.source, { onStdout: record, onStderr: record }), attempt)
    } finally { await this.closeSession(session, attempt) }
    if (this.latch.latched) throw failure('隔离会话清理未确认，已停止编译。')
    return true
  }

  private reportBibtex(result: { code: number }, attempt: Attempt): void {
    if (result.code >= 2) attempt.log.push(Buffer.from(`\nBibTeX 报告错误（退出码 ${result.code}），参考文献可能不完整，请查看上方日志。\n`))
  }

  /** XeLaTeX writes .xdv; the session's bound, pinned xdvipdfmx turns it into the fixed output PDF. */
  private async convert(session: SandboxSession, source: string, attempt: Attempt,
    record: (bytes: Buffer) => void): Promise<void> {
    checkCanceled(attempt.controller.signal)
    attempt.log.push(Buffer.from('\nxdvipdfmx：生成 PDF\n'))
    // -D "" clears dvipdfmx.cfg's Ghostscript (rungs) template, so EPS/unsupported images never try to spawn it.
    // Command-line options are applied after the config file. Other child attempts (e.g. PSTricks popen) are still
    // refused by the per-run job limit and the AppContainer.
    const result = await session.run(['-D', '', '-o', './.paperstudio-output/paperstudio.pdf', './.paperstudio-output/paperstudio.xdv'],
      source, { tool: 'xdvipdfmx', onStdout: record, onStderr: record })
    if (result.code !== 0) {
      attempt.log.push(Buffer.from(`\nxdvipdfmx 进程退出码：${result.code}\n`))
      throw failure('PDF 转换失败，请查看日志。')
    }
  }

  /** Session first (it holds the build roots), then the snapshot. Unconfirmed cleanup latches the compiler. */
  private async release(attempt: Attempt): Promise<void> {
    if (attempt.session) await this.closeSession(attempt.session, attempt)
    // With unconfirmed cleanup a helper may still hold the snapshot: keep it rather than race it.
    if (attempt.folder && !this.latch.latched) {
      await removeBuild(attempt.folder).catch(() => attempt.log.push(Buffer.from('\n无法清理编译缓存，请检查目录权限\n')))
    }
  }

  private result(attempt: Attempt, compiled: { pdf: Uint8Array; synctex: SyncTexData | null } | null, started: number): CompileResult {
    const { signal } = attempt.controller
    const reason: unknown = signal.reason
    const suffix = signal.aborted ? `\n${reason === 'timeout' ? `编译超过 ${Math.round(this.timeoutMs / 1000)} 秒限制` :
      reason === 'canceled' ? '编译已取消' : String(reason)}\n` : ''
    return { ok: compiled !== null && !signal.aborted, canceled: reason === 'canceled',
      pdf: signal.aborted ? null : compiled?.pdf ?? null,
      synctex: signal.aborted ? null : compiled?.synctex ?? null,
      log: attempt.log.finish() + suffix, durationMs: Date.now() - started }
  }

  private async prepare(request: CompileRequest): Promise<SafeProject> {
    if (!request || typeof request.mainFile !== 'string') throw failure('编译请求无效')
    if (!(USABLE_WINDOWS_ENGINES as readonly string[]).includes(request.engine))
      throw failure('所选编译引擎不可用，请选择 pdfLaTeX 或 XeLaTeX。')
    projectPath(request.mainFile)
    if (!/\.tex$/i.test(request.mainFile)) throw failure('主文件必须是 .tex 文件')
    const project = new SafeProject(this.root)
    await project.initialize()
    decodeText(await project.readBytes(request.mainFile, LIMITS.text))
    return project
  }
}
