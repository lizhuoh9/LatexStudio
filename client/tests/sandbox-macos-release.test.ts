import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runTool } from '../src/main/local/process'

const enabled = process.env.PAPERSTUDIO_MAC_RELEASE_SMOKE === '1'
const APP = process.env.PAPERSTUDIO_MAC_APP ?? '/Applications/PaperStudio.app'
const ARTIFACT = process.env.PAPERSTUDIO_MAC_ARTIFACT ?? ''
const EXPECTED = process.env.PAPERSTUDIO_MAC_ARTIFACT_SHA256 ?? ''
const STAPLER = process.env.PAPERSTUDIO_MAC_STAPLER ??
  '/Applications/Xcode.app/Contents/Developer/usr/bin/stapler'
const env = { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C' }
async function tool(executable: string, args: string[]): Promise<string> {
  const result = await runTool({ executable, args, cwd: '/Applications', env, timeoutMs: 30_000 })
  expect(result.code, result.log).toBe(0)
  return result.log
}
async function hash(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

// Developer acceptance only: does not download, install, mount, launch, sign, or request credentials.
describe.skipIf(!enabled)('REAL installed macOS release artifact/signature acceptance (explicit opt-in)', () => {
  beforeAll(async () => {
    if (process.platform !== 'darwin') throw new Error('Release acceptance requires native macOS; never substitute WSL/VM')
    if (!/^\/(?:Applications|Users\/[^/]+\/Applications)\/PaperStudio\.app$/.test(APP))
      throw new Error('First install this release using the real GUI into Applications in a clean test account')
    if (!(await lstat(APP)).isDirectory() || await realpath(APP) !== APP)
      throw new Error('Installed app must be a real directory, not an alias or translocated download')
    if (!/\.(?:dmg|pkg)$/.test(ARTIFACT) || !(await lstat(ARTIFACT)).isFile() || !/^[a-f0-9]{64}$/.test(EXPECTED))
      throw new Error('Provide the exact local release DMG/PKG and pinned SHA256; no download is performed')
    if ((await stat(ARTIFACT)).size > 8 * 1024 * 1024 * 1024) throw new Error('Release artifact exceeds 8 GiB acceptance bound')
    if (!STAPLER.startsWith('/Applications/Xcode.app/Contents/Developer/') &&
      !STAPLER.startsWith('/Library/Developer/CommandLineTools/')) throw new Error('Use an already installed Apple developer stapler')
    if (!(await stat(STAPLER)).isFile()) throw new Error('Developer stapler is missing; do not auto-install tools')
  })

  it('checks the exact pinned installer bytes and its native container/signature', async () => {
    expect(await hash(ARTIFACT)).toBe(EXPECTED)
    if (ARTIFACT.endsWith('.dmg')) await tool('/usr/bin/hdiutil', ['verify', ARTIFACT])
    else {
      const signature = await tool('/usr/sbin/pkgutil', ['--check-signature', ARTIFACT])
      expect(signature).toMatch(/Developer ID Installer|signed by a certificate trusted/i)
    }
  }, 180_000)

  it('verifies all nested code, Developer ID, hardened runtime and a timestamp', async () => {
    await tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP])
    const signature = await tool('/usr/bin/codesign', ['--display', '--verbose=4', APP])
    expect(signature).toMatch(/Authority=Developer ID Application/)
    expect(signature).toMatch(/flags=.*runtime/)
    expect(signature).toMatch(/Timestamp=/)
    expect(signature).not.toMatch(/TeamIdentifier=not set|Signature=adhoc/)
    const entitlements = await tool('/usr/bin/codesign', ['--display', '--entitlements', ':-', APP])
    expect(entitlements).not.toMatch(/<key>[^<]*(?:get-task-allow|files\.all)<\/key>\s*<true\s*\/>/)
  })

  it('requires Gatekeeper acceptance and stapled tickets for installed app and installer', async () => {
    const result = await tool('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', APP])
    expect(result).toMatch(/Notarized Developer ID/)
    await tool(STAPLER, ['validate', APP])
    await tool(STAPLER, ['validate', ARTIFACT])
    const args = ARTIFACT.endsWith('.pkg') ? ['--assess', '--type', 'install', '--verbose=4', ARTIFACT]
      : ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', ARTIFACT]
    await tool('/usr/sbin/spctl', args)
  })

  it('has the native CPU slice in the installed GUI executable, not only a packaging declaration', async () => {
    const name = (await tool('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(APP, 'Contents', 'Info.plist')])).trim()
    if (!/^[A-Za-z0-9 _.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid installed bundle executable')
    const executable = join(APP, 'Contents', 'MacOS', name)
    const slices = await tool('/usr/bin/lipo', ['-archs', executable])
    expect(slices.split(/\s+/)).toContain(process.arch === 'arm64' ? 'arm64' : 'x86_64')
  })
})
