import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createWindowsSandboxSession, type WindowsSandboxSession } from '../src/main/sandbox/windows'

const execute = promisify(execFile)
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_SANDBOX_PATH_SMOKE === '1'
const resources = resolve('resources/win32')
// Helper with the persistent runtime-capability ACE (2026-11-12); previous frozen helper was 41A2FD73…
const helperHash = '1501C6469F1F241B5982EE714ACDE6978EA3C970489C93B63FD537089EE882B7'
const wrapperHash = '2220577E0DCA6FA2DD9476D3D9F8E662C1C827E7BBF67A06A33D8F81DC5ED75C'
const apis = ['SearchPathA', 'SearchPathW', 'FindFirstFileA', 'FindFirstFileW', 'GetFileAttributesW', 'CreateFileW.Attributes'] as const
const production = ['PaperStudio.Sandbox.exe', 'Native.cs', 'Policy.cs', 'Attributes.cs', 'Job.cs', 'Environment.cs',
  'Program.cs', 'RuntimeCapability.cs', 'SessionPolicy.cs', 'SessionWire.cs', 'SessionRun.cs', 'FileSystem.cs', 'build.ps1'].map((name) => join(resources, name))
production.push(resolve('src/main/sandbox/windows.ts'))
type Row = { prefix: number; api: typeof apis[number]; ok: boolean; code: number; errorDefined: boolean }
function valid(value: unknown): value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).sort().join(',') === 'api,code,errorDefined,ok,prefix'
    && Number.isInteger(row.prefix) && (row.prefix as number) >= 0 && (row.prefix as number) < 32
    && typeof row.api === 'string' && (apis as readonly string[]).includes(row.api) && typeof row.ok === 'boolean'
    && Number.isInteger(row.code) && (row.code as number) >= 0 && (row.code as number) <= 0xffffffff && row.errorDefined === !row.ok
}
function parseRows(text: string, prefixes: number): Row[] {
  if (Buffer.byteLength(text) > 65536 || !/^[\x20-\x7e\r\n]*$/.test(text)) throw new Error('Invalid diagnostic encoding or size')
  const values: unknown[] = text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown)
  if (values.length !== prefixes * apis.length || !values.every(valid)) throw new Error('Invalid diagnostic shape')
  const rows = values as Row[]
  for (let index = 0; index < prefixes; index++) {
    const group = rows.filter((row) => row.prefix === index)
    if (group.length !== apis.length || new Set(group.map((row) => row.api)).size !== apis.length) throw new Error('Missing or duplicate literal query')
  }
  return rows
}
async function digest(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex').toUpperCase() }
async function fingerprints(): Promise<string[]> { return Promise.all(production.map(digest)) }
async function profileBaseline(): Promise<string> {
  const script = '$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings");if($k){foreach($s in $k.GetSubKeyNames()){$e=$k.OpenSubKey($s);$n=$e.GetValue("DisplayName");if($n -like "PaperStudio.Compiler.*"){Write-Output $n};$e.Close()};$k.Close()}'
  const result = await execute('powershell.exe', ['-NoProfile', '-Command', script], { maxBuffer: 65536 })
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).sort().join('\n')
}
/** The runtime root now keeps one persistent read/execute ACE for the named capability; ignore only that ACE. */
async function ownAcl(executable: string, path: string): Promise<string> {
  const sddl = (await execute(executable, ['acl', path], { maxBuffer: 65536 })).stdout.trim()
  return sddl.replace(/\(A;OICI(?:ID)?;[^;()]*;;;S-1-15-3-1024-[0-9-]+\)/g, '')
}
async function allocate() {
  const folder = join(resolve('release/native-path-lab'), `paperstudio-path-${randomUUID()}`)
  const id = randomUUID(), runtimeRoot = join(folder, `paperstudio-tex-${id}`)
  const source = join(folder, 'source'), probe = join(folder, 'probe'), install = join(runtimeRoot, 'install')
  await mkdir(install, { recursive: true, mode: 0o700 }); await mkdir(source); await mkdir(probe)
  await writeFile(join(runtimeRoot, 'paperstudio-runtime.json'), JSON.stringify({ schema: 1, id, ready: true, platform: 'win32', distribution: 'texlive' }), { flag: 'wx' })
  const executable = join(install, 'Probe.exe')
  const compiler = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  await execute(compiler, ['/nologo', '/target:exe', '/platform:x64', '/define:SANDBOX_PATH_FIXTURE', `/out:${executable}`,
    join(resources, 'Probe.cs'), join(resources, 'PathProbe.cs'), join(resources, 'FileSystem.cs')], { maxBuffer: 65536 })
  return { folder, runtimeRoot, executable, source, probe, workDirs: [source, probe] }
}
function shortFailure(phase: string, cleanupConfirmed: boolean, nativeCode: number | null): Error {
  return new Error(`Literal path diagnostic failed; phase=${phase};cleanupConfirmed=${Number(cleanupConfirmed)};nativeCode=${nativeCode ?? 'none'}; no raw diagnostics disclosed`)
}
async function diagnose(): Promise<void> {
  let phase = 'fingerprints', cleanupConfirmed = false
  let nativeCode: number | null = null
  let session: WindowsSandboxSession | undefined
  let data: Awaited<ReturnType<typeof allocate>> | undefined
  try {
    const before = await fingerprints()
    if (before[0] !== helperHash || before.at(-1) !== wrapperHash) throw new Error('Frozen artifact mismatch')
    phase = 'allocate-and-compile'; data = await allocate()
    const roots = [data.folder, data.runtimeRoot, data.source, data.probe]
    phase = 'baseline'
    const ownBefore = await Promise.all(roots.map((path) => ownAcl(data!.executable, path))), profilesBefore = await profileBaseline()
    phase = 'session-ready'; session = await createWindowsSandboxSession({ ...data, timeoutMs: 120000 })
    let output = '', stderrBytes = 0
    try {
      phase = 'literal-query'
      const result = await session.run(['path', data.executable], data.source, {
        onStdout: (bytes) => {
          if (bytes.some((byte) => byte > 126 || (byte < 32 && byte !== 10 && byte !== 13))) throw new Error('Non-ASCII fixture output')
          output += bytes.toString('ascii'); if (output.length > 65536) throw new Error('Bounded fixture output exceeded')
        },
        onStderr: (bytes) => { stderrBytes += bytes.length }
      })
      nativeCode = result.code
      if (result.code !== 0 || stderrBytes !== 0) throw new Error('Fixture engine failed')
    } finally { const previous = phase; phase = 'dispose'; await session.dispose(); cleanupConfirmed = true; phase = previous }
    phase = 'validate-output'
    const prefixCount = data.executable.split(/[\\/]/).length, rows = parseRows(output, prefixCount)
    phase = 'restore-check'
    const aclEqual = JSON.stringify(await Promise.all(roots.map((path) => ownAcl(data!.executable, path)))) === JSON.stringify(ownBefore)
    const profilesEqual = await profileBaseline() === profilesBefore, artifactsEqual = JSON.stringify(await fingerprints()) === JSON.stringify(before)
    if (!aclEqual || !profilesEqual || !artifactsEqual) throw new Error('Cleanup or frozen artifact mismatch')
    phase = 'own-fixture-removal'; await rm(data.folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    console.log(JSON.stringify({ kind: 'literal-path-results', prefixCount, driveRootIndex: 0, firstDirectoryIndex: 1,
      ownedParentIndex: data.folder.split(/[\\/]/).length - 1, runtimeIndex: data.runtimeRoot.split(/[\\/]/).length - 1,
      executableIndex: prefixCount - 1, rows, cleanup: { confirmed: cleanupConfirmed, ownAclEqual: aclEqual,
        profileBaselineEqual: profilesEqual, frozenArtifactsEqual: artifactsEqual, ownFixtureRemoved: true } }))
  } catch { throw shortFailure(phase, cleanupConfirmed, nativeCode) }
  finally {
    if (session && !cleanupConfirmed) await session.cancel().catch(() => undefined)
  }
}

describe('literal-path diagnostic output contract (no native execution)', () => {
  it('accepts only the finite numeric per-prefix API schema', () => {
    const rows = apis.map((api) => ({ prefix: 0, api, ok: false, code: 5, errorDefined: true }))
    expect(parseRows(rows.map((row) => JSON.stringify(row)).join('\n'), 1).length).toBe(6)
  })
  it('refuses extra strings, duplicate APIs and inconsistent success error semantics', () => {
    const rows = apis.map((api) => ({ prefix: 0, api, ok: true, code: 0, errorDefined: false }))
    expect(valid({ ...rows[0], path: 'forbidden-output' })).toBe(false)
    expect(valid({ ...rows[0], errorDefined: true })).toBe(false)
    expect(() => parseRows(Array(6).fill(JSON.stringify(rows[0])).join('\n'), 1)).toThrow('duplicate')
  })
})
describe.skipIf(!enabled)('same-token literal ancestor path queries — app-owned fixed executable only', () => {
  it('queries one fixed prefix chain in one production session, without ACL changes to real ancestors', { timeout: 160000, retry: 0 }, async () => {
    await diagnose()
  })
})
