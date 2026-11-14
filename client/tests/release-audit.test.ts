import { createRequire } from 'node:module'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const audit = require('../scripts/release-audit.cjs')
const roots: string[] = []
async function temp(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'paperstudio-release-test-')); roots.push(dir); return dir }
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const sha = (text: string): string => audit.hash(Buffer.from(text))

// Pure/temporary-folder checks only: never signs, installs, contacts NAS or invokes a sandbox.
describe('read-only release gate', () => {
  it('parses checksum manifests and rejects malformed, duplicate and traversing entries', () => {
    expect(audit.parseManifest(`${sha('one')}  PaperStudio-0.2.0-win-x64-setup.exe\n`).size).toBe(1)
    for (const text of ['not-a-hash  x.exe', `${sha('a')}  ../x.exe`, `${sha('a')}  x.exe\n${sha('b')}  x.exe`])
      expect(() => audit.parseManifest(text)).toThrow()
  })
  it('reports unsigned, unavailable and unsupported signatures as not valid', async () => {
    expect(await audit.signature('unused', async () => ({ stdout: '{"status":"NotSigned"}' }), 'win32')).toMatchObject({ valid: false, status: 'NotSigned' })
    expect(await audit.signature('unused', async () => { throw new Error('missing tool') }, 'win32')).toMatchObject({ valid: false })
    expect(await audit.signature('unused', () => { throw new Error('must not invoke') }, 'linux')).toMatchObject({ valid: false, status: 'unsupported-platform' })
  })
  it('requires a trusted Valid signature and signer thumbprint, never merely a certificate', async () => {
    const signature = async (status: string, thumbprint: string | null) => audit.signature('unused', async () => ({ stdout: JSON.stringify({ status, thumbprint, timestamped: true }) }), 'win32')
    expect((await signature('Valid', 'A'.repeat(40))).valid).toBe(true)
    expect((await signature('HashMismatch', 'A'.repeat(40))).valid).toBe(false)
    expect((await signature('Valid', null)).valid).toBe(false)
    expect(audit.signatureApproved({ valid: true, timestamped: false })).toBe(false)
    expect(audit.signatureApproved({ valid: true, timestamped: true })).toBe(true)
    expect(audit.signatureApproved({ valid: false, timestamped: true })).toBe(false)
  })
  it('passes paths to PowerShell as escaped literals, not interpolated executable commands', async () => {
    let received: string[] = []
    await audit.signature("C:/test/o'hare.exe", async (_exe: string, args: string[]) => { received = args; return { stdout: '{"status":"NotSigned"}' } }, 'win32')
    expect(received.at(-1)).toContain("-LiteralPath 'C:/test/o''hare.exe'")
  })
  it('accepts formal evidence only when every case and exact installer/archive hashes bind', () => {
    const cases = Object.fromEntries(['originalExecutableUnmodified', 'firstRun', 'offlineReopen', 'chineseAndBibtex', 'cancelAndRetry', 'dirtyCloseAndRestart', 'upgradePreservesProject', 'uninstallPreservesProject', 'noLeftoverProcesses'].map(name => [name, true]))
    const receipt = { kind: 'formal-installed-acceptance-v1', method: 'manual-original-signed-executable', installerSha256: sha('exe'), appAsarSha256: sha('asar'), cases }
    expect(audit.formalAcceptance(receipt, sha('exe'), sha('asar'))).toBe(true)
    expect(audit.formalAcceptance(receipt, sha('new-exe'), sha('asar'))).toBe(false)
    expect(audit.formalAcceptance({ ...receipt, method: 'inspect-copy' }, sha('exe'), sha('asar'))).toBe(false)
    expect(audit.formalAcceptance({ ...receipt, cases: { ...cases, offlineReopen: false } }, sha('exe'), sha('asar'))).toBe(false)
    expect(audit.formalAcceptance(null, sha('exe'), sha('asar'))).toBe(false)
  })
  it('requires an explicit, current installed directory, signatures and formal evidence for readiness', async () => {
    const client = await temp(); await mkdir(join(client, 'release')); await writeFile(join(client, 'package.json'), '{"version":"0.2.0"}')
    const before = await readFile(join(client, 'package.json'), 'utf8')
    const result = await audit.audit({ client, signature: async () => ({ valid: false, status: 'NotSigned' }) })
    expect(result.ready).toBe(false)
    expect(result.blockers).toEqual(expect.arrayContaining(['checksums', 'signatures', 'buildPackage', 'sourceBuildAttestation', 'installedPackage', 'formalInstallation']))
    expect(await readFile(join(client, 'package.json'), 'utf8')).toBe(before)
  })
  it('compares all packaged output bytes, refuses stale extra assets and preserves package metadata semantics', async () => {
    const client = await temp(); await mkdir(join(client, 'out')); await mkdir(join(client, 'src/vendor/ayakaleaf'), { recursive: true })
    const data: Record<string, string> = { 'out/main.js': 'built', 'package.json': JSON.stringify({ name: 'test', version: '0.2.0', main: 'out/main.js', license: 'AGPL-3.0-only', devDependencies: { tool: '1' } }), 'THIRD_PARTY_NOTICES.md': 'notices', 'src/vendor/ayakaleaf/LICENSE.txt': 'license' }
    for (const [file, text] of Object.entries(data)) await writeFile(join(client, file), text)
    const packed: Record<string, string> = { ...data, 'package.json': JSON.stringify({ name: 'test', version: '0.2.0', main: 'out/main.js', license: 'AGPL-3.0-only' }) }
    const fake = { listPackage: () => Object.keys(packed).map(name => '/' + name), extractFile: (_file: string, name: string) => Buffer.from(packed[name.replaceAll('\\', '/')]!) }
    expect((await audit.compareArchive(client, 'unused', fake)).passed).toBe(true)
    packed['out/main.js'] = 'old'
    expect((await audit.compareArchive(client, 'unused', fake)).mismatches).toContain('out/main.js')
    packed['out/main.js'] = 'built'; Object.assign(packed, { 'out/old.js': 'stale' })
    expect((await audit.compareArchive(client, 'unused', fake)).passed).toBe(false)
  })
  it('does not accept the old installed-smoke format as original signed installation evidence', () => {
    expect(audit.formalAcceptance({ kind: 'installed-app-acceptance', functionalDrive: 'inspect-copy', installer: { signed: false } }, sha('x'), sha('y'))).toBe(false)
  })
})

const packageVerifier = require('../scripts/verify-package.cjs')
async function bundleFixture() {
  const root = await temp(), resources = join(root, 'resources'), body = 'small fixed ZIP fixture, never execute'
  const expected = { platform: 'win32', archive: 'zip', bytes: Buffer.byteLength(body), sha256: sha(body) }
  const directory = join(resources, 'tex-runtime'), file = join(directory, `${expected.sha256}.zip`)
  await mkdir(directory, { recursive: true }); await writeFile(file, body)
  return { root, resources, directory, file, body, expected }
}

describe('mandatory fixed bundled Windows TeX release resource', () => {
  it('shares a read-only exact-size/SHA gate with the package verifier without launching it', async () => {
    const fixture = await bundleFixture()
    expect(packageVerifier.verifyBundledTex).toBe(audit.verifyBundledTex)
    expect(await packageVerifier.verifyBundledTex(fixture.resources, fixture.expected)).toEqual({ passed: true,
      file: `tex-runtime/${fixture.expected.sha256}.zip`, bytes: fixture.expected.bytes, sha256: fixture.expected.sha256 })
    expect(await readFile(fixture.file, 'utf8')).toBe(fixture.body)
  })
  it('refuses a missing resource or truncated archive', async () => {
    const fixture = await bundleFixture()
    await rm(fixture.file)
    await expect(audit.verifyBundledTex(fixture.resources, fixture.expected)).rejects.toThrow()
    await writeFile(fixture.file, 'truncated')
    await expect(audit.verifyBundledTex(fixture.resources, fixture.expected)).rejects.toThrow('size')
  })
  it('refuses same-size altered bytes and does not repair or overwrite them', async () => {
    const fixture = await bundleFixture(), altered = 'x'.repeat(fixture.expected.bytes)
    await writeFile(fixture.file, altered)
    await expect(audit.verifyBundledTex(fixture.resources, fixture.expected)).rejects.toThrow('SHA-256')
    expect(await readFile(fixture.file, 'utf8')).toBe(altered)
  })
  it('refuses an archive with additional hard-link aliases', async () => {
    const fixture = await bundleFixture()
    await link(fixture.file, join(fixture.root, 'alias.zip'))
    await expect(audit.verifyBundledTex(fixture.resources, fixture.expected)).rejects.toThrow('identity')
  })
  it('refuses a redirected resource directory without reading its ZIP', async () => {
    const fixture = await bundleFixture(), root = await temp(), resources = join(root, 'resources')
    await mkdir(resources)
    await symlink(fixture.directory, join(resources, 'tex-runtime'), 'junction')
    await expect(audit.verifyBundledTex(resources, fixture.expected)).rejects.toThrow('链接')
  })
  it('refuses stale/duplicate ZIPs even beside a valid pinned archive', async () => {
    const fixture = await bundleFixture()
    await writeFile(join(fixture.directory, 'old.zip'), 'old')
    await expect(audit.verifyBundledTex(fixture.resources, fixture.expected)).rejects.toThrow('duplicate')
  })
  it('keeps expected metadata injection out of the production release CLI', async () => {
    expect(() => audit.argumentsOf(['--tex-sha256', '0'.repeat(64)])).toThrow()
    const fixture = await bundleFixture()
    await expect(audit.verifyBundledTex(fixture.resources, { ...fixture.expected, sha256: '../escape' })).rejects.toThrow('metadata')
    await expect(audit.verifyBundledTex(fixture.resources, { ...fixture.expected, bytes: 1024 ** 3 })).rejects.toThrow('metadata')
  })
  it('cannot omit the bundled ZIP gate from a production audit', async () => {
    const root = await temp(); await mkdir(join(root, 'release'))
    await writeFile(join(root, 'package.json'), '{"version":"0.2.0"}')
    const report = await audit.audit({ client: root, signature: async () => ({ valid: false }) })
    expect(report.ready).toBe(false); expect(report.gates.bundledTex).toBe(false)
    expect(report.blockers).toContain('bundledTex')
  })
})
