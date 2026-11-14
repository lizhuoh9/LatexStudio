import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, win32 } from 'node:path'

export interface WindowsSandboxRunOptions {
  tool?: 'engine' | 'xdvipdfmx'
  onStdout?: (bytes: Buffer) => void
  onStderr?: (bytes: Buffer) => void
}
export interface WindowsSandboxResult { code: number }
export interface WindowsSandboxClose {
  reason: string
  cleanup: boolean
  elapsedMs: number
  profile: string | null
}
export interface WindowsSandboxSession {
  run(args: string[], cwd: string, options?: WindowsSandboxRunOptions): Promise<WindowsSandboxResult>
  cancel(): Promise<void>
  dispose(): Promise<void>
}
export interface WindowsSandboxSessionOptions {
  executable: string
  runtimeRoot: string
  tools?: { xdvipdfmx?: string }
  workDirs: string[]
  signal?: AbortSignal
  timeoutMs?: number
}
export interface WindowsSandbox { command: string; argsPrefix: string[]; env: NodeJS.ProcessEnv; gracefulCancel: 'stdin' }
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const MAX_FRAME = 16384
const MAX_OUTPUT = 2 * 1024 * 1024
const TERMINAL_REASONS = new Set(['closed', 'canceled', 'timeout', 'owner-exit', 'eof', 'protocol-error', 'error', 'output-limit'])
const PROFILE = /^PaperStudio\.Compiler\.[a-f0-9]{32}$/
const RUNTIME = /^paperstudio-tex-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i

function fail(message: string): Error { return new Error(`Windows 系统沙箱不可用，已拒绝编译：${message}`) }
function within(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}
async function canonical(path: string, directory: boolean): Promise<string> {
  if (!isAbsolute(path) || /^\\\\|^\/\//.test(path) || path.slice(2).includes(':')) throw fail('需要本机绝对路径')
  const absolute = resolve(path)
  if (absolute === parse(absolute).root) throw fail('不能授权磁盘根目录')
  let current = absolute
  while (current !== dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw fail('路径不能经过符号链接或目录联接')
    current = dirname(current)
  }
  const info = await lstat(absolute)
  if (directory ? !info.isDirectory() : !info.isFile()) throw fail('路径类型不正确')
  const actual = await realpath(absolute)
  if (actual.toLowerCase() !== absolute.toLowerCase()) throw fail('路径被重定向')
  return actual
}
async function helperPath(): Promise<string> {
  const desktop = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean }
  const resources = desktop.resourcesPath
  if (process.versions.electron && !desktop.defaultApp) {
    if (!resources) throw fail('打包应用缺少原生资源位置')
    try { return await canonical(join(resources, 'win32', 'PaperStudio.Sandbox.exe'), false) }
    catch { throw fail('打包原生助手不可用；不会从当前项目目录加载替代文件') }
  }
  const candidates = [resources ? join(resources, 'win32', 'PaperStudio.Sandbox.exe') : '',
    resolve(__dirname, '../../resources/win32/PaperStudio.Sandbox.exe'),
    resolve(__dirname, '../../../resources/win32/PaperStudio.Sandbox.exe'),
    resolve(process.cwd(), 'resources/win32/PaperStudio.Sandbox.exe')].filter(Boolean)
  for (const path of candidates) {
    try { return await canonical(path, false) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw fail('未打包原生助手；不会降级直接启动 TeX')
}
function environment(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
    const value = Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
    if (value) env[key] = value
  }
  env.PATH = [dirname(executable), join(env.SystemRoot ?? 'C:\\Windows', 'System32')].join(';')
  return env
}
async function sessionPolicy(options: WindowsSandboxSessionOptions) {
  if (process.platform !== 'win32') throw fail('此实现仅支持 Windows')
  if (options.signal?.aborted) throw fail('启动前已取消')
  const timeout = options.timeoutMs ?? 120000
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw fail('无效会话期限')
  const root = await canonical(options.runtimeRoot, true)
  const id = RUNTIME.exec(win32.basename(root))?.[1]
  if (!id) throw fail('必须使用应用管理的 TeX 副本，不能授权现有 TeX 安装')
  const manifestFile = await canonical(join(root, 'paperstudio-runtime.json'), false)
  if ((await lstat(manifestFile)).size > MAX_FRAME) throw fail('运行时清单过大')
  const manifest: unknown = JSON.parse(await readFile(manifestFile, 'utf8'))
  if (!isRecord(manifest) || manifest.schema !== 1 || manifest.ready !== true || manifest.platform !== 'win32'
    || typeof manifest.id !== 'string' || manifest.id.toLowerCase() !== id.toLowerCase()) throw fail('运行时清单未就绪或不匹配')
  if (manifest.distribution !== 'texlive' && manifest.distribution !== 'miktex') throw fail('不支持的应用 TeX 发行版')
  const executable = await canonical(options.executable, false)
  const converter = options.tools?.xdvipdfmx ? await canonical(options.tools.xdvipdfmx, false) : undefined
  if (!within(root, executable) || (converter && !within(root, converter))) throw fail('工具不在应用管理的资源根中')
  if (!options.workDirs.length || options.workDirs.length > 2) throw fail('仅允许 source/probe 两个隔离工作根')
  const work = await Promise.all(options.workDirs.map((path) => canonical(path, true)))
  for (const path of work) {
    if (!/^paperstudio-[a-z0-9-]+$/i.test(win32.basename(dirname(path)))) throw fail('工作目录不是独立应用副本')
    if (within(root, path) || within(path, root)) throw fail('资源目录与工作目录不能重叠')
  }
  if (work[0] && work[1] && (within(work[0], work[1]) || within(work[1], work[0]))) throw fail('工作根不能重叠')
  return { executable, converter, root, work, timeout, helper: await helperPath() }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
type ActiveRun = { id: number; started: boolean; options: WindowsSandboxRunOptions; result: ReturnType<typeof deferred<WindowsSandboxResult>> }
type Policy = Awaited<ReturnType<typeof sessionPolicy>>

class NativeSession implements WindowsSandboxSession {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly ready = deferred<void>()
  private readonly ended = deferred<void>()
  private active?: ActiveRun
  private closeFrame?: WindowsSandboxClose
  private terminalError?: Error
  private cancellationError?: Error
  private cleanupStarted = false
  private cleanupProfile?: string | null
  private incoming = Buffer.alloc(0)
  private outputBytes = 0
  private diagnosticBytes = 0
  private nextId = 1
  private profile?: string
  private isReady = false
  private stopping = false
  private finished = false
  private hardKill?: NodeJS.Timeout
  private readonly timer: NodeJS.Timeout
  private abort?: () => void

  constructor(private readonly policy: Policy, private readonly signal?: AbortSignal) {
    const args = ['--session', '1', '--runtime-root', policy.root, '--timeout-ms', String(policy.timeout),
      ...policy.work.flatMap((work) => ['--work-dir', work]),
      ...(policy.converter ? ['--tool-xdvipdfmx', policy.converter] : []), '--', policy.executable]
    this.child = spawn(policy.helper, args, { stdio: 'pipe', windowsHide: true, detached: true, env: environment(policy.executable) })
    this.child.stdout.on('data', (bytes: Buffer) => this.receive(bytes))
    this.child.stderr.on('data', (bytes: Buffer) => { this.diagnosticBytes += bytes.length; if (this.diagnosticBytes > 65536) this.protocolFailure('助手诊断超限') })
    this.child.stdin.on('error', () => { if (!this.stopping && !this.finished) this.protocolFailure('控制管道断开') })
    this.child.once('error', () => { this.terminalError = fail('无法启动原生助手'); this.finish(null) })
    this.child.once('close', (code) => this.finish(code))
    this.timer = setTimeout(() => this.stop('timeout', fail('会话超过总期限')), policy.timeout)
    if (signal) {
      this.abort = () => {
        const error = fail('编译已取消')
        if (!this.terminalError) this.cancellationError = error
        this.stop('canceled', error)
      }
      signal.addEventListener('abort', this.abort, { once: true }); if (signal.aborted) this.abort()
    }
  }
  async waitReady(): Promise<void> {
    await this.ready.promise
    if (this.terminalError) { await this.ended.promise; throw this.terminalError }
    if (!this.isReady || this.stopping) { await this.ended.promise; throw fail('会话未能就绪') }
  }
  private send(frame: object): void {
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line) > MAX_FRAME) throw fail('控制帧过大')
    if (!this.child.stdin.writable || this.finished) throw fail('会话已经关闭')
    this.child.stdin.write(line)
  }
  private stop(reason: 'timeout' | 'canceled', error?: Error): void {
    if (this.finished) return
    if (error && !this.terminalError) this.terminalError = error
    if (!this.stopping) {
      this.stopping = true
      try { this.send({ type: 'cancel', reason }) } catch { /* close handler validates cleanup */ }
    }
    this.armHardKill()
  }
  private armHardKill(graceMs = 10000): void {
    if (this.hardKill || this.finished) return
    this.hardKill = setTimeout(() => {
      this.terminalError = fail('助手未确认清理；存在残留风险，已强制终止，不能继续编译')
      this.child.kill('SIGKILL')
    }, graceMs)
  }
  private protocolFailure(message: string): void {
    this.terminalError = fail(`协议错误：${message}`)
    this.stop('canceled')
  }
  private receive(bytes: Buffer): void {
    if (this.finished) return
    let input = Buffer.concat([this.incoming, bytes])
    let index: number
    while ((index = input.indexOf(10)) !== -1) {
      if (index >= MAX_FRAME) { this.protocolFailure('输出帧过大'); return }
      const line = input.subarray(0, index)
      input = input.subarray(index + 1)
      try { this.frame(JSON.parse(UTF8.decode(line)) as unknown) }
      catch { this.protocolFailure('无效输出帧'); return }
    }
    if (input.length >= MAX_FRAME) { this.protocolFailure('未终止的输出帧'); return }
    this.incoming = Buffer.from(input)
  }
  private frame(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string' || this.closeFrame) throw new Error('Unexpected frame')
    if (value.type === 'cleanup-start') { this.acceptCleanup(value); return }
    if (value.type === 'closed') { this.acceptClosed(value); return }
    if (this.cleanupStarted) throw new Error('Execution after cleanup')
    if (value.type === 'ready') { this.acceptReady(value); return }
    if (!this.isReady || !this.active || value.id !== this.active.id) throw new Error('Unexpected run id')
    if (value.type === 'run-start') {
      if (this.active.started || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) throw new Error('Invalid run-start')
      this.active.started = true; return
    }
    if (!this.active.started) throw new Error('Run was not started')
    if (value.type === 'data') { this.acceptData(value, this.active); return }
    if (value.type !== 'run-exit' || !Number.isInteger(value.code) || (value.code as number) < -2147483648 || (value.code as number) > 2147483647) throw new Error('Invalid run-exit')
    this.active.result.resolve({ code: value.code as number }); this.active = undefined
  }
  private acceptReady(frame: Record<string, unknown>): void {
    if (this.isReady || frame.version !== 1 || typeof frame.profile !== 'string' || !PROFILE.test(frame.profile)) throw new Error('Invalid ready')
    this.profile = frame.profile; this.isReady = true; this.ready.resolve()
  }
  private acceptData(frame: Record<string, unknown>, run: ActiveRun): void {
    if ((frame.stream !== 'stdout' && frame.stream !== 'stderr') || typeof frame.data !== 'string'
      || frame.data.length > 5464 || frame.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('Invalid output data')
    const bytes = Buffer.from(frame.data, 'base64')
    if (bytes.toString('base64') !== frame.data || bytes.length === 0 || bytes.length > 4096) throw new Error('Invalid base64')
    this.outputBytes += bytes.length
    if (this.outputBytes > MAX_OUTPUT) throw new Error('Output limit')
    const callback = frame.stream === 'stdout' ? run.options.onStdout : run.options.onStderr
    try { callback?.(bytes) } catch { this.protocolFailure('输出回调失败') }
  }
  private acceptCleanup(frame: Record<string, unknown>): void {
    if (this.cleanupStarted || frame.activeProcesses !== 0 || !Number.isSafeInteger(frame.elapsedMs) || (frame.elapsedMs as number) < 0
      || frame.stage !== (this.isReady ? 'session' : 'setup')
      || (frame.profile !== null && (typeof frame.profile !== 'string' || !PROFILE.test(frame.profile)))
      || (this.profile && frame.profile !== this.profile)) throw new Error('Invalid cleanup stage')
    this.cleanupStarted = true; this.cleanupProfile = frame.profile as string | null
    this.stopping = true
    clearTimeout(this.timer)
    if (this.hardKill) clearTimeout(this.hardKill)
    this.hardKill = undefined
    this.armHardKill(30000)
  }
  private acceptClosed(frame: Record<string, unknown>): void {
    if (typeof frame.reason !== 'string' || !TERMINAL_REASONS.has(frame.reason) || typeof frame.cleanup !== 'boolean'
      || !Number.isSafeInteger(frame.elapsedMs) || (frame.elapsedMs as number) < 0
      || (frame.profile !== null && (typeof frame.profile !== 'string' || !PROFILE.test(frame.profile)))) throw new Error('Invalid closed')
    if (this.profile && frame.profile !== this.profile) throw new Error('Profile changed')
    if (frame.cleanup && !this.cleanupStarted) throw new Error('Cleanup stage missing')
    if (this.cleanupStarted && frame.profile !== this.cleanupProfile) throw new Error('Cleanup profile changed')
    this.closeFrame = frame as unknown as WindowsSandboxClose
    if (!frame.cleanup) this.terminalError = fail(`原生清理失败，残留profile：${frame.profile ?? 'unknown'}`)
    if (frame.reason !== 'closed' && !this.terminalError) {
      this.terminalError = fail(`会话终止：${frame.reason}`)
      if (frame.reason === 'canceled' && this.stopping) this.cancellationError = this.terminalError
    }
  }
  private finish(code: number | null): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer); if (this.hardKill) clearTimeout(this.hardKill)
    if (this.abort) this.signal?.removeEventListener('abort', this.abort)
    const expected = this.closeFrame?.cleanup === false ? 125 : this.closeFrame?.reason === 'closed' ? 0 : this.closeFrame?.reason === 'timeout' ? 124 : 1223
    if (!this.closeFrame || this.incoming.length || code !== expected) {
      this.terminalError = fail('助手退出但未确认完整清理；存在残留风险')
    }
    if (this.active) this.active.result.resolve({ code: 125 })
    this.ready.resolve(); this.ended.resolve()
    this.child.stdin.destroy()
  }
  async run(args: string[], cwd: string, options: WindowsSandboxRunOptions = {}): Promise<WindowsSandboxResult> {
    if (!this.isReady || this.finished || this.stopping || this.active) throw fail('会话不可运行或已有任务在执行')
    const approved = this.policy.work.find((path) => path.toLowerCase() === resolve(cwd).toLowerCase())
    if ((options.tool && options.tool !== 'engine' && options.tool !== 'xdvipdfmx') || (options.tool === 'xdvipdfmx' && !this.policy.converter)) throw fail('未绑定的受控工具')
    if (!approved || args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.length > 2048 || arg.includes('\0'))) throw fail('未授权的工作目录或参数')
    const run: ActiveRun = { id: this.nextId++, started: false, options, result: deferred<WindowsSandboxResult>() }
    this.active = run
    try { this.send({ type: 'run', id: run.id, cwd: approved, args, tool: options.tool ?? 'engine' }) }
    catch (error) { this.stop('canceled', error as Error) }
    const result = await run.result.promise
    if (this.stopping || this.terminalError || this.finished) {
      await this.ended.promise
      throw this.terminalError ?? fail('会话在运行期间结束')
    }
    return result
  }
  async cancel(): Promise<void> {
    this.stop('canceled')
    await this.ended.promise
    if (!this.closeFrame?.cleanup || !this.finished) throw this.terminalError ?? fail('取消未确认清理')
    if (this.closeFrame.reason !== 'canceled' && this.closeFrame.reason !== 'closed') throw this.terminalError ?? fail('取消异常')
    if (this.terminalError && this.terminalError !== this.cancellationError) throw this.terminalError
  }
  async dispose(): Promise<void> {
    if (this.active) return this.cancel()
    if (!this.finished && !this.stopping) {
      this.stopping = true
      try { this.send({ type: 'close' }) } catch { this.terminalError = fail('无法关闭控制管道') }
      this.armHardKill()
    }
    await this.ended.promise
    if (this.terminalError) throw this.terminalError
    if (!this.closeFrame?.cleanup || this.closeFrame.reason !== 'closed') throw fail('会话未正常清理')
  }
}

/** The trusted resource manager must verify runtime provenance and engine hashes before calling. */
export async function createWindowsSandboxSession(options: WindowsSandboxSessionOptions): Promise<WindowsSandboxSession> {
  const session = new NativeSession(await sessionPolicy(options), options.signal)
  await session.waitReady()
  return session
}
/** @deprecated Installed TeX roots must never receive ACLs; use an app-managed session. */
export async function windowsTexReadRoots(_executable: string): Promise<string[]> {
  throw fail('现有 TeX 安装不能直接授权；请准备应用管理的副本')
}
/** @deprecated Kept only to fail closed for stale callers of the research prototype. */
export async function prepareWindowsSandbox(_executable: string, _workDir: string, _readRoots: string[]): Promise<WindowsSandbox> {
  throw fail('旧单进程协议已停用；必须使用应用管理的会话')
}
