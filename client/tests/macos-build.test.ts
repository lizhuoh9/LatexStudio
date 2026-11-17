import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { plan, artifactName } = require('../scripts/build-macos-test.cjs')
const { renderReleaseNotes } = require('../scripts/render-release-notes.cjs')
const config = require('../electron-builder.mac-test.cjs')
const pkg = require('../package.json')

describe('local macOS test handoff, without pretending to run macOS', () => {
  it.each(['arm64', 'x64'])('plans only a native %s DMG and forbids publishing', arch => {
    const build = plan('darwin', arch)
    expect(build).toEqual({ arch, builder: ['--mac', 'dmg', '--' + arch, '--config', 'electron-builder.mac-test.cjs', '--publish', 'never'] })
    expect(build.builder.filter((item: string) => /^--(?:arm64|x64|universal)$/.test(item))).toEqual(['--' + arch])
    expect(build.builder.join(' ')).not.toMatch(/zip/)
  })
  it('rejects Windows/Linux and unknown CPU before invoking a build', () => {
    for (const platform of ['win32', 'linux']) expect(() => plan(platform, 'arm64')).toThrow('must be built on macOS')
    expect(() => plan('darwin', 'ia32')).toThrow('Only native')
  })
  it('isolates ad-hoc test output from formal and Windows releases without disabling fuses', () => {
    expect(config.directories.output).toBe('release/macos-test')
    expect(config.mac).toMatchObject({ target: ['dmg'], identity: '-', notarize: false, hardenedRuntime: true })
    expect(config.artifactName).toBe('LatexStudio-${version}-mac-${arch}-test.${ext}')
    expect(artifactName('1.2.3', 'arm64')).toBe('LatexStudio-1.2.3-mac-arm64-test.dmg')
    expect(artifactName('1.2.3', 'x64')).toBe('LatexStudio-1.2.3-mac-x64-test.dmg')
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
    expect(command).toContain('DMG'); expect(command).not.toContain('应用 ZIP')
    expect(command.split('\n').filter(line => !line.startsWith('#')).join('\n')).not.toMatch(/sudo|xattr|spctl|curl|wget|git push/)
  })
})

describe('published Mac download is one Apple Silicon DMG, never an application ZIP or an Intel build', () => {
  const workflow = readFileSync('../.github/workflows/release.yml', 'utf8')
  it('builds natively on the Apple Silicon runner and uploads only the DMG plus update metadata', () => {
    expect(workflow.split('\n')).toContain('        run: npm run dist:mac:test')
    expect(workflow).toContain('os: [windows-2022, macos-15]') // macos-15 is the Apple Silicon image
    expect(workflow).not.toMatch(/x64 DMG|--x64|--universal|macos-\d+-intel|macos-13/)
    expect(workflow).toContain('client/release/macos-test/LatexStudio-*.dmg')
    expect(workflow).toContain('client/release/macos-test/latest*.yml')
    expect(workflow).not.toMatch(/macos-test\/[^\n]*\.zip/)
    // The only ZIP left in a release is the corresponding source archive required by the license.
    expect(workflow.match(/[^\s"]*\.zip/g)).toEqual(['downloads/LatexStudio-${GITHUB_REF_NAME}-source.zip', '*.zip'])
    expect(workflow).toMatch(/files=\(\*\.exe \*\.dmg \*\.zip \*\.yml \*\.blockmap\)/)
    expect(workflow).not.toMatch(/CSC_LINK|CSC_KEY|APPLE_ID|APPLE_APP|notarytool|xattr|spctl|secrets\./)
  })
  it('links exactly the DMG names the build produces and explains the first launch without terminal commands', () => {
    const notes = renderReleaseNotes(readFileSync('../docs/RELEASE-NOTES.md', 'utf8'), 'v1.2.3')
    const base = 'https://github.com/lizhuoh9/LatexStudio/releases/download/v1.2.3/'
    expect(notes).toContain(`(${base}${artifactName('1.2.3', 'arm64')})`)
    expect(notes).toContain(`(${base}LatexStudio-1.2.3-win-x64-setup.exe)`)
    expect(notes).not.toMatch(/mac-[a-z0-9]+-test\.zip|mac-x64/)
    for (const text of ['应用程序', '隐私与安全性', '仍要打开', '关于本机', '不支持 Intel 芯片', '未完成 Apple 公证', '暂不支持本地 TeX 编译']) expect(notes).toContain(text)
    expect(notes).not.toMatch(/xattr|spctl|sudo|终端/)
  })
})
