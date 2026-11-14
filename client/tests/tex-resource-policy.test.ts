import { describe, expect, it } from 'vitest'
import { enginePaths, isRuntimeId, TEX_ASSETS, validateManifest, type ManagedTexManifest } from '../src/main/tex/resource-policy'

function manifest(platform: 'win32' | 'darwin' = 'win32'): ManagedTexManifest {
  const paths = enginePaths(platform)
  return { schema: 1, id: '3a8d80f1-dc89-4ced-bb70-2d858c12da0a', ready: true, platform,
    distribution: 'texlive', version: '2026.11', assetSha256: TEX_ASSETS[platform].sha256,
    engines: { pdflatex: paths.pdflatex, xelatex: paths.xelatex }, tools: { xdvipdfmx: paths.xdvipdfmx },
    binaryHashes: Object.fromEntries(Object.values(paths).map(path => [path, 'a'.repeat(64)])), chineseResources: false }
}

describe('release metadata is not an executable capability', () => {
  it.each(['win32', 'darwin'] as const)('accepts a base %s metadata index without enabling Chinese', platform => {
    expect(validateManifest(manifest(platform))).toEqual(manifest(platform))
  })
  it.each([true, 'true', 1, null, undefined])('rejects an unaccepted Chinese declaration %s', chineseResources => {
    expect(() => validateManifest({ ...manifest(), chineseResources })).toThrow('TeX')
  })
  it.each(['compileVerified', 'chineseCompilationVerified', 'trustedCatalog', 'token'])('rejects extra capability %s', field => {
    expect(() => validateManifest({ ...manifest(), [field]: true })).toThrow('TeX')
  })
  it('returns only independently copied metadata', () => {
    const input = manifest(), output = validateManifest(input)
    input.engines.pdflatex = 'outside.exe'; input.binaryHashes[input.tools.xdvipdfmx] = 'b'.repeat(64)
    expect(output.engines.pdflatex).toBe('install/bin/paperstudio-x64/pdflatex.exe')
    expect(output.tools.xdvipdfmx).toBe('install/bin/paperstudio-x64/xdvipdfmx.exe')
    expect(output.engines.xelatex).toBe('install/bin/paperstudio-x64/xelatex.exe')
    expect(output.binaryHashes[output.tools.xdvipdfmx]).toBe('a'.repeat(64))
    expect(output).not.toHaveProperty('compileVerified')
  })
})

describe('release metadata shape and exact native tools', () => {
  it.each([['null', null], ['array', []], ['number', 7], ['string', 'ready'], ['inherited', Object.create({ schema: 1 })]])('rejects a non-record %s', (_name, value) => {
    expect(() => validateManifest(value)).toThrow('TeX')
  })
  it('rejects extra, missing and alternate tool or hash names', () => {
    const input = manifest()
    expect(() => validateManifest({ ...input, engines: { ...input.engines, latexmk: 'project.cmd' } })).toThrow('TeX')
    expect(() => validateManifest({ ...input, tools: { xdvipdfmx: 'outside.exe' } })).toThrow('TeX')
    expect(() => validateManifest({ ...input, binaryHashes: {} })).toThrow('TeX')
    expect(() => validateManifest({ ...input, binaryHashes: { ...input.binaryHashes, 'outside.exe': 'a'.repeat(64) } })).toThrow('TeX')
  })
  it('accepts plain null-prototype metadata but rejects inherited fields and poisoned keys', () => {
    expect(validateManifest(Object.assign(Object.create(null), manifest())).ready).toBe(true)
    expect(() => validateManifest(Object.create(manifest()))).toThrow('TeX')
    expect(() => validateManifest({ ...manifest(), ...JSON.parse('{"__proto__":{"compileVerified":true}}') })).toThrow('TeX')
  })
  it.each(['3a8d80f1-dc89-1ced-bb70-2d858c12da0a', '../private', ''])('rejects invalid runtime ID %s', id => {
    expect(isRuntimeId(id)).toBe(false)
    expect(() => validateManifest({ ...manifest(), id })).toThrow('TeX')
  })
})
