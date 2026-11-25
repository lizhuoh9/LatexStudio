import { spawn } from 'node:child_process'
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { ConfirmedCancellation, SessionNotStarted, type SandboxResult, type SandboxRunOptions, type SandboxSession,
  type SandboxSessionOptions } from './session'
import { ENCODED_CLOSE, encodeGet, encodeMkdir, encodeProbe, encodePut, encodeRun, MAC_HELPER_PROTOCOL, MacFrameReader,
  type MacFrame, type MacProbeKind, type MacTool } from './macos-protocol'

/**
 * macOS isolation backend: the compile helper is a minimal app bundle signed with the App Sandbox entitlement only.
 * The snapshot is sent over a pipe into the helper's own container; no user directory is ever granted to the sandbox.
 * NOT accepted until the real-Mac self-test (macos-selftest.ts) passes on the running machine.
 */
export interface MacHelperProcess {
  readonly pid?: number | undefined
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}
export interface MacSessionDependencies {
  platform?: NodeJS.Platform
  helper?: string
  overlayRoot?: string
  spawnHelper?: (command: string, args: string[]) => MacHelperProcess
  /** Last resort when the helper stops answering: kill the process group of the helper this app itself started. */
  killGroup?: (pgid: number) => void
}
export interface MacProbeResult { allowed: boolean; errno: number }
export interface MacSandboxSession extends SandboxSession {
  readonly remoteRoot: string
  readonly runsBibtex: true
  pull(names: readonly string[]): Promise<void>
  probe(kind: MacProbeKind, argument: string): Promise<MacProbeResult>
}

const OUTPUT_DIR = '.paperstudio-output'
const READY_TIMEOUT_MS = 15_000
const CLOSE_GRACE_MS = 10_000
/** After the helper's own time limit: a session that still has not ended is abandoned, never waited on forever. */
const WATCHDOG_MARGIN_MS = 30_000
/** How long the helper's last bytes may trail its exit before the pipe is given up (a stray child may hold it). */
const DRAIN_AFTER_EXIT_MS = 1_500
const CANCELED = 'macOS 原生隔离不可用，已拒绝编译：编译已取消'
/** Closing stdin makes a live helper kill its tool and remove its work folder; only then is it killed outright. */
const ABANDON_GRACE_MS = 2_000
/** Replies are consumed as they arrive; a helper that floods frames nobody asked for is abandoned. */
const MAX_QUEUED_FRAMES = 2_048
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_PULL = 40 * 1024 * 1024
export const MAC_HELPER_APP = 'darwin/LatexStudioCompiler.app'
export const MAC_HELPER_RELATIVE = `${MAC_HELPER_APP}/Contents/MacOS/latexstudio-compiler`
/**
 * The helper's App Sandbox reads its own bundle wherever the app is installed and nothing in the user's home or in
 * /private/tmp (measured on macOS 27.2.1): TeX and the package tree therefore ship INSIDE the helper bundle.
 */
export function macHelperResources(helper: string): string { return resolve(helper, '..', '..', 'Resources') }

function fail(message: string): Error { return new Error(`macOS 原生隔离不可用，已拒绝编译：${message}`) }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => { resolvePromise = done; reject = failed })
  promise.catch(() => undefined) // a late rejection must never become an unhandled one
  return { promise, resolve: resolvePromise, reject }
}
/** Packaged resources first, then development checkouts. The caller pins the bytes; a path is not trust. */
export function macHelperCandidates(): string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [resources ? join(resources, ...MAC_HELPER_RELATIVE.split('/')) : '',
    resolve(__dirname, '../../resources', ...MAC_HELPER_RELATIVE.split('/')),
    resolve(process.cwd(), 'resources', ...MAC_HELPER_RELATIVE.split('/'))].filter(Boolean)
}
export async function findMacHelper(candidates: string[] = macHelperCandidates()): Promise<string> {
  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate)
      if (info.isFile() && !info.isSymbolicLink()) return candidate
    } catch { /* try the next candidate */ }
  }
  throw fail('编译助手未随软件打包')
}
function engineTool(executable: string): MacTool {
  const name = basename(executable)
  if (name === 'pdftex' || name === 'pdflatex') return 'pdflatex'
  if (name === 'xetex' || name === 'xelatex') return 'xelatex'
  if (name === 'bibtex') return 'bibtex'
  throw fail('未绑定的受控工具')
}
function spawnDetached(command: string, args: string[]): MacHelperProcess {
  // A rebuilt minimal environment: no tokens, HOME, DYLD_* or user TeX configuration reach the helper.
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true,
    env: { PATH: '/usr/bin:/bin' }, windowsHide: true })
}

class MacSession implements MacSandboxSession {
  readonly runsBibtex = true as const
  remoteRoot = ''
  private readonly reader = new MacFrameReader()
  private readonly frames: MacFrame[] = []
  private waiter: ReturnType<typeof deferred<MacFrame>> | null = null
  private readonly ended = deferred<void>()
  private terminal: Error | null = null
  private finished = false
  private stopping = false
  private closedClean = false
  private running = false
  private output = 0
  private hardKill: NodeJS.Timeout | undefined
  private drain: NodeJS.Timeout | undefined
  private readonly watchdog: NodeJS.Timeout
  private abandoned = false
  private exitCode: number | null | undefined
  private readonly onAbort = (): void => { this.stop() }

  constructor(private readonly child: MacHelperProcess, private readonly source: string, private readonly engine: MacTool,
    private readonly converter: boolean, private readonly signal: AbortSignal | undefined,
    private readonly killGroup: (pgid: number) => void, timeoutMs: number) {
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.stdout.once('end', () => { if (this.exitCode !== undefined) this.finish(this.exitCode) })
    child.stderr.on('data', () => undefined) // helper diagnostics may contain local paths; never logged
    child.stdin.on('error', () => this.abandon(fail('无法写入编译助手')))
    child.once('error', () => this.exited(null))
    child.once('exit', code => this.exited(code))
    this.watchdog = setTimeout(() => this.abandon(fail('编译助手没有在限时内应答')), timeoutMs + WATCHDOG_MARGIN_MS)
    this.watchdog.unref()
    signal?.addEventListener('abort', this.onAbort, { once: true })
  }

  /** 'exit' may arrive before the last stdout bytes (the CLOSED frame): settle on end-of-output, with a bound. */
  private exited(code: number | null): void {
    if (this.exitCode !== undefined || this.finished) return
    this.exitCode = code
    if (this.child.stdout.readableEnded || this.abandoned) { this.finish(code); return }
    this.drain = setTimeout(() => this.finish(code), DRAIN_AFTER_EXIT_MS)
    this.drain.unref()
  }

  private receive(chunk: Buffer): void {
    if (this.finished || this.abandoned) return // once trust is withdrawn nothing the helper says restores it
    let decoded: MacFrame[]
    try { decoded = this.reader.push(chunk) } catch { this.abandon(fail('编译助手的应答无法识别')); return }
    for (const frame of decoded) {
      if (frame.type === 'closed') { this.closedClean = frame.clean; continue }
      if (frame.type === 'err') { this.abandon(fail(`编译助手拒绝了请求（${frame.code}）`)); return }
      if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve(frame) }
      else if (this.frames.push(frame) > MAX_QUEUED_FRAMES) { this.abandon(fail('编译助手的应答无法识别')); return }
    }
  }
  /**
   * Stops trusting the helper. Its stdin is closed first, which a live helper answers by killing its tool and removing
   * its work folder; after a short grace the helper's own process group (it was started as a group leader by this
   * app) is killed. No process id reported by the helper is ever used as a kill target.
   */
  private abandon(error: Error): void {
    if (this.finished || this.abandoned) return
    this.abandoned = true
    this.terminal ??= error
    this.closedClean = false
    this.child.stdin.destroy()
    const hard = setTimeout(() => {
      if (this.finished) return
      if (this.child.pid !== undefined) this.killGroup(this.child.pid)
      this.child.kill('SIGKILL')
    }, ABANDON_GRACE_MS)
    hard.unref()
    this.waiter?.reject(this.terminal); this.waiter = null
  }
  private finish(code: number | null): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.watchdog)
    if (this.hardKill) clearTimeout(this.hardKill)
    if (this.drain) clearTimeout(this.drain)
    this.signal?.removeEventListener('abort', this.onAbort)
    if (code !== 0 || !this.reader.idle) this.closedClean = false
    if (!this.closedClean) this.terminal ??= fail('助手退出但未确认完整清理；存在残留风险')
    this.waiter?.reject(this.terminal ?? fail('会话已结束')); this.waiter = null
    this.child.stdin.destroy()
    this.ended.resolve()
  }
  private next(): Promise<MacFrame> {
    const queued = this.frames.shift()
    if (queued) return Promise.resolve(queued)
    if (this.finished || this.terminal) return Promise.reject(this.terminal ?? fail('会话已结束'))
    this.waiter = deferred<MacFrame>()
    return this.waiter.promise
  }
  private async expect<T extends MacFrame['type']>(...types: T[]): Promise<Extract<MacFrame, { type: T }>> {
    const frame = await this.next()
    if (!(types as string[]).includes(frame.type)) {
      const error = fail('编译助手的应答顺序不符合协议')
      this.abandon(error)
      throw error
    }
    return frame as Extract<MacFrame, { type: T }>
  }
  private send(bytes: Buffer): Promise<void> {
    if (this.finished || this.terminal) return Promise.reject(this.terminal ?? fail('会话已结束'))
    return new Promise((done, failed) => this.child.stdin.write(bytes, error => error ? failed(fail('无法写入编译助手')) : done()))
  }
  /** Asks the helper to kill any running tool, remove its work directory and confirm; then waits with a hard limit. */
  private stop(): void {
    if (this.stopping || this.finished) return
    this.stopping = true
    this.child.stdin.write(ENCODED_CLOSE, () => undefined)
    this.hardKill = setTimeout(() => this.abandon(fail('编译助手没有在限时内确认清理')), CLOSE_GRACE_MS)
    this.hardKill.unref()
  }

  async start(readyTimeoutMs: number): Promise<void> {
    const timer = setTimeout(() => this.abandon(fail('编译助手启动超时')), readyTimeoutMs)
    try {
      const ready = await this.expect('ready')
      if (ready.protocol !== MAC_HELPER_PROTOCOL) throw fail('编译助手的协议版本不符')
      if (!ready.sandboxed) throw fail('编译助手没有在应用沙箱中运行')
      if (!ready.root.startsWith('/') || ready.root.includes('\0')) throw fail('编译助手报告的工作目录无效')
      this.remoteRoot = ready.root
    } finally { clearTimeout(timer) }
    await this.upload(this.source, '')
  }
  /** Mirrors the host snapshot (already size/type checked by copyProject) into the helper's container. */
  private async upload(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      this.signal?.throwIfAborted()
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw fail('快照中不能有符号链接')
      if (entry.isDirectory()) {
        await this.send(encodeMkdir(relative)); await this.expect('ok')
        await this.upload(path, relative)
      } else if (entry.isFile()) {
        await this.send(encodePut(relative, await readFile(path))); await this.expect('ok')
      } else throw fail('快照中有特殊文件')
    }
  }

  async run(args: string[], cwd: string, options: SandboxRunOptions = {}): Promise<SandboxResult> {
    if (this.finished || this.stopping || this.running || !this.remoteRoot) throw this.terminal ?? fail('会话不可运行或已有任务在执行')
    if (resolve(cwd) !== resolve(this.source)) throw fail('未授权的工作目录或参数')
    const tool = options.tool === 'xdvipdfmx' ? 'xdvipdfmx' : options.tool === 'bibtex' ? 'bibtex' : this.engine
    if (options.tool === 'xdvipdfmx' && !this.converter) throw fail('未绑定的受控工具')
    this.running = true
    try {
      await this.send(encodeRun(tool, args))
      await this.expect('started')
      for (;;) {
        const frame = await this.expect('out', 'exit')
        if (frame.type === 'exit') return this.toolExited(frame.code)
        this.output += frame.data.length
        // Per session, like the Windows helper. The native helper kills the tool at the same limit (EXIT 126);
        // this only keeps a misbehaving helper from growing the log.
        if (this.output > MAX_OUTPUT) continue
        ;(frame.stream === 1 ? options.onStdout : options.onStderr)?.(frame.data)
      }
    } catch (error) {
      if (!this.stopping) throw error
      await this.ended.promise
      throw this.closedClean ? new ConfirmedCancellation(CANCELED) : this.terminal ?? fail('会话在运行期间结束')
    } finally { this.running = false }
  }
  private async toolExited(code: number): Promise<SandboxResult> {
    if (!this.stopping) return { code }
    await this.ended.promise
    throw this.closedClean ? new ConfirmedCancellation(CANCELED) : this.terminal ?? fail('会话在运行期间结束')
  }

  async pull(names: readonly string[]): Promise<void> {
    for (const name of names) {
      await this.send(encodeGet(name))
      const frame = await this.expect('file', 'none')
      if (frame.type === 'none') continue
      if (frame.data.length > MAX_PULL) throw fail('编译输出超过大小限制')
      // Never through an existing entry (a link would redirect the write): remove it, then create exclusively.
      const target = join(this.source, OUTPUT_DIR, name)
      await rm(target, { force: true })
      await writeFile(target, frame.data, { flag: 'wx', mode: 0o600 })
    }
  }
  async probe(kind: MacProbeKind, argument: string): Promise<MacProbeResult> {
    await this.send(encodeProbe(kind, argument))
    const frame = await this.expect('probe')
    return { allowed: frame.allowed, errno: frame.errno }
  }

  async cancel(): Promise<void> {
    this.stop()
    await this.ended.promise
    if (!this.closedClean) throw this.terminal ?? fail('取消未确认清理')
  }
  async dispose(): Promise<void> {
    this.stop()
    await this.ended.promise
    if (!this.closedClean) throw this.terminal ?? fail('会话未正常清理')
  }
}

function validated(options: SandboxSessionOptions): { source: string; timeout: number; install: string } {
  const timeout = options.timeoutMs ?? 120_000
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) throw fail('限时无效')
  if (!Array.isArray(options.workDirs) || options.workDirs.length < 1 || options.workDirs.length > 2 ||
    options.workDirs.some(path => typeof path !== 'string' || !isAbsolute(path))) throw fail('需要本机绝对路径')
  if (typeof options.runtimeRoot !== 'string' || !isAbsolute(options.runtimeRoot)) throw fail('需要本机绝对路径')
  return { source: resolve(options.workDirs[0] as string), timeout, install: join(options.runtimeRoot, 'install') }
}

/** The trusted resource manager must verify the TeX tree and the helper bytes before calling. */
export async function createMacSandboxSession(options: SandboxSessionOptions,
  deps: MacSessionDependencies = {}): Promise<MacSandboxSession> {
  // Everything up to the spawn leaves nothing behind, so a refusal here must not disable compiling until restart.
  let source: string, timeout: number, install: string, engine: MacTool, helper: string
  try {
    if ((deps.platform ?? process.platform) !== 'darwin') throw fail('此实现仅支持 macOS')
    ;({ source, timeout, install } = validated(options))
    engine = engineTool(options.executable)
    helper = deps.helper ?? await findMacHelper()
  } catch (error) { throw new SessionNotStarted(error instanceof Error ? error.message : String(error)) }
  if (options.signal?.aborted) throw new ConfirmedCancellation(CANCELED)
  const args = ['--tex-root', install, ...(deps.overlayRoot ? ['--overlay-root', deps.overlayRoot] : []), '--timeout-ms', String(timeout)]
  const child = (deps.spawnHelper ?? spawnDetached)(helper, args)
  const kill = deps.killGroup ?? ((pgid: number) => { try { process.kill(-pgid, 'SIGKILL') } catch { /* already gone */ } })
  // Never this app's own process or group, never the special targets 0 and 1.
  const killGroup = (pgid: number): void => { if (Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid) kill(pgid) }
  const session = new MacSession(child, source, engine, Boolean(options.tools?.xdvipdfmx), options.signal, killGroup, timeout)
  try {
    await session.start(READY_TIMEOUT_MS)
    return session
  } catch (error) {
    // Never leave a half-started helper: ask it to clean up, and report cancellation only when cleanup is confirmed.
    try { await session.dispose() } catch (cleanup) { throw options.signal?.aborted ? cleanup : error }
    if (options.signal?.aborted) throw new ConfirmedCancellation(CANCELED)
    throw error
  }
}
