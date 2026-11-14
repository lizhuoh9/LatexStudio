import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadTexAsset, type AssetFetch } from '../src/main/tex/download'
import { extractWindowsTexZip, texArchivePath } from '../src/main/tex/archive'
import { enginePaths, readManagedManifest, runtimeName, TEX_ASSETS, validateManifest, type ManagedTexManifest, type TexAsset } from '../src/main/tex/manifest'

const folders: string[] = []
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
async function folder(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'paperstudio-resources-')); folders.push(path); return path }
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }) })
function asset(body = 'safe fixed fixture'): TexAsset { return { platform: 'win32', archive: 'zip',
  url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/fixture.zip', bytes: Buffer.byteLength(body), sha256: sha(body) } }
const response = (body = 'safe fixed fixture'): Response => new Response(body, { headers: { 'content-length': String(Buffer.byteLength(body)) } })
function manifest(id = randomUUID()): ManagedTexManifest {
  const paths = enginePaths('win32')
  return { schema: 1, id, ready: true, platform: 'win32', distribution: 'texlive', version: '2026.11',
    assetSha256: TEX_ASSETS.win32.sha256, engines: { pdflatex: paths.pdflatex, xelatex: paths.xelatex },
    tools: { xdvipdfmx: paths.xdvipdfmx }, binaryHashes: Object.fromEntries(Object.values(paths).map(path => [path, sha('fixture engine')])), chineseResources: false }
}
/** Minimal STORED ZIP writer for fixtures only; no production archive-generation dependency. */
function zip(entries: Array<{ name: string; body?: string; mode?: number }>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), body = Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(30), record = Buffer.alloc(46), checksum = crc32(body)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6)
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(body.length, 24)
    record.writeUInt16LE(name.length, 28); record.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    local.push(header, name, body); central.push(record, name); offset += header.length + name.length + body.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

describe('fixed native resource identity', () => {
  it('pins release bytes and native assets, not an installer script or latest', () => {
    expect(TEX_ASSETS.win32.url).toContain('/v2026.11/')
    expect(TEX_ASSETS.win32.bytes).toBe(247432160)
    expect(TEX_ASSETS.win32.url).toMatch(/\.zip$/)
    expect(TEX_ASSETS.darwin.bytes).toBe(210514532)
    expect(validateManifest(manifest()).chineseResources).toBe(false)
  })
  it.each(['assetSha256', 'platform', 'id', 'version', 'engines', 'binaryHashes'])('rejects altered %s', field => {
    expect(() => validateManifest({ ...manifest(), [field]: 'bad' })).toThrow()
  })
  it('does not let a ready flag or directory name replace binary verification', async () => {
    const base = await folder(), m = manifest(), root = join(base, runtimeName(m.id))
    for (const path of Object.values(enginePaths('win32'))) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), 'fixture engine') }
    await writeFile(join(root, 'paperstudio-runtime.json'), JSON.stringify(m))
    expect((await readManagedManifest(root)).id).toBe(m.id)
    await writeFile(join(root, m.engines.pdflatex), 'changed engine')
    await expect(readManagedManifest(root)).rejects.toThrow('校验失败')
  })
})

describe('bounded native resource download', () => {
  it('verifies bytes, reuses verified cache, emits numeric progress and sends no credentials', async () => {
    const root = await folder(), fetcher = vi.fn<AssetFetch>(async () => response()), onProgress = vi.fn()
    const path = await downloadTexAsset(asset(), root, { fetcher, onProgress })
    expect(await readFile(path, 'utf8')).toBe('safe fixed fixture')
    await downloadTexAsset(asset(), root, { fetcher })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
    expect(JSON.stringify(fetcher.mock.calls[0]?.[1].headers)).not.toMatch(/authorization|cookie/i)
    expect(onProgress).toHaveBeenLastCalledWith({ received: 18, total: 18 })
    expect(await readdir(root)).toEqual([`${asset().sha256}.zip`])
  })
  it('rejects mismatched digest and removes partial bytes', async () => {
    const root = await folder()
    await expect(downloadTexAsset({ ...asset(), sha256: '0'.repeat(64) }, root, { fetcher: async () => response() })).rejects.toThrow('SHA-256')
    expect(await readdir(root)).toEqual([])
  })
  it('rejects redirect to local or unapproved host without sending another request', async () => {
    const fetcher = vi.fn<AssetFetch>(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private?token=secret' } }))
    await expect(downloadTexAsset(asset(), await folder(), { fetcher })).rejects.toThrow('未批准')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('sanitizes transport errors', async () => {
    await expect(downloadTexAsset(asset(), await folder(), { fetcher: async () => { throw new Error('password=PRIVATE token=PRIVATE') } })).rejects.toThrow('无法准备 TeX')
  })
  it('honors cancellation before requests', async () => {
    const fetcher = vi.fn<AssetFetch>()
    await expect(downloadTexAsset(asset(), await folder(), { signal: AbortSignal.abort(), fetcher })).rejects.toThrow('取消')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('arbitrates two identical downloads without overwriting', async () => {
    const root = await folder()
    const paths = await Promise.all([1, 2].map(() => downloadTexAsset(asset(), root, { fetcher: async () => response() })))
    expect(paths[0]).toBe(paths[1]); expect((await readdir(root)).length).toBe(1)
  })
})

describe('non-executing ZIP extraction', () => {
  it.each(['../private', 'TinyTeX/../private', 'TinyTeX/a:b', 'TinyTeX/CON.txt', 'TinyTeX/a\\b', 'TinyTeX/a.'])('rejects %s', path => {
    expect(() => texArchivePath(path)).toThrow()
  })
  it('extracts a regular resource without executing scripts', async () => {
    const root = await folder(), archive = join(root, 'fixture.zip')
    await writeFile(archive, zip([{ name: 'TinyTeX/bin/windows/pdftex.exe', body: 'MZ fixture' }, { name: 'TinyTeX/install.bat', body: 'DO NOT RUN' }]))
    expect((await extractWindowsTexZip(archive, join(root, 'install'))).entries).toBe(2)
    expect(await readFile(join(root, 'install/install.bat'), 'utf8')).toBe('DO NOT RUN')
  })
  it('extracts a locally supplied offline ZIP only through the same-fd pinned digest gate, with fetch disabled', async () => {
    const root = await folder(), archive = join(root, 'offline.zip')
    const bytes = zip([{ name: 'TinyTeX/offline.txt', body: 'offline pinned data' }])
    await writeFile(archive, bytes)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Offline fixture forbids networking') })
    try {
      await extractWindowsTexZip(archive, join(root, 'install'), { expectedSha256: sha(bytes) })
      expect(await readFile(join(root, 'install/offline.txt'), 'utf8')).toBe('offline pinned data')
      expect(fetcher).not.toHaveBeenCalled()
    } finally { fetcher.mockRestore() }
  })
  it('rejects an offline ZIP whose fixed hash differs before creating its installation tree', async () => {
    const root = await folder(), archive = join(root, 'offline.zip')
    await writeFile(archive, zip([{ name: 'TinyTeX/offline.txt', body: 'changed offline bytes' }]))
    await expect(extractWindowsTexZip(archive, join(root, 'install'), { expectedSha256: '0'.repeat(64) })).rejects.toThrow('SHA-256')
    expect(await readdir(root)).toEqual(['offline.zip'])
  })
  it.each([
    { entries: [{ name: 'TinyTeX/escape', mode: 0xa1ff, body: '../private' }] },
    { entries: [{ name: 'TinyTeX/A', body: 'a' }, { name: 'TinyTeX/a', body: 'b' }] },
    { entries: [{ name: 'TinyTeX/file', body: 'a' }, { name: 'TinyTeX/file', body: 'b' }] }
  ])('rejects links and duplicate/case-collision files', async ({ entries }) => {
    const root = await folder(), archive = join(root, 'fixture.zip')
    await writeFile(archive, zip(entries))
    await expect(extractWindowsTexZip(archive, join(root, 'install'))).rejects.toThrow()
  })
})
