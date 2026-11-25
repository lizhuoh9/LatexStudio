import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMacSandboxSession, type MacHelperProcess } from '../src/main/sandbox/macos-session'
import { isConfirmedCancellation, isSessionNotStarted } from '../src/main/sandbox/session'

// A scripted stand-in for the native helper. It proves the app's session logic (ordering, fail-closed decisions,
// cleanup confirmation), NOT the helper, the App Sandbox or anything else macOS does. Real-Mac acceptance is separate.
interface Script {
  sandboxed?: boolean
  protocol?: number
  run?: (tool: string, args: string[]) => { out?: string; code: number } | 'hang' | 'die' | 'err' | 'flood'
  outputs?: Record<string, Buffer>
  probes?: Record<string, boolean>
  closeClean?: boolean
  /** Report the process exit before the final CLOSED bytes are delivered, as a real child process may. */
  exitBeforeLastBytes?: boolean
  /** Ignore a closed stdin (a hung helper), so only the hard kill ends it. */
  ignoreStdinClose?: boolean
}
class FakeHelper implements MacHelperProcess {
  readonly pid = 4242
  readonly stdin = new PassThrough(); readonly stdout = new PassThrough(); readonly stderr = new PassThrough()
  readonly files = new Map<string, string>(); readonly directories: string[] = []
  readonly runs: Array<{ tool: string; args: string[] }> = []
  readonly requests: string[] = []
  killed = false
  private buffered = Buffer.alloc(0)
  private hanging = false
  private ended = false
  private exit: ((code: number | null) => void) | undefined

  constructor(private readonly script: Script = {}) {
    this.stdin.on('data', (chunk: Buffer) => { this.buffered = Buffer.concat([this.buffered, chunk]); this.drain() })
    this.stdin.on('close', () => { if (!script.ignoreStdinClose) this.finish(3) }) // the lifeline: the app let go
    queueMicrotask(() => this.reply(`READY ${script.protocol ?? 1} ${script.sandboxed === false ? 0 : 1} 13\n/sandbox/root`))
  }
  once(event: 'exit' | 'error', listener: never): this {
    if (event === 'exit') this.exit = listener as (code: number | null) => void
    return this
  }
  kill(): boolean { this.killed = true; this.finish(null); return true }
  private finish(code: number | null, last?: string): void {
    if (this.ended) return
    this.ended = true
    if (this.script.exitBeforeLastBytes) {
      this.exit?.(code)
      setImmediate(() => { if (last) this.stdout.write(last); this.stdout.end() })
      return
    }
    if (last) this.stdout.write(last)
    this.stdout.end()
    setImmediate(() => this.exit?.(code))
  }
  private reply(text: string | Buffer): void { if (!this.ended) this.stdout.write(text) }
  private drain(): void {
    for (;;) {
      const end = this.buffered.indexOf(0x0a)
      if (end < 0) return
      const [name, a, b] = this.buffered.subarray(0, end).toString().split(' ')
      const size = name === 'PUT' ? Number(a) + Number(b) : name === 'RUN' || name === 'PROBE' ? Number(b) : name === 'CANCEL' || name === 'CLOSE' ? 0 : Number(a)
      if (this.buffered.length < end + 1 + size) return
      const payload = this.buffered.subarray(end + 1, end + 1 + size)
      this.buffered = this.buffered.subarray(end + 1 + size)
      this.requests.push(name!)
      this.handle(name!, a ?? '', payload)
    }
  }
  private handle(name: string, a: string, payload: Buffer): void {
    if (name === 'MKDIR') { this.directories.push(payload.toString()); this.reply('OK\n') }
    else if (name === 'PUT') { const n = Number(a); this.files.set(payload.subarray(0, n).toString(), payload.subarray(n).toString()); this.reply('OK\n') }
    else if (name === 'GET') { const data = this.script.outputs?.[payload.toString()]; this.reply(data ? Buffer.concat([Buffer.from(`FILE ${data.length}\n`), data]) : 'NONE\n') }
    else if (name === 'PROBE') this.reply(this.script.probes?.[a] ? 'PROBE allowed 0\n' : 'PROBE denied 1\n')
    else if (name === 'RUN') this.run(a, payload.toString().split('\0').slice(0, -1))
    else if (name === 'CLOSE') {
      if (this.hanging) this.reply('EXIT 125\n')
      const clean = this.script.closeClean !== false
      this.finish(clean ? 0 : 6, `CLOSED ${clean ? 1 : 0}\n`)
    }
  }
  private run(tool: string, args: string[]): void {
    this.runs.push({ tool, args })
    const result = this.script.run?.(tool, args) ?? { code: 0 }
    if (result === 'err') { this.reply('STARTED 777\n'); this.reply('ERR bad-tool\n'); return }
    this.reply('STARTED 777\n')
    if (result === 'hang') { this.hanging = true; return }
    if (result === 'die') { this.finish(3); return }
    if (result === 'flood') { for (let i = 0; i < 3000; i++) this.reply('OUT 1 1\nx'); return }
    if (result.out) this.reply(`OUT 1 ${Buffer.byteLength(result.out)}\n${result.out}`)
    this.reply(`EXIT ${result.code}\n`)
  }
}

const roots: string[] = []
const RUNTIME = process.platform === 'win32' ? 'C:\\app\\tex-darwin' : '/app/tex-darwin'
async function snapshot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-macsession-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(join(source, 'figures'), { recursive: true }); await mkdir(join(source, '.paperstudio-output'))
  await writeFile(join(source, 'main.tex'), 'MAIN'); await writeFile(join(source, 'figures', 'a.txt'), 'FIG')
  return source
}
async function open(script: Script = {}, extra: { signal?: AbortSignal; xdvipdfmx?: boolean } = {}) {
  const source = await snapshot(), helper = new FakeHelper(script), killGroup = vi.fn()
  const spawnHelper = vi.fn(() => helper)
  const session = createMacSandboxSession({ executable: '/app/tex-darwin/install/bin/universal-darwin/pdftex',
    runtimeRoot: RUNTIME, workDirs: [source], timeoutMs: 120_000,
    ...(extra.xdvipdfmx ? { tools: { xdvipdfmx: '/x' } } : {}), ...(extra.signal ? { signal: extra.signal } : {}) },
  { platform: 'darwin', helper: '/app/helper', overlayRoot: '/app/tex-packages/texmf-paperstudio', spawnHelper, killGroup })
  return { source, helper, killGroup, spawnHelper, session }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('Mac sandbox session (scripted helper; app-side logic only)', () => {
  it('starts the helper with the pinned roots, uploads the snapshot and reports the remote root', async () => {
    const t = await open()
    const session = await t.session
    expect(t.spawnHelper.mock.calls[0]).toEqual(['/app/helper', ['--tex-root', join(RUNTIME, 'install'),
      '--overlay-root', '/app/tex-packages/texmf-paperstudio', '--timeout-ms', '120000']])
    expect(t.helper.directories.sort()).toEqual(['.paperstudio-output', 'figures'])
    expect([...t.helper.files]).toEqual([['figures/a.txt', 'FIG'], ['main.tex', 'MAIN']])
    expect(session.remoteRoot).toBe('/sandbox/root'); expect(session.runsBibtex).toBe(true)
    await session.dispose()
  })

  it('runs the engine, BibTeX and the bound converter in one session and forwards output', async () => {
    const t = await open({ run: tool => ({ out: `${tool}!`, code: tool === 'bibtex' ? 1 : 0 }) }, { xdvipdfmx: true })
    const session = await t.session, seen: string[] = []
    const onStdout = (bytes: Buffer): void => { seen.push(bytes.toString()) }
    expect(await session.run(['-fmt=pdflatex', './main.tex'], t.source, { onStdout })).toEqual({ code: 0 })
    expect(await session.run(['-terse', 'x'], t.source, { tool: 'bibtex', onStdout })).toEqual({ code: 1 })
    expect(await session.run(['-o', 'x.pdf'], t.source, { tool: 'xdvipdfmx', onStdout })).toEqual({ code: 0 })
    expect(t.helper.runs).toEqual([{ tool: 'pdflatex', args: ['-fmt=pdflatex', './main.tex'] }, { tool: 'bibtex', args: ['-terse', 'x'] },
      { tool: 'xdvipdfmx', args: ['-o', 'x.pdf'] }])
    expect(seen).toEqual(['pdflatex!', 'bibtex!', 'xdvipdfmx!'])
    await session.dispose()
  })

  it('copies named outputs back to the host snapshot, replacing what is there, and skips missing ones', async () => {
    const t = await open({ outputs: { 'paperstudio.pdf': Buffer.from('%PDF-x') } })
    const session = await t.session
    await writeFile(join(t.source, '.paperstudio-output', 'paperstudio.pdf'), 'stale')
    await session.pull(['paperstudio.pdf', 'paperstudio.synctex.gz'])
    expect(await readFile(join(t.source, '.paperstudio-output', 'paperstudio.pdf'), 'utf8')).toBe('%PDF-x')
    await expect(readFile(join(t.source, '.paperstudio-output', 'paperstudio.synctex.gz'))).rejects.toThrow()
    await expect(session.pull(['../escape'])).rejects.toThrow()
    await session.dispose()
  })

  it('relays probe verdicts for the self-test', async () => {
    const session = await (await open({ probes: { read: true } })).session
    expect(await session.probe('read', '/sandbox/root/a')).toEqual({ allowed: true, errno: 0 })
    expect(await session.probe('connect', '4000')).toEqual({ allowed: false, errno: 1 })
    await session.dispose()
  })

  it('refuses a helper that is not sandboxed, and one that speaks another protocol, after asking it to clean up', async () => {
    const plain = await open({ sandboxed: false })
    await expect(plain.session).rejects.toThrow('没有在应用沙箱中运行')
    expect(plain.helper.requests).toEqual(['CLOSE']); expect(plain.helper.files.size).toBe(0)
    const other = await open({ protocol: 2 })
    await expect(other.session).rejects.toThrow('协议版本不符')
  })

  it('refuses another work directory and an unbound converter without asking the helper', async () => {
    const t = await open(), session = await t.session
    await expect(session.run([], join(t.source, '..'), {})).rejects.toThrow('未授权的工作目录')
    await expect(session.run([], t.source, { tool: 'xdvipdfmx' })).rejects.toThrow('未绑定的受控工具')
    expect(t.helper.runs).toHaveLength(0)
    await session.dispose()
  })

  it('reports a refusal made before anything was started as such, and starts nothing', async () => {
    const source = await snapshot(), spawnHelper = vi.fn()
    const off = await createMacSandboxSession({ executable: '/x/pdftex', runtimeRoot: RUNTIME, workDirs: [source] },
      { platform: 'win32', spawnHelper }).catch((reason: unknown) => reason)
    expect(isSessionNotStarted(off)).toBe(true); expect((off as Error).message).toContain('此实现仅支持 macOS')
    const tool = await createMacSandboxSession({ executable: '/x/latexmk', runtimeRoot: RUNTIME, workDirs: [source] },
      { platform: 'darwin', helper: '/h', spawnHelper }).catch((reason: unknown) => reason)
    expect(isSessionNotStarted(tool)).toBe(true)
    const aborted = await createMacSandboxSession({ executable: '/x/pdftex', runtimeRoot: RUNTIME, workDirs: [source], signal: AbortSignal.abort('canceled') },
      { platform: 'darwin', helper: '/h', spawnHelper }).catch((reason: unknown) => reason)
    expect(isConfirmedCancellation(aborted)).toBe(true)
    expect(spawnHelper).not.toHaveBeenCalled()
  })

  it('turns an abort during a run into a confirmed cancellation when the helper confirms cleanup', async () => {
    const abort = new AbortController(), t = await open({ run: () => 'hang' }, { signal: abort.signal })
    const session = await t.session
    const running = session.run([], t.source, {})
    await vi.waitFor(() => expect(t.helper.runs).toHaveLength(1))
    abort.abort('canceled')
    const error = await running.catch((reason: unknown) => reason)
    expect(isConfirmedCancellation(error)).toBe(true)
    await expect(session.cancel()).resolves.toBeUndefined()
    expect(t.killGroup).not.toHaveBeenCalled(); expect(t.helper.killed).toBe(false)
  })

  it('still confirms cleanup when the exit is reported before the last bytes arrive', async () => {
    const session = await (await open({ exitBeforeLastBytes: true })).session
    await expect(session.dispose()).resolves.toBeUndefined()
  })

  it('does not report a cancellation as confirmed when cleanup is not confirmed', async () => {
    const abort = new AbortController(), t = await open({ run: () => 'hang', closeClean: false }, { signal: abort.signal })
    const session = await t.session
    const running = session.run([], t.source, {})
    await vi.waitFor(() => expect(t.helper.runs).toHaveLength(1))
    abort.abort('canceled')
    const error = await running.catch((reason: unknown) => reason)
    expect(isConfirmedCancellation(error)).toBe(false)
    await expect(session.cancel()).rejects.toThrow('残留风险')
  })

  it('treats a helper that dies mid-run as unconfirmed cleanup', async () => {
    const t = await open({ run: () => 'die' }), session = await t.session
    await expect(session.run([], t.source, {})).rejects.toThrow('残留风险')
    await expect(session.dispose()).rejects.toThrow('残留风险')
  })

  it('lets go of a helper that refuses a request: closes its stdin and never kills by a reported process id', async () => {
    const t = await open({ run: () => 'err' }), session = await t.session
    await expect(session.run([], t.source, {})).rejects.toThrow('编译助手拒绝了请求（bad-tool）')
    await expect(session.dispose()).rejects.toThrow()
    expect(t.helper.killed).toBe(false) // the helper ended by itself when its stdin closed
    expect(t.killGroup).not.toHaveBeenCalledWith(777)
  })

  it('kills only the process group it started itself when a helper ignores the closed stdin', async () => {
    const t = await open({ run: () => 'err', ignoreStdinClose: true }), session = await t.session
    await expect(session.run([], t.source, {})).rejects.toThrow('bad-tool')
    await vi.waitFor(() => expect(t.helper.killed).toBe(true), { timeout: 4000 })
    expect(t.killGroup.mock.calls).toEqual([[4242]])
    await expect(session.dispose()).rejects.toThrow()
  }, 10_000)

  it('abandons a helper that floods replies nobody is waiting for', async () => {
    const t = await open({ run: () => 'flood' }), session = await t.session
    const running = session.run([], t.source, {}).catch((reason: unknown) => reason)
    await vi.waitFor(async () => expect(await Promise.race([running, Promise.resolve('pending')])).not.toBe('pending'), { timeout: 4000 })
    await expect(session.dispose()).rejects.toThrow()
  }, 10_000)

  it('reports an unconfirmed close as a failed dispose', async () => {
    const session = await (await open({ closeClean: false })).session
    await expect(session.dispose()).rejects.toThrow('残留风险')
  })
})
