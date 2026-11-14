import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { plan } = require('../scripts/build-macos-test.cjs')
const config = require('../electron-builder.mac-test.cjs')
const pkg = require('../package.json')

describe('local macOS test handoff, without pretending to run macOS', () => {
  it.each(['arm64', 'x64'])('plans only a native %s zip and forbids publishing', arch => {
    expect(plan('darwin', arch)).toEqual({ arch, builder: ['--mac', 'zip', '--' + arch, '--config', 'electron-builder.mac-test.cjs', '--publish', 'never'] })
  })
  it('rejects Windows/Linux and unknown CPU before invoking a build', () => {
    for (const platform of ['win32', 'linux']) expect(() => plan(platform, 'arm64')).toThrow('must be built on macOS')
    expect(() => plan('darwin', 'ia32')).toThrow('Only native')
  })
  it('isolates ad-hoc test output from formal and Windows releases without disabling fuses', () => {
    expect(config.directories.output).toBe('release/macos-test')
    expect(config.mac).toMatchObject({ target: ['zip'], identity: '-', notarize: false, hardenedRuntime: true })
    expect(pkg.build.mac.identity).toBeUndefined()
    expect(config.electronFuses).toEqual(pkg.build.electronFuses)
    expect(config.mac.extraResources).toEqual([{ from: 'resources/icons', to: 'icons', filter: ['paperstudio-256.png'] }])
    expect(JSON.stringify(config.mac)).not.toMatch(/win32|tex-runtime|\.exe/)
    const entitlement = readFileSync(config.mac.entitlements, 'utf8')
    expect(entitlement).toContain('com.apple.security.cs.allow-jit')
    expect(entitlement).toContain('com.apple.security.cs.disable-library-validation')
    expect(entitlement).not.toMatch(/allow-unsigned-executable-memory|get-task-allow|allow-dyld-environment-variables/)
  })
  it('ships the original high-resolution ICNS in the Mac bundle', () => {
    expect(pkg.build.mac.icon).toBe('resources/icons/paperstudio.icns')
    const bytes = readFileSync(pkg.build.mac.icon), chunks = new Map<string, Buffer>()
    expect(bytes.toString('ascii', 0, 4)).toBe('icns'); expect(bytes.readUInt32BE(4)).toBe(bytes.length)
    let cursor = 8
    while (cursor < bytes.length) {
      const size = bytes.readUInt32BE(cursor + 4); expect(size).toBeGreaterThanOrEqual(8)
      expect(cursor + size).toBeLessThanOrEqual(bytes.length)
      chunks.set(bytes.toString('ascii', cursor, cursor + 4), bytes.subarray(cursor + 8, cursor + size)); cursor += size
    }
    expect(cursor).toBe(bytes.length)
    for (const [kind, size] of [['ic09', 512], ['ic10', 1024]] as const) {
      const png = chunks.get(kind)!; expect(png.toString('ascii', 1, 4)).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(size); expect(png.readUInt32BE(20)).toBe(size)
    }
  })
  it('keeps the Finder entry local and explicit, without administrative or quarantine bypasses', () => {
    const command = readFileSync('../在Mac上构建测试版.command', 'utf8')
    expect(command).toContain('Darwin'); expect(command).toContain('npm ci --no-audit --no-fund')
    expect(command).toContain('npm run dist:mac:test'); expect(command).not.toMatch(/\r/)
    expect(command.split('\n').filter(line => !line.startsWith('#')).join('\n')).not.toMatch(/sudo|xattr|spctl|curl|wget|git push/)
  })
})
