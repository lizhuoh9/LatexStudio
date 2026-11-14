import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createWindowsSandboxSession, prepareWindowsSandbox, windowsTexReadRoots, type WindowsSandboxSession } from '../src/main/sandbox/windows'

const execute = promisify(execFile)
const resources = resolve('resources/win32')
const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_SANDBOX_SMOKE === '1'
const folders: string[] = []
const sessions: WindowsSandboxSession[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.cancel().catch(() => undefined)
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.stdin?.write(`${JSON.stringify({ type: 'cancel' })}\n`)
    await new Promise<void>((done) => child.once('close', () => done()))
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'paperstudio-sandbox-'))
  folders.push(folder)
  const source = join(folder, 'source'); const probe = join(folder, 'probe')
  const id = randomUUID(); const runtimeRoot = join(folder, `paperstudio-tex-${id}`)
  for (const path of [source, probe, runtimeRoot, join(runtimeRoot, 'install'), join(runtimeRoot, 'config'), join(runtimeRoot, 'data')]) await mkdir(path)
  for (const work of [source, probe]) await writeFile(join(work, 'allowed.txt'), 'ALLOWED')
  await writeFile(join(folder, 'private.txt'), 'PRIVATE_SENTINEL')
  await writeFile(join(runtimeRoot, 'paperstudio-runtime.json'), JSON.stringify({ schema: 1, id, ready: true, platform: 'win32', distribution: 'texlive' }))
  const executable = join(runtimeRoot, 'install/Probe.exe')
  await execute(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`, join(resources, 'Probe.cs'), join(resources, 'FileSystem.cs')])
  await copyFile(executable, join(source, 'child.exe'))
  return { folder, source, probe, executable, runtimeRoot, workDirs: [source, probe] }
}
async function open(data: Awaited<ReturnType<typeof fixture>>, options: { signal?: AbortSignal; timeoutMs?: number; tools?: { xdvipdfmx?: string } } = {}) {
  const session = await createWindowsSandboxSession({ ...data, ...options })
  sessions.push(session)
  return session
}
async function acl(executable: string, path: string) { return (await execute(executable, ['acl', path])).stdout.trim() }
// The runtime root keeps one persistent read/execute ACE for the named capability (children inherit it, marked ID).
const RUNTIME_CAPABILITY = /\(A;OICI(?:ID)?;[^;()]*;;;S-1-15-3-1024-[0-9-]+\)/g
const RUNTIME_GRANT = /\(A;OICI;[^;()]*;;;S-1-15-3-1024-[0-9-]+\)/g
function withoutRuntimeCapability(sddl: string): string { return sddl.replace(RUNTIME_CAPABILITY, '') }
function expectRuntimeGrant(original: string, after: string): void {
  expect(after.match(RUNTIME_GRANT)).toHaveLength(1)
  expect(after).not.toMatch(/\(A;[^;]*;[^;()]*(?:FA|FW|GA|GW|0x1f01ff|0x1301bf)[^;()]*;;;S-1-15-3-1024-/)
  expect(withoutRuntimeCapability(after)).toBe(original)
}
function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}
async function profiles(): Promise<string[]> {
  const script = '$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings"); if($key){foreach($sid in $key.GetSubKeyNames()){$entry=$key.OpenSubKey($sid);$name=$entry.GetValue("DisplayName");if($name -like "PaperStudio.Compiler.*"){Write-Output $name};$entry.Close()};$key.Close()}'
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', script])
  return stdout.trim().split(/\r?\n/).filter(Boolean).sort()
}
function pidReady() {
  let resolvePid!: (pid: number) => void
  const promise = new Promise<number>((done) => { resolvePid = done })
  let text = ''
  return { promise, receive: (bytes: Buffer) => { text += bytes.toString(); const match = /SLEEP_PID=(\d+)/.exec(text); if (match) resolvePid(Number(match[1])) } }
}
type Frame = { type: string; id?: number; data?: string; stream?: string; cleanup?: boolean; reason?: string; profile?: string; elapsedMs?: number; code?: number }
function raw(data: Awaited<ReturnType<typeof fixture>>, allowChildren = false) {
  const child = spawn(join(resources, allowChildren ? 'PaperStudio.Sandbox.Fixture.exe' : 'PaperStudio.Sandbox.exe'),
    ['--session', '1', '--runtime-root', data.runtimeRoot, ...data.workDirs.flatMap((work) => ['--work-dir', work]),
      ...(allowChildren ? ['--fixture-allow-children', '1'] : []), '--', data.executable], { stdio: 'pipe', windowsHide: true })
  children.push(child)
  child.stderr.on('data', (bytes: Buffer) => console.log('Native fixture diagnostic:', bytes.toString().trim()))
  const frames: Frame[] = []; let pending = ''; let notify = () => undefined
  child.stdout.on('data', (bytes) => { pending += bytes.toString(); let index: number; while ((index = pending.indexOf('\n')) >= 0) { frames.push(JSON.parse(pending.slice(0, index)) as Frame); pending = pending.slice(index + 1) }; notify() })
  const closed = new Promise<number | null>((done) => child.once('close', done))
  async function next(type: string): Promise<Frame> {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} frame`)), 10000)
      notify = () => { const frame = frames.find((frame) => frame.type === type); if (frame) { clearTimeout(timer); done(frame) } }
      notify()
    })
  }
  return { child, closed, next, frames, send: (frame: object) => child.stdin.write(`${JSON.stringify(frame)}\n`) }
}

describe.skipIf(!enabled)('Windows AppContainer compile session — app-owned fixtures only', () => {
  it('supports a deep runtime above MAX_PATH with two runs, strict input rejection and exact cleanup', async () => {
    const data = await fixture(); const baseline = await profiles()
    const deep = join(data.runtimeRoot, 'install', ...Array.from({ length: 7 }, (_, index) => `level-${index}-${'x'.repeat(35)}`))
    await mkdir(deep, { recursive: true })
    const deepFile = join(deep, 'deep.txt'); await writeFile(deepFile, 'DEEP_FIXTURE')
    const readable = join(data.runtimeRoot, 'install/resource.txt'); await writeFile(readable, 'DEEP_FIXTURE')
    expect(deepFile.length).toBeGreaterThan(300)
    const roots = [data.runtimeRoot, data.source, data.probe, deep]
    const original = await Promise.all(roots.map((path) => acl(data.executable, path)))
    const junction = join(data.folder, 'runtime-link'); await symlink(data.runtimeRoot, junction, 'junction')
    const slash = String.fromCharCode(92)
    const device = slash.repeat(2) + '?' + slash + data.runtimeRoot
    const network = slash.repeat(2) + ['localhost', 'C$', 'paperstudio'].join(slash)
    for (const runtimeRoot of [device, network, `${data.runtimeRoot}:stream`, junction])
      await expect(open({ ...data, runtimeRoot })).rejects.toThrow(/绝对路径|链接|联接/)
    const started = Date.now(); const session = await open(data)
    const server = createServer(); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port')
    try {
      let first = ''; let stderr = ''
      const one = await session.run(['deep', readable, join(data.source, 'child.exe')], data.source,
        { onStdout: (bytes) => { first += bytes.toString() }, onStderr: (bytes) => { stderr += bytes.toString() } })
      expect(one.code).toBe(7); expect(first).toContain('ALLOW_RUNTIME_READ=1'); expect(first).toContain('DENY_RUNTIME_WRITE=1')
      expect(first).toContain('DENY_CHILD_CODE=1816'); expect(first).toContain('DENY_SHELL=1'); expect(stderr).toContain('ECHO_STDERR')
      let second = ''
      const two = await session.run(['boundary', join(data.folder, 'private.txt'), join(data.folder, 'escape.txt'), String(address.port)], data.probe,
        { onStdout: (bytes) => { second += bytes.toString() } })
      expect(two.code).toBe(23); expect(second.match(/DENY_READ=1/g)).toHaveLength(2)
      expect(second).toContain('ALLOW_SNAPSHOT=1'); expect(second).toContain('DENY_WRITE=1'); expect(second).toContain('DENY_NETWORK=1')
      expect(second).not.toContain('PRIVATE_SENTINEL')
    } finally { await new Promise<void>((done) => server.close(() => done())); await session.dispose() }
    expect(await readFile(deepFile, 'utf8')).toBe('DEEP_FIXTURE')
    expect(await readFile(join(data.probe, 'output.txt'), 'utf8')).toBe('OUTPUT')
    for (const path of [join(data.folder, 'escape.txt'), join(data.source, 'child-sentinel.txt'), join(data.source, 'shell-sentinel.txt')])
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const after = await Promise.all(roots.map((path) => acl(data.executable, path)))
    expectRuntimeGrant(original[0]!, after[0]!)
    expect(after.slice(1, 3)).toEqual(original.slice(1, 3))
    expect(withoutRuntimeCapability(after[3]!)).toBe(withoutRuntimeCapability(original[3]!))
    expect(await profiles()).toEqual(baseline)
    console.log('Deep fixture path characters:', deepFile.length, 'two-run lifecycle ms:', Date.now() - started)
  }, 30000)
  it('runs serial commands in one profile, preserves native streams/codes, and treats fake protocol text as data', async () => {
    const data = await fixture(); const before = await profiles()
    const original = await acl(data.executable, data.runtimeRoot)
    const started = Date.now(); const session = await open(data)
    expect((await profiles()).filter((name) => !before.includes(name))).toHaveLength(1)
    for (const cwd of data.workDirs) {
      let stdout = ''; let stderr = ''
      const result = await session.run(['echo'], cwd, { onStdout: (bytes) => { stdout += bytes.toString() }, onStderr: (bytes) => { stderr += bytes.toString() } })
      expect(result.code).toBe(7)
      expect(stdout).toContain('"type":"closed"')
      expect(stderr).toContain('ECHO_STDERR')
    }
    await session.dispose()
    const granted = await acl(data.executable, data.runtimeRoot)
    expectRuntimeGrant(original, granted)
    expect(await profiles()).toEqual(before)
    console.log('App-owned native session setup + two runs + cleanup ms:', Date.now() - started)
    const again = Date.now(); const second = await open(data)
    expect((await second.run(['echo'], data.source)).code).toBe(7)
    await second.dispose()
    expect(await acl(data.executable, data.runtimeRoot)).toBe(granted)
    expect(await profiles()).toEqual(before)
    console.log('Second session on an already granted runtime ms:', Date.now() - again)
  }, 30000)
  it('records a completion marker and repairs an interrupted or stale runtime grant', async () => {
    const data = await fixture(); const before = await profiles()
    const marker = join(data.runtimeRoot, 'paperstudio-runtime-acl.txt')
    const first = await open(data); await first.dispose()
    const granted = await acl(data.executable, data.runtimeRoot)
    const sid = /S-1-15-3-1024-[0-9-]+/.exec(granted)?.[0]
    expect(await readFile(marker, 'ascii')).toBe(sid)
    await rm(marker) // as if propagation had been interrupted before the marker was written
    const repaired = await open(data); expect((await repaired.run(['echo'], data.source)).code).toBe(7); await repaired.dispose()
    expect(await readFile(marker, 'ascii')).toBe(sid)
    expect(await acl(data.executable, data.runtimeRoot)).toBe(granted)
    await execute('icacls.exe', [data.runtimeRoot, '/remove:g', `*${sid}`]) // ACE gone, marker stale
    expect(await acl(data.executable, data.runtimeRoot)).not.toContain(sid)
    const regranted = await open(data); await regranted.dispose()
    expect(await acl(data.executable, data.runtimeRoot)).toBe(granted)
    expect(await readFile(marker, 'ascii')).toBe(sid)
    expect(await profiles()).toEqual(before)
  }, 60000)
  it('refuses to start when the runtime carries a tampered (write-capable) runtime capability ACE', async () => {
    const data = await fixture(); const before = await profiles()
    const first = await open(data); await first.dispose()
    const sid = /S-1-15-3-1024-[0-9-]+/.exec(await acl(data.executable, data.runtimeRoot))?.[0]
    if (!sid) throw new Error('Runtime capability ACE missing after first session')
    await execute('icacls.exe', [data.runtimeRoot, '/grant', `*${sid}:(OI)(CI)M`])
    await expect(open(data)).rejects.toThrow()
    expect(await profiles()).toEqual(before)
  }, 30000)
  it('applies the same no-child/no-shell/read-only-runtime limits to the bound converter tool slot (xdvipdfmx)', async () => {
    const data = await fixture(); const before = await profiles()
    const readable = join(data.runtimeRoot, 'install/resource.txt'); await writeFile(readable, 'DEEP_FIXTURE')
    const session = await open(data, { tools: { xdvipdfmx: data.executable } })
    let stdout = ''
    try {
      const result = await session.run(['deep', readable, join(data.source, 'child.exe')], data.source,
        { tool: 'xdvipdfmx', onStdout: (bytes) => { stdout += bytes.toString() } })
      expect(result.code).toBe(7)
      expect(stdout).toContain('ALLOW_RUNTIME_READ=1'); expect(stdout).toContain('DENY_RUNTIME_WRITE=1')
      expect(stdout).toContain('DENY_CHILD_CODE=1816'); expect(stdout).toContain('DENY_SHELL=1')
    } finally { await session.dispose() }
    for (const path of [join(data.source, 'child-sentinel.txt'), join(data.source, 'shell-sentinel.txt')])
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await profiles()).toEqual(before)
  }, 30000)
  it('allows snapshot IO but refuses private parent/absolute reads, outside writes, network and OS child/shell launch', async () => {
    const data = await fixture(); const session = await open(data)
    const server = createServer(); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port')
    try {
      let output = ''
      const result = await session.run(['boundary', join(data.folder, 'private.txt'), join(data.folder, 'escape.txt'), String(address.port)], data.probe,
        { onStdout: (bytes) => { output += bytes.toString() } })
      expect(result.code).toBe(23); expect(output.match(/DENY_READ=1/g)).toHaveLength(2)
      expect(output).toContain('DENY_WRITE=1'); expect(output).toContain('DENY_NETWORK=1'); expect(output).not.toContain('PRIVATE_SENTINEL')
      expect(await readFile(join(data.probe, 'output.txt'), 'utf8')).toBe('OUTPUT')
      await expect(readFile(join(data.folder, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      let shell = ''
      expect((await session.run(['shell'], data.source, { onStdout: (bytes) => { shell += bytes.toString() } })).code).toBe(27)
      expect(shell).toContain('DENY_SHELL=1')
      await expect(readFile(join(data.source, 'shell-sentinel.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      let fork = ''
      expect((await session.run(['fork', join(data.source, 'child.exe')], data.source, { onStdout: (bytes) => { fork += bytes.toString() } })).code).toBe(27)
      expect(fork).toContain('DENY_CHILD_CODE=1816')
      await expect(readFile(join(data.source, 'child-sentinel.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await new Promise<void>((done) => server.close(() => done())); await session.dispose() }
  }, 30000)
  it('aborts a running command only after native cleanup, kills it, restores ACLs and deletes its own profile', async () => {
    const data = await fixture(); const before = await profiles()
    const original = await acl(data.executable, data.source)
    const controller = new AbortController(); const session = await open(data, { signal: controller.signal })
    const ready = pidReady(); const running = session.run(['sleep'], data.source, { onStdout: ready.receive })
    const rejection = expect(running).rejects.toThrow('取消')
    const pid = await ready.promise; controller.abort(); await rejection
    expect(isRunning(pid)).toBe(false)
    expect(await acl(data.executable, data.source)).toBe(original)
    expect(await profiles()).toEqual(before)
  }, 30000)
  it('shares a single wall-clock budget across runs rather than resetting each run', async () => {
    const data = await fixture(); const session = await open(data, { timeoutMs: 1500 })
    expect((await session.run(['echo'], data.source)).code).toBe(7)
    const started = Date.now()
    await expect(session.run(['sleep'], data.source)).rejects.toThrow(/期限|timeout/)
    expect(Date.now() - started).toBeLessThan(2200)
  }, 30000)
  it('cancels on bounded output overflow and rejects work outside the approved snapshots', async () => {
    const data = await fixture(); const before = await profiles(); const session = await open(data)
    await expect(session.run(['echo'], data.folder)).rejects.toThrow('未授权')
    await expect(session.run(['flood'], data.source)).rejects.toThrow(/output-limit|协议/)
    expect(await profiles()).toEqual(before)
  }, 30000)
  it('cancels the test-only nested process tree through NDJSON and cleans ACL/profile state', async () => {
    const data = await fixture(); const before = await profiles(); const original = await acl(data.executable, data.source)
    const running = raw(data, true); await running.next('ready')
    running.send({ type: 'run', id: 1, cwd: data.source, args: ['tree', data.executable] })
    await expect.poll(() => running.frames.filter((frame) => frame.type === 'data').map((frame) => Buffer.from(frame.data ?? '', 'base64').toString()).join(''), { timeout: 10000 }).toContain('CHILD_PID=')
    const output = running.frames.filter((frame) => frame.type === 'data').map((frame) => Buffer.from(frame.data ?? '', 'base64').toString()).join('')
    const pid = Number(/CHILD_PID=(\d+)/.exec(output)?.[1]); expect(isRunning(pid)).toBe(true)
    running.send({ type: 'cancel' }); const terminal = await running.next('closed'); await running.closed
    expect(terminal).toMatchObject({ cleanup: true, reason: 'canceled' }); expect(isRunning(pid)).toBe(false)
    expect(await acl(data.executable, data.source)).toBe(original); expect(await profiles()).toEqual(before)
  }, 30000)
  it('treats stdin EOF and malformed control as terminal, cleans before closing, and blocks fixture switches in production', async () => {
    const data = await fixture(); const before = await profiles()
    const running = raw(data); await running.next('ready'); running.child.stdin.end()
    expect(await running.next('closed')).toMatchObject({ cleanup: true, reason: 'eof' }); await running.closed
    const malformed = raw(data); await malformed.next('ready'); malformed.child.stdin.write(`${'x'.repeat(17000)}\n`)
    expect(await malformed.next('closed')).toMatchObject({ cleanup: true, reason: 'protocol-error' }); await malformed.closed
    await expect(execute(join(resources, 'PaperStudio.Sandbox.exe'), ['--fixture-allow-children', '1', '--', data.executable])).rejects.toBeDefined()
    expect(await profiles()).toEqual(before)
  }, 30000)
  it('kills the active job and removes its profile when only the trusted owner process dies', async () => {
    const data = await fixture(); const before = await profiles(); const original = await acl(data.executable, data.source)
    const args = ['--session', '1', '--runtime-root', data.runtimeRoot, '--work-dir', data.source, '--', data.executable]
    const script = `const {spawn}=require('node:child_process');const p=spawn(process.argv[1],JSON.parse(process.argv[2]),{stdio:['pipe','pipe','pipe'],detached:true,windowsHide:true});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);process.stdin.pipe(p.stdin);p.once('close',c=>process.exit(c??125));`
    const owner = spawn(process.execPath, ['-e', script, join(resources, 'PaperStudio.Sandbox.exe'), JSON.stringify(args)], { stdio: 'pipe', windowsHide: true })
    children.push(owner); const exited = new Promise<void>((done) => owner.once('close', () => done()))
    const ready = pidReady(); let lines = ''; let launched = false
    owner.stdout.on('data', (bytes: Buffer) => {
      lines += bytes.toString(); let newline: number
      while ((newline = lines.indexOf('\n')) !== -1) {
        const frame = JSON.parse(lines.slice(0, newline)) as Frame; lines = lines.slice(newline + 1)
        if (frame.type === 'ready' && !launched) { launched = true; owner.stdin.write(`${JSON.stringify({ type: 'run', id: 1, cwd: data.source, args: ['sleep'] })}\n`) }
        if (frame.type === 'data') ready.receive(Buffer.from(frame.data ?? '', 'base64'))
      }
    })
    const pid = await ready.promise; expect(isRunning(pid)).toBe(true)
    owner.kill('SIGKILL'); await exited
    await expect.poll(() => isRunning(pid), { timeout: 10000 }).toBe(false)
    await expect.poll(async () => profiles(), { timeout: 10000, interval: 100 }).toEqual(before)
    expect(await acl(data.executable, data.source)).toBe(original)
  }, 30000)
  it('binds an optional fixed converter, serially switches tools, and rejects unbound or outside converters', async () => {
    const data = await fixture(); const converter = join(data.runtimeRoot, 'install/Converter.exe'); await copyFile(data.executable, converter)
    const session = await open(data, { tools: { xdvipdfmx: converter } })
    expect((await session.run(['echo'], data.source)).code).toBe(7)
    expect((await session.run(['echo'], data.source, { tool: 'xdvipdfmx' })).code).toBe(7)
    await session.dispose()
    const unbound = await open(data)
    await expect(unbound.run(['echo'], data.source, { tool: 'xdvipdfmx' })).rejects.toThrow('未绑定')
    await unbound.dispose()
    await expect(open(data, { tools: { xdvipdfmx: join(data.source, 'child.exe') } })).rejects.toThrow('工具不在')
  }, 30000)
  it('fails closed for installed-TeX legacy APIs, invalid managed manifests and pre-start abort', async () => {
    const data = await fixture()
    await expect(windowsTexReadRoots(data.executable)).rejects.toThrow('副本')
    await expect(prepareWindowsSandbox(data.executable, data.source, [data.runtimeRoot])).rejects.toThrow('旧单进程')
    const controller = new AbortController(); controller.abort()
    await expect(open(data, { signal: controller.signal })).rejects.toThrow('启动前已取消')
    await writeFile(join(data.runtimeRoot, 'paperstudio-runtime.json'), JSON.stringify({ schema: 1, ready: false }))
    await expect(open(data)).rejects.toThrow('未就绪')
  }, 30000)
})
