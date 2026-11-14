import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prepareMacSandbox, macTexReadRoots, type MacSandbox } from '../src/main/sandbox/macos'
import { runTool, type ToolResult } from '../src/main/local/process'

const enabled = process.env.PAPERSTUDIO_MAC_SMOKE === '1'
const ENGINE = process.env.PAPERSTUDIO_MAC_TEX ?? '/Library/TeX/texbin/pdflatex'
const MARKER = 'PAPERSTUDIO_OWN_MAC_SENTINEL'
const START = '\\documentclass{article}\n\\begin{document}\n'
const END = '\nNative Mac acceptance.\\end{document}\n'
let job = ''
let work = ''
let nativeProbe = ''
let sandbox: MacSandbox
const C = `#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <arpa/inet.h>
extern char **environ;
static int denied(void){if(errno==EPERM||errno==EACCES){puts("NATIVE_DENIED");return 0;}return 3;}
int main(int n,char **v){
 if(n<2)return 2;
 if(!strcmp(v[1],"positive")){puts("NATIVE_LOCAL_OK");return 0;}
 if(!strcmp(v[1],"read")){FILE*f=fopen(v[2],"r");if(!f)return denied();fclose(f);puts("NATIVE_READ_ESCAPED");return 1;}
 if(!strcmp(v[1],"write")){FILE*f=fopen(v[2],"w");if(!f)return denied();fputs("unsafe",f);fclose(f);return 1;}
 if(!strcmp(v[1],"network")){int s=socket(AF_INET,SOCK_STREAM,0);if(s<0)return denied();
  struct sockaddr_in a={0};a.sin_family=AF_INET;a.sin_port=htons(atoi(v[2]));inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);
  if(connect(s,(struct sockaddr*)&a,sizeof(a))<0){int e=errno;close(s);errno=e;return denied();}close(s);puts("CONNECTED");return 1;}
 if(!strcmp(v[1],"fork")){pid_t p=fork();if(p<0)return denied();if(!p)_exit(0);waitpid(p,0,0);return 1;}
 if(!strcmp(v[1],"spawn")){pid_t p;char *args[]={v[0],"positive",0};int e=posix_spawn(&p,v[0],0,0,args,environ);
  if(e){errno=e;return denied();}waitpid(p,0,0);return 1;}
 if(!strcmp(v[1],"exec")){execl("/bin/sh","sh","-c","printf NATIVE_EXEC_ESCAPED",(char*)0);return denied();}
 return 2;
}`

function flags(): string[] {
  return ['-progname=pdflatex', '-fmt=pdflatex', '-no-shell-escape', '-no-parse-first-line',
    '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-jobname=paperstudio', './main.tex']
}
async function tex(body: string, signal?: AbortSignal): Promise<ToolResult> {
  await writeFile(join(work, 'main.tex'), START + body + END, { mode: 0o600 })
  return runTool({ executable: sandbox.command, args: [...sandbox.argsPrefix, ...flags()],
    cwd: work, env: sandbox.env, signal, timeoutMs: 20_000 })
}
function quoted(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (/["\r\n%#{}]/.test(normalized)) throw new Error('Unsupported controlled test path')
  return `"${normalized}"`
}
function readTex(path: string): string {
  return `\\newread\\probe\\openin\\probe=${quoted(path)}\n` +
    '\\ifeof\\probe\\typeout{PAPERSTUDIO_DENIED}\\else\\read\\probe to\\secret' +
    '\\typeout{PAPERSTUDIO_READ:\\secret}\\fi\\closein\\probe'
}
function probeArguments(): string[] {
  const original = sandbox.argsPrefix[1]
  const engine = sandbox.argsPrefix[2]
  if (!original || !engine) throw new Error('Missing native profile')
  const quote = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const needle = quote(engine)
  // Native policy-primitive fixture changes only the two executable literals, never filesystem/network rules.
  if (original.split(needle).length - 1 !== 2) throw new Error('Unexpected profile executable literals')
  return ['-p', original.split(needle).join(quote(nativeProbe)), nativeProbe]
}
async function native(args: string[], timeoutMs = 5000): Promise<ToolResult> {
  return runTool({ executable: sandbox.command, args: [...probeArguments(), ...args], cwd: work,
    env: sandbox.env, timeoutMs })
}
async function denied(args: string[]): Promise<void> {
  const result = await native(args)
  expect(result.code, result.log).toBe(0)
  expect(result.log).toContain('NATIVE_DENIED')
  expect(result.log).not.toContain('ESCAPED')
}
async function installedDeveloperTools(): Promise<{ executable: string; developer: string; sdk: string }> {
  const candidates = [
    { developer: '/Library/Developer/CommandLineTools', binary: 'usr/bin/clang', sdk: 'SDKs/MacOSX.sdk' },
    { developer: '/Applications/Xcode.app/Contents/Developer',
      binary: 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang', sdk: 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk' }
  ]
  for (const item of candidates) {
    const executable = join(item.developer, item.binary); const sdk = join(item.developer, item.sdk)
    try { if ((await stat(executable)).isFile() && (await stat(sdk)).isDirectory()) return { executable, developer: item.developer, sdk } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error('Developer Mac runner needs preinstalled Xcode/CLT; never invoke the /usr/bin/clang installer shim')
}

// Setting the flag on Windows is an error, not a pass or an emulated Mac run.
describe.skipIf(!enabled)('REAL macOS native isolation/PDF acceptance (explicit opt-in)', () => {
  beforeAll(async () => {
    if (process.platform !== 'darwin') throw new Error('PAPERSTUDIO_MAC_SMOKE requires a physical/native macOS runner')
    if (!['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported Mac architecture')
    job = await mkdtemp(join(await realpath(tmpdir()), 'paperstudio-macos-'))
    work = join(job, 'source'); await mkdir(work, { mode: 0o700 })
    await writeFile(join(job, 'private.txt'), MARKER, { flag: 'wx', mode: 0o600 })
    await writeFile(join(work, 'local.txt'), MARKER, { flag: 'wx', mode: 0o600 })
    sandbox = await prepareMacSandbox(ENGINE, work, await macTexReadRoots(ENGINE))
    nativeProbe = join(work, 'native-policy-probe')
    const source = join(work, 'native-policy-probe.c')
    await writeFile(source, C, { flag: 'wx', mode: 0o600 })
    const tools = await installedDeveloperTools()
    const built = await runTool({ executable: tools.executable, args: ['-isysroot', tools.sdk, source, '-o', nativeProbe],
      cwd: work, env: { ...sandbox.env, DEVELOPER_DIR: tools.developer, SDKROOT: tools.sdk }, timeoutMs: 30_000 })
    expect(built.code, 'Developer Mac runner needs existing Xcode command-line tools; no installer is run').toBe(0)
    const positive = await native(['positive'])
    expect(positive.code, positive.log).toBe(0)
    expect(positive.log).toContain('NATIVE_LOCAL_OK')
  }, 60_000)
  afterAll(async () => { if (job) await rm(job, { recursive: true, force: true }) })

  it('creates a real complete PDF and reads only its controlled local positive sentinel', async () => {
    const result = await tex(readTex('local.txt'))
    expect(result.code, result.log).toBe(0)
    expect(result.log).toContain(`PAPERSTUDIO_READ:${MARKER}`)
    const pdf = join(work, 'paperstudio.pdf')
    expect((await stat(pdf)).size).toBeLessThanOrEqual(32 * 1024 * 1024)
    const bytes = await readFile(pdf)
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
    expect(bytes.subarray(-1024).includes(Buffer.from('%%EOF'))).toBe(true)
  }, 30_000)

  it('denies relative, absolute and linked reads of our own external sentinel', async () => {
    await symlink(join(job, 'private.txt'), join(work, 'linked-private.txt'))
    for (const path of ['../private.txt', join(job, 'private.txt'), 'linked-private.txt']) {
      const result = await tex(readTex(path))
      expect(result.log).not.toContain(`PAPERSTUDIO_READ:${MARKER}`)
      expect(result.log).toMatch(/PAPERSTUDIO_DENIED|not (?:reading|allowed)|permission denied|operation not permitted/i)
    }
    await denied(['read', join(job, 'private.txt')])
  }, 75_000)

  it('denies external and symlink-mediated writes and leaves no outside output', async () => {
    await symlink(job, join(work, 'linked-parent'))
    for (const path of ['../blocked.txt', join(job, 'blocked-absolute.txt'), 'linked-parent/blocked-link.txt']) {
      const result = await tex(`\\newwrite\\probe\\immediate\\openout\\probe=${quoted(path)}\n` +
        '\\immediate\\write\\probe{unsafe}\\immediate\\closeout\\probe')
      expect(result.log).toMatch(/not (?:writing|allowed)|permission denied|operation not permitted|openout_any/i)
    }
    await denied(['write', join(job, 'blocked-native.txt')])
    for (const file of ['blocked.txt', 'blocked-absolute.txt', 'blocked-link.txt', 'blocked-native.txt'])
      await expect(stat(join(job, file))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 75_000)

  it('rejects TCP networking against a controlled loopback listener with a positive host baseline', async () => {
    let connections = 0
    const server = createServer((socket) => { connections++; socket.end() })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing loopback port')
      const baseline = await runTool({ executable: nativeProbe, args: ['network', String(address.port)],
        cwd: work, env: sandbox.env, timeoutMs: 5000 })
      expect(baseline.log).toContain('CONNECTED')
      expect(connections).toBe(1)
      await denied(['network', String(address.port)])
      expect(connections).toBe(1)
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  })

  it('blocks fork, posix_spawn and an attempted /bin/sh exec independently of TeX flags', async () => {
    for (const operation of ['fork', 'spawn', 'exec']) await denied([operation])
    const result = await tex('\\immediate\\write18{echo NATIVE_SHELL_ESCAPED}\\typeout{SHELL_TEST_FINISHED}')
    expect(result.code, result.log).toBe(0)
    expect(result.log).toContain('SHELL_TEST_FINISHED')
    expect(result.log).not.toMatch(/^NATIVE_SHELL_ESCAPED\s*$/m)
  }, 30_000)

  it('cancels a real infinite TeX process, waits for close, and can run again', async () => {
    const controller = new AbortController()
    await writeFile(join(work, 'main.tex'), '\\immediate\\write16{CANCEL_READY}\\loop\\iftrue\\repeat')
    const result = await runTool({ executable: sandbox.command, args: [...sandbox.argsPrefix, ...flags()],
      cwd: work, env: sandbox.env, signal: controller.signal, timeoutMs: 10_000,
      onLog: (message) => { if (message.includes('CANCEL_READY')) controller.abort() } })
    expect(result.canceled).toBe(true)
    // Close is observed by runTool; the denied process-fork rule prevents grandchildren.
    const recovered = await tex('Recovered after cancellation.')
    expect(recovered.code, recovered.log).toBe(0)
  }, 30_000)

  it('times out real infinite TeX and waits for process close before returning', async () => {
    await writeFile(join(work, 'main.tex'), '\\loop\\iftrue\\repeat')
    const result = await runTool({ executable: sandbox.command, args: [...sandbox.argsPrefix, ...flags()],
      cwd: work, env: sandbox.env, timeoutMs: 1000 })
    expect(result.timedOut).toBe(true)
    expect(result.canceled).toBe(false)
  }, 15_000)
})
