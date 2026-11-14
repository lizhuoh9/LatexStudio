import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const MAX_LOG = 1024 * 1024
export interface ToolRequest {
  executable: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  onLog?: (message: string) => void
}
export interface ToolResult { code: number | null; log: string; canceled: boolean; timedOut: boolean }

export function redact(message: string): string {
  return message.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/\b(password|passwd|token|api[_-]?key)(\s*[=:]\s*)[^\s"'<>]+/gi, '$1$2[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

export class BoundedLog {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private text = ''
  private bytes = 0
  private truncated = false
  constructor(private readonly listener?: (message: string) => void) {}
  push(chunk: Buffer): void {
    if (this.truncated) return
    this.pending += this.decoder.write(chunk)
    while (this.pending.includes('\n')) {
      const length = this.pending.indexOf('\n') + 1
      this.append(this.pending.slice(0, length))
      this.pending = this.pending.slice(length)
      if (this.truncated) { this.pending = ''; break }
    }
    if (this.pending.length > MAX_LOG) {
      this.append(this.pending.slice(0, MAX_LOG))
      this.pending = ''
      if (!this.truncated) this.text += '\n[编译日志单行达到上限，后续内容省略]\n'
      this.truncated = true
    }
  }
  finish(): string {
    this.pending += this.decoder.end()
    if (this.pending) this.append(this.pending)
    this.pending = ''
    return this.text
  }
  private append(value: string): void {
    if (this.truncated) return
    const clean = redact(value)
    const size = Buffer.byteLength(clean)
    if (this.bytes + size > MAX_LOG) {
      this.truncated = true
      this.text += '\n[编译日志已达到 1 MiB 上限，后续内容省略]\n'
      this.notify('\n[编译日志已截断]\n')
      return
    }
    this.text += clean
    this.bytes += size
    this.notify(clean)
  }
  private notify(message: string): void {
    try { this.listener?.(message) }
    catch { process.emitWarning('编译日志监听器失败') }
  }
}

export async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    return
  }
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' })
    killer.once('error', reject)
    killer.once('close', (exit) => {
      if (exit === 0 || child.exitCode !== null) resolve()
      else reject(new Error('无法终止完整编译进程树'))
    })
  })
}

export function runTool(request: ToolRequest): Promise<ToolResult> {
  if (request.signal?.aborted) return Promise.resolve({ code: null, log: '编译已取消', canceled: true, timedOut: false })
  return new Promise((resolve) => {
    const log = new BoundedLog(request.onLog)
    const child = spawn(request.executable, request.args, { cwd: request.cwd, env: request.env,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    let spawnFailed = false
    let canceled = false
    let killing: Promise<void> = Promise.resolve()
    const stop = (): void => { killing = killProcessTree(child).catch(() => {
      log.push(Buffer.from('\n无法终止完整编译进程树，请检查系统权限\n')); child.kill('SIGKILL')
    }) }
    const abort = (): void => { canceled = true; stop() }
    const timer = setTimeout(() => { timedOut = true; stop() }, request.timeoutMs ?? 120_000)
    child.stdout?.on('data', (bytes: Buffer) => log.push(bytes))
    child.stderr?.on('data', (bytes: Buffer) => log.push(bytes))
    request.signal?.addEventListener('abort', abort, { once: true })
    child.once('error', () => { spawnFailed = true; log.push(Buffer.from('\n无法启动本地 TeX 程序，请检查安装与权限\n')) })
    child.once('close', (exit) => {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
      void killing.then(() => resolve({ code: spawnFailed ? null : exit, log: log.finish(), canceled, timedOut }))
    })
    if (request.signal?.aborted) abort()
  })
}
