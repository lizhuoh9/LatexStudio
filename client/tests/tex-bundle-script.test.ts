import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEX_ASSETS, type TexAsset } from '../src/main/tex/resource-policy'
import type { AssetFetch, downloadTexAsset } from '../src/main/tex/download'
import type { assertPrivateDirectory } from '../src/main/tex/manifest'

const require = createRequire(import.meta.url)
interface Dependencies {
  TEX_ASSETS: { win32: TexAsset }
  downloadTexAsset: typeof downloadTexAsset
  assertPrivateDirectory: typeof assertPrivateDirectory
}
interface Options { clientRoot?: string; platform?: string; fetcher?: AssetFetch; signal?: AbortSignal }
const builder = require('../scripts/prepare-bundled-tex.cjs') as {
  stageBundledTex(options?: Options, dependencies?: Dependencies): Promise<{ file: string; bytes: number; sha256: string }>
  loadTexModules(): Dependencies
  assertBundleMapping(pkg: unknown, asset: TexAsset): void
  main(argv: string[]): Promise<void>
}
const native = builder.loadTexModules(), folders: string[] = []
const body = 'fixed archive fixture, never execute'
const asset: TexAsset = { platform: 'win32', archive: 'zip', bytes: Buffer.byteLength(body),
  sha256: createHash('sha256').update(body).digest('hex'),
  url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/fixture.zip' }
const dependencies = { ...native, TEX_ASSETS: { win32: asset } }
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-bundle-'))
  folders.push(root); await mkdir(join(root, 'resources')); return root
}
const target = (root: string): string => join(root, 'resources/tex-runtime', `${asset.sha256}.zip`)
const response = (): Response => new Response(body, { headers: { 'content-length': String(asset.bytes) } })
afterEach(async () => { for (const root of folders.splice(0)) await rm(root, { force: true, recursive: true }) })

describe('publisher-only fixed Windows TeX resource staging', () => {
  it('uses the original policy/downloader and restores the temporary TS require hook', () => {
    const before = require.extensions['.ts']
    expect(builder.loadTexModules().TEX_ASSETS.win32).toEqual(TEX_ASSETS.win32)
    expect(require.extensions['.ts']).toBe(before)
  })
  it('stages once and verifies/reuses the same ZIP without a duplicate or second request', async () => {
    const root = await fixture(), fetcher = vi.fn<AssetFetch>(async () => response())
    const first = await builder.stageBundledTex({ clientRoot: root, fetcher }, dependencies)
    const again = await builder.stageBundledTex({ clientRoot: root, fetcher }, dependencies)
    expect(first).toMatchObject({ bytes: asset.bytes, sha256: asset.sha256,
      file: `resources/tex-runtime/${asset.sha256}.zip` })
    expect(again).toEqual(first); expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await readFile(target(root), 'utf8')).toBe(body)
    expect(await readdir(join(root, 'resources/tex-runtime'))).toEqual([`${asset.sha256}.zip`])
    expect(fetcher.mock.calls[0]?.[0]).toBe(asset.url)
  })
  it('refuses a corrupt existing ZIP instead of replacing it or requesting the network', async () => {
    const root = await fixture(), fetcher = vi.fn<AssetFetch>()
    await mkdir(join(root, 'resources/tex-runtime'))
    await writeFile(target(root), 'x'.repeat(asset.bytes))
    await expect(builder.stageBundledTex({ clientRoot: root, fetcher }, dependencies)).rejects.toThrow('损坏')
    expect(fetcher).not.toHaveBeenCalled(); expect(await readFile(target(root), 'utf8')).toBe('x'.repeat(asset.bytes))
  })
  it('preserves stale/foreign files and refuses to create multiple ZIP versions', async () => {
    const root = await fixture(), fetcher = vi.fn<AssetFetch>()
    await mkdir(join(root, 'resources/tex-runtime'))
    await writeFile(join(root, 'resources/tex-runtime/old.zip'), 'old')
    await expect(builder.stageBundledTex({ clientRoot: root, fetcher }, dependencies)).rejects.toThrow('stale')
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readdir(join(root, 'resources/tex-runtime'))).toEqual(['old.zip'])
  })
  it('refuses a linked output directory before requesting or writing through it', async () => {
    const root = await fixture(), outside = await fixture(), fetcher = vi.fn<AssetFetch>()
    await symlink(outside, join(root, 'resources/tex-runtime'), 'junction')
    await expect(builder.stageBundledTex({ clientRoot: root, fetcher }, dependencies)).rejects.toThrow('链接')
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(outside)).toEqual(['resources'])
  })
  it('does not accept a hard-linked archive as the distributable', async () => {
    const root = await fixture(), fetcher = vi.fn<AssetFetch>()
    await mkdir(join(root, 'resources/tex-runtime'))
    const original = join(root, 'outside.zip'); await writeFile(original, body)
    await link(original, target(root))
    await expect(builder.stageBundledTex({ clientRoot: root, fetcher }, dependencies)).rejects.toThrow('identity')
    expect(fetcher).not.toHaveBeenCalled(); expect(await readFile(original, 'utf8')).toBe(body)
  })
  it('propagates cancellation and removes an invalid download without executing it', async () => {
    const root = await fixture(), fetcher = vi.fn<AssetFetch>(async () => response())
    await expect(builder.stageBundledTex({ clientRoot: root, fetcher, signal: AbortSignal.abort() }, dependencies)).rejects.toThrow('取消')
    expect(fetcher).not.toHaveBeenCalled()
    const bad = { ...dependencies, TEX_ASSETS: { win32: { ...asset, sha256: '0'.repeat(64) } } }
    await expect(builder.stageBundledTex({ clientRoot: root, fetcher }, bad)).rejects.toThrow('SHA-256')
    expect(await readdir(join(root, 'resources/tex-runtime'))).toEqual([])
  })
  it('does not claim macOS support or accept arbitrary publisher CLI paths/URLs', async () => {
    const root = await fixture(), fetcher = vi.fn<AssetFetch>()
    await expect(builder.stageBundledTex({ clientRoot: root, platform: 'darwin', fetcher }, dependencies)).rejects.toThrow('unverified')
    await expect(builder.main(['--url=https://untrusted.invalid'])).rejects.toThrow('Usage')
    expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(join(root, 'resources'))).toEqual([])
  })
  it('keeps ordinary build offline and adds the archive only to Windows extraResources', async () => {
    const pkg = JSON.parse(await readFile(resolve(__dirname, '../package.json'), 'utf8'))
    expect(pkg.scripts['prepare:tex-runtime']).toBe('node scripts/prepare-bundled-tex.cjs')
    for (const script of ['pack:win', 'dist:win']) expect(pkg.scripts[script]).toMatch(/^npm run prepare:tex-runtime && npm run build &&/)
    expect(pkg.scripts.build).toBe('electron-vite build')
    expect(pkg.build.win.extraResources).toContainEqual({ from: 'resources/tex-runtime', to: 'tex-runtime', filter: [`${TEX_ASSETS.win32.sha256}.zip`, 'README.md'] })
    expect(() => builder.assertBundleMapping(pkg, TEX_ASSETS.win32)).not.toThrow()
    expect(() => builder.assertBundleMapping(pkg, { ...TEX_ASSETS.win32, sha256: 'f'.repeat(64) })).toThrow('mapping')
    const broad = structuredClone(pkg)
    broad.build.win.extraResources.find((entry: { to: string }) => entry.to === 'tex-runtime').filter = ['*.zip', 'README.md']
    expect(() => builder.assertBundleMapping(broad, TEX_ASSETS.win32)).toThrow('mapping')
    expect(JSON.stringify(pkg.build.mac)).not.toContain('tex-runtime')
  })
})
