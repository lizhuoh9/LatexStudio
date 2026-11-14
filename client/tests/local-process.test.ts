import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoundedLog, killProcessTree, MAX_LOG, runTool } from '../src/main/local/process'

const folders: string[] = []
const nodeEnvironment = (cwd: string): NodeJS.ProcessEnv => ({ SystemRoot: process.env.SystemRoot, TEMP: cwd, TMP: cwd })
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function directory(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'paperstudio-process-test-'))
  folders.push(folder)
  return folder
}

describe('bounded and redacted subprocess logs', () => {
  it('redacts credential-like values even when split across chunks', () => {
    const messages: string[] = []
    const log = new BoundedLog((message) => messages.push(message))
    log.push(Buffer.from('ghp_abc')); log.push(Buffer.from('def123\nBearer secret\npassword=hunter2\n'))
    log.push(Buffer.from('https://user:password@example.com\n'))
    const text = log.finish()
    for (const secret of ['abcdef123', 'hunter2', 'Bearer secret', 'user:password']) expect(text).not.toContain(secret)
    expect(messages.join('')).toBe(text)
  })
  it('redacts credentials across the old fixed-size line-chunk boundary', () => {
    const log = new BoundedLog()
    log.push(Buffer.from(' '.repeat(8190) + 'ghp_' + 's'.repeat(100)))
    log.push(Buffer.from('ecret\n'))
    expect(log.finish()).not.toContain('s'.repeat(20))
  })
  it('caps memory and callback output rather than buffering unlimited compiler output', () => {
    const log = new BoundedLog()
    for (let i = 0; i < 300; i++) log.push(Buffer.alloc(8192, 65))
    const result = log.finish()
    expect(Buffer.byteLength(result)).toBeLessThan(MAX_LOG + 256)
    expect(result).toContain('上限')
  })
})

describe('real subprocess lifecycle without shell', () => {
  it('uses a negative process-group PID and SIGKILL on POSIX, not kill-by-name', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      await killProcessTree({ pid: 12345, exitCode: null } as ChildProcess)
      expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
    } finally {
      kill.mockRestore()
      if (descriptor) Object.defineProperty(process, 'platform', descriptor)
    }
  })
  it('runs exact argument arrays with stdin closed', async () => {
    const cwd = await directory()
    const result = await runTool({ executable: process.execPath, args: ['-e',
      'console.log(JSON.stringify(process.argv.slice(1)))', 'a; echo unsafe', '$(echo unsafe)'],
    cwd, env: nodeEnvironment(cwd) })
    expect(result.code).toBe(0)
    expect(result.log).toContain('a; echo unsafe')
    expect(result.log).toContain('$(echo unsafe)')
  })
  it('handles missing executables explicitly and supports pre-cancel', async () => {
    const cwd = await directory()
    const failed = await runTool({ executable: join(cwd, 'missing'), args: [], cwd, env: {} })
    expect(failed.code).toBeNull()
    expect(failed.log).toContain('无法启动')
    const controller = new AbortController(); controller.abort()
    const canceled = await runTool({ executable: process.execPath, args: [], cwd, env: {}, signal: controller.signal })
    expect(canceled.canceled).toBe(true)
  })
  it('times out and reaps the child', async () => {
    const cwd = await directory()
    const result = await runTool({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      cwd, env: nodeEnvironment(cwd), timeoutMs: 150 })
    expect(result.timedOut).toBe(true)
  })
  it('cancels the exact child and grandchild tree (Windows taskkill or POSIX process group)', async () => {
    const cwd = await directory()
    const controller = new AbortController()
    let grandchild = 0
    const program = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,
      ['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`
    const result = await runTool({ executable: process.execPath, args: ['-e', program], cwd,
      env: nodeEnvironment(cwd), signal: controller.signal, timeoutMs: 5000,
      onLog: (message) => { grandchild = Number(message.trim()); controller.abort() } })
    expect(result.canceled).toBe(true)
    expect(grandchild).toBeGreaterThan(0)
    expect(() => process.kill(grandchild, 0)).toThrow()
  })
})
