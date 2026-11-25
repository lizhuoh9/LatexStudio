import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { loadPdf } from '../local/build'
import type { SandboxSessionOptions } from './session'
import type { MacSandboxSession } from './macos-session'

/**
 * Per-machine acceptance of the macOS isolation backend. It runs once per app run, before compilation is offered:
 * one real compile inside the sandbox plus controls that MUST be refused. Nothing is assumed from the system version;
 * any unexpected result keeps compilation disabled. The sentinel lives in the app's own data folder, which is inside
 * the user's home, so one refusal covers both "files in the home folder" and "the app's credentials folder".
 *
 * pdfLaTeX and the controls are required. XeLaTeX (with its converter) is tried afterwards and only decides whether
 * that engine is offered: it depends on system font services, the part most likely to differ between systems.
 */
export type MacSelfTestSession = (options: SandboxSessionOptions) => Promise<MacSandboxSession>
export interface MacSelfTestListener {
  port: number
  connections(): number
  close(): Promise<void>
  /** Whether the app itself can connect; defaults to a real connection attempt. */
  reachable?: () => Promise<boolean>
}
export interface MacSelfTestDependencies {
  createSession: MacSelfTestSession
  listen?: () => Promise<MacSelfTestListener>
}
export interface MacSelfTestResult { xelatex: boolean }
export const MAC_SELFTEST_TIMEOUT_MS = 60_000
const COUNT_WAIT_MS = 3000
const DOCUMENT = '\\documentclass{article}\n\\begin{document}\nLatexStudio isolation self-test.\n\\end{document}\n'
const OUTPUT_DIR = '.paperstudio-output'
function engineArgs(engine: 'pdflatex' | 'xelatex'): string[] {
  return ['-no-shell-escape', '-no-parse-first-line', `-progname=${engine}`, `-fmt=${engine}`, '-interaction=nonstopmode',
    '-halt-on-error', '-file-line-error', '-jobname=paperstudio', `-output-directory=./${OUTPUT_DIR}`,
    ...(engine === 'xelatex' ? ['-no-pdf'] : []), './selftest.tex']
}
const CONVERT = ['-D', '', '-o', `./${OUTPUT_DIR}/paperstudio.pdf`, `./${OUTPUT_DIR}/paperstudio.xdv`]

function refused(message: string): Error { return new Error(`macOS 原生隔离不可用，已拒绝编译：${message}`) }

async function loopbackListener(): Promise<MacSelfTestListener> {
  let seen = 0
  const server: Server = createServer(socket => { seen++; socket.destroy() })
  await new Promise<void>((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', () => done()) })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw refused('自检无法建立本机监听端口') }
  // The app's own control connection must be COUNTED before the sandbox is probed: the client side connects before
  // the listener's callback runs, and a count that arrives late would look like a connection from the sandbox.
  const counted = async (): Promise<boolean> => {
    const before = seen
    if (!await reachable(address.port)) return false
    for (let waited = 0; seen === before && waited < COUNT_WAIT_MS; waited += 20) await new Promise(done => setTimeout(done, 20))
    return seen > before
  }
  return { port: address.port, connections: () => seen, reachable: counted,
    close: () => new Promise<void>(done => server.close(() => done())) }
}
/** The app itself must reach the listener, or a refused connection from the sandbox would prove nothing. */
function reachable(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port })
    const settle = (value: boolean): void => { socket.destroy(); done(value) }
    socket.setTimeout(3000, () => settle(false))
    socket.once('connect', () => settle(true)); socket.once('error', () => settle(false))
  })
}
/** Only "not permitted" (EPERM) and "permission denied" (EACCES) are the sandbox saying no. */
function sandboxRefused(result: { allowed: boolean; errno: number }): boolean {
  return !result.allowed && (result.errno === 1 || result.errno === 13)
}
function reachableListener(listener: MacSelfTestListener): Promise<boolean> {
  return listener.reachable ? listener.reachable() : reachable(listener.port)
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch { return false }
}
/** Scratch folders of a run that crashed; each holds only a tiny document and a random sentinel. */
async function sweep(base: string): Promise<void> {
  for (const entry of await readdir(base, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory() && entry.name.startsWith('paperstudio-'))
      await rm(join(base, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
}

async function controls(session: MacSandboxSession, scratch: string, listener: MacSelfTestListener): Promise<void> {
  const inside = `${session.remoteRoot}/selftest.tex`
  const outside = join(scratch, 'outside.txt'), written = join(scratch, 'written.txt')
  // Positive controls first: a refusal below only counts when the same kind of probe can succeed where it should.
  if (!(await session.probe('read', inside)).allowed || !(await session.probe('exec-read', inside)).allowed ||
    !(await session.probe('write', `${session.remoteRoot}/control-write.txt`)).allowed)
    throw refused('自检的对照读取失败，无法判断隔离是否生效')
  if (!await reachableListener(listener)) throw refused('自检无法建立本机监听端口')
  const baseline = listener.connections()
  // A refusal must be the sandbox's own (EPERM/EACCES). A missing file, a full table or a timeout proves nothing.
  if (!sandboxRefused(await session.probe('read', outside))) throw refused('沙箱内仍能读取用户数据目录')
  if (!sandboxRefused(await session.probe('exec-read', outside))) throw refused('沙箱内启动的程序仍能读取用户数据目录')
  if (!sandboxRefused(await session.probe('write', written)) || await exists(written)) throw refused('沙箱内仍能向工作目录之外写入')
  if (!sandboxRefused(await session.probe('connect', String(listener.port))) || listener.connections() !== baseline) throw refused('沙箱内仍能联网')
}

/** Required part: a real pdfLaTeX PDF from inside the sandbox, every control refused, cleanup confirmed. */
async function required(runtimeRoot: string, scratch: string, source: string, deps: MacSelfTestDependencies,
  listener: MacSelfTestListener): Promise<void> {
  const session = await deps.createSession({ executable: join(runtimeRoot, 'install', 'bin', 'universal-darwin', 'pdftex'),
    runtimeRoot, workDirs: [source], timeoutMs: MAC_SELFTEST_TIMEOUT_MS })
  let disposed = false
  try {
    if ((await session.run(engineArgs('pdflatex'), source, {})).code !== 0) throw refused('自检文档在沙箱内编译失败')
    await session.pull(['paperstudio.pdf'])
    try { await loadPdf(join(source, OUTPUT_DIR)) } catch { throw refused('自检没有得到完整的 PDF') }
    await controls(session, scratch, listener)
    disposed = true
    await session.dispose() // unconfirmed cleanup is itself a failed self-test
  } finally { if (!disposed) await session.dispose().catch(() => undefined) }
}

/** Optional part: false when XeLaTeX or its converter does not work here. Unconfirmed cleanup still fails the test. */
async function xelatexWorks(runtimeRoot: string, source: string, deps: MacSelfTestDependencies): Promise<boolean> {
  const tools = join(runtimeRoot, 'install', 'bin', 'universal-darwin')
  await rm(join(source, OUTPUT_DIR, 'paperstudio.pdf'), { force: true })
  let session: MacSandboxSession
  try {
    session = await deps.createSession({ executable: join(tools, 'xetex'), runtimeRoot, tools: { xdvipdfmx: join(tools, 'xdvipdfmx') },
      workDirs: [source], timeoutMs: MAC_SELFTEST_TIMEOUT_MS })
  } catch { return false }
  let works = false
  try {
    works = (await session.run(engineArgs('xelatex'), source, {})).code === 0 &&
      (await session.run(CONVERT, source, { tool: 'xdvipdfmx' })).code === 0
    if (works) { await session.pull(['paperstudio.pdf']); await loadPdf(join(source, OUTPUT_DIR)) }
  } catch { works = false }
  await session.dispose()
  return works
}

/** Resolves only when the sandbox compiled a real PDF and refused every control. Otherwise throws the reason. */
export async function runMacSelfTest(runtimeRoot: string, dataRoot: string, deps: MacSelfTestDependencies): Promise<MacSelfTestResult> {
  const base = join(dataRoot, 'tex', 'selftest')
  await mkdir(base, { recursive: true, mode: 0o700 })
  await sweep(base)
  // Canonical, so the PDF containment check and the sentinel path hold when the data folder is reached through a link.
  const scratch = await realpath(await mkdtemp(join(base, 'paperstudio-')))
  const source = join(scratch, 'source')
  const listener = await (deps.listen ?? loopbackListener)()
  try {
    await mkdir(join(source, OUTPUT_DIR), { recursive: true, mode: 0o700 })
    await writeFile(join(source, 'selftest.tex'), DOCUMENT, { flag: 'wx', mode: 0o600 })
    await writeFile(join(scratch, 'outside.txt'), randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 })
    await required(runtimeRoot, scratch, source, deps, listener)
    return { xelatex: await xelatexWorks(runtimeRoot, source, deps) }
  } finally {
    await listener.close()
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
  }
}
