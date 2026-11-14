import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const catalog = vi.hoisted(() => vi.fn())
vi.mock('../src/main/tex/catalog', () => ({ verifyInstallationCatalog: catalog }))
import { findPreparedTex } from '../src/main/tex/prepare'
import { enginePaths, RUNTIME_MANIFEST, runtimeName, TEX_ASSETS } from '../src/main/tex/manifest'
const roots: string[] = []
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
async function base(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'paperstudio-discovery-')); roots.push(root); return root }
async function runtime(base: string, id: string): Promise<string> {
  const root = join(base, runtimeName(id)), paths = enginePaths('win32'), binaryHashes: Record<string, string> = {}
  for (const path of Object.values(paths)) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'synthetic fixture, never executed')
    binaryHashes[path] = createHash('sha256').update('synthetic fixture, never executed').digest('hex')
  }
  await writeFile(join(root, RUNTIME_MANIFEST), JSON.stringify({ schema: 1, id, ready: true, platform: 'win32', distribution: 'texlive',
    version: '2026.11', assetSha256: TEX_ASSETS.win32.sha256, engines: { pdflatex: paths.pdflatex, xelatex: paths.xelatex },
    tools: { xdvipdfmx: paths.xdvipdfmx }, binaryHashes, chineseResources: false }))
  return root
}
beforeEach(() => { catalog.mockReset().mockResolvedValue(undefined) })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('resource repair discovery, not compilation', () => {
  it('skips a corrupt old version, finds the healthy version, and never deletes the bad one', async () => {
    const root = await base(), bad = await runtime(root, ids[0]!), good = await runtime(root, ids[1]!)
    await writeFile(join(bad, RUNTIME_MANIFEST), 'corrupt')
    expect((await findPreparedTex(root, 'win32'))?.root).toBe(good)
    expect(await readFile(join(bad, RUNTIME_MANIFEST), 'utf8')).toBe('corrupt')
    expect((await readdir(root)).length).toBe(2)
  })
  it('does not reuse a public-manifest-valid version if the application catalog rejects it', async () => {
    const root = await base(), bad = await runtime(root, ids[0]!), good = await runtime(root, ids[1]!)
    catalog.mockImplementation(async path => { if (path === bad) throw new Error('modified dependency') })
    expect((await findPreparedTex(root, 'win32'))?.root).toBe(good)
  })
  it('allows a new UUID repair when all old versions are invalid, without implicit deletion', async () => {
    const root = await base(); await runtime(root, ids[0]!)
    catalog.mockRejectedValue(new Error('invalid fixed catalog'))
    expect(await findPreparedTex(root, 'win32')).toBeNull()
    expect((await readdir(root)).length).toBe(1)
  })
  it('does not swallow cancellation as an ordinary bad version', async () => {
    const root = await base(); await runtime(root, ids[0]!)
    const abort = new AbortController()
    catalog.mockImplementation(async () => { abort.abort(); abort.signal.throwIfAborted() })
    await expect(findPreparedTex(root, 'win32', abort.signal)).rejects.toThrow()
  })
})
