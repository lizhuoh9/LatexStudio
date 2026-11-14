import { createHash } from 'node:crypto'
import type { PathLike } from 'node:fs'
import { mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Options, ZipFile } from 'yauzl'
import { extractWindowsTexZip, texArchivePath } from '../src/main/tex/archive'

const io = vi.hoisted(() => ({ opened: [] as number[], rawClosed: [] as number[], zipClosed: [] as number[],
  beforeZip: undefined as ((fd: number) => Promise<void>) | undefined }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual,
    open: (path: PathLike, flags: number | string, callback: (error: NodeJS.ErrnoException | null, fd: number) => void) =>
      actual.open(path, flags, (error, fd) => { if (!error) io.opened.push(fd); callback(error, fd) }),
    close: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) =>
      actual.close(fd, error => { if (!error) io.rawClosed.push(fd); callback(error) }) }
})
vi.mock('yauzl', async importOriginal => {
  const actual = await importOriginal<typeof import('yauzl')>()
  return { ...actual, fromFdPromise: async (fd: number, options?: Options): Promise<ZipFile> => {
    await io.beforeZip?.(fd)
    const zip = await actual.fromFdPromise(fd, options)
    zip.once('close', () => io.zipClosed.push(fd))
    return zip
  } }
})
const folders: string[] = []
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-archive-unit-')); folders.push(root); return root
}
interface FixtureEntry {
  name: string | Buffer; body?: string | Buffer; mode?: number; method?: 0 | 8; checksum?: number; size?: number;
  flags?: number; localName?: string; localChecksum?: number; localMethod?: number; compressed?: Buffer
}
/** Small synthetic STORED/DEFLATE fixtures; never an executable resource or a real download. */
function zip(entries: FixtureEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name), body = Buffer.from(entry.body ?? '')
    const method = entry.method ?? 0, flags = entry.flags ?? 0
    const bytes = entry.compressed ?? (method === 8 ? deflateRawSync(body) : body)
    const checksum = entry.checksum ?? crc32(body), size = entry.size ?? body.length
    const header = Buffer.alloc(30), record = Buffer.alloc(46), descriptor = Buffer.alloc(flags & 8 ? 16 : 0)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6)
    header.writeUInt16LE(entry.localMethod ?? method, 8); header.writeUInt32LE(entry.localChecksum ?? (flags & 8 ? 0 : checksum), 14)
    header.writeUInt32LE(flags & 8 ? 0 : bytes.length, 18); header.writeUInt32LE(flags & 8 ? 0 : size, 22)
    header.writeUInt16LE(localName.length, 26)
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6)
    record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10); record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(bytes.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42)
    if (descriptor.length) {
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4)
      descriptor.writeUInt32LE(bytes.length, 8); descriptor.writeUInt32LE(size, 12)
    }
    local.push(header, localName, bytes, descriptor); central.push(record, name)
    offset += header.length + localName.length + bytes.length + descriptor.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
async function fixture(entries: FixtureEntry[]) {
  const root = await folder(), bytes = zip(entries), archive = join(root, 'fixture.zip'), install = join(root, 'install')
  await writeFile(archive, bytes)
  return { root, bytes, archive, install }
}
beforeEach(() => { io.opened = []; io.rawClosed = []; io.zipClosed = []; io.beforeZip = undefined })
afterEach(async () => {
  try { expect(io.opened.length).toBe(io.rawClosed.length + io.zipClosed.length) }
  finally { for (const root of folders.splice(0)) await rm(root, { recursive: true, force: true }) }
})

// Every source fd is counted: yauzl owns it only after successful fromFd, and emits close only after fs.close.
describe('same-descriptor archive provenance and ownership', () => {
  it('hashes and extracts one descriptor, supports DEFLATE/descriptors and never runs scripts', async () => {
    const f = await fixture([{ name: 'TinyTeX/', mode: 0x41ed },
      { name: 'TinyTeX/bin/resource.txt', body: 'safe resource', method: 8, flags: 8 },
      { name: 'TinyTeX/install.bat', body: 'THIS IS DATA, NEVER RUN' }])
    io.beforeZip = async fd => { expect(fd).toBe(io.opened[0]) }
    expect(await extractWindowsTexZip(f.archive, f.install, { expectedSha256: sha(f.bytes) })).toEqual({ entries: 3, bytes: Buffer.byteLength('safe resourceTHIS IS DATA, NEVER RUN') })
    expect(await readFile(join(f.install, 'bin/resource.txt'), 'utf8')).toBe('safe resource')
    expect(io.opened).toHaveLength(1)
    expect(io.zipClosed).toEqual(io.opened)
    expect(io.rawClosed).toEqual([])
  })
  it('permits omission of the digest for explicit synthetic fixtures only', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'fixture' }])
    expect((await extractWindowsTexZip(f.archive, f.install)).entries).toBe(1)
  })
  it('rejects wrong SHA before constructing a ZIP reader or writing staging output and closes the raw fd', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }])
    await expect(extractWindowsTexZip(f.archive, f.install, { expectedSha256: '0'.repeat(64) })).rejects.toThrow('SHA-256')
    expect(io.zipClosed).toEqual([])
    expect(io.rawClosed).toEqual(io.opened)
    await expect(stat(f.install)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never follows a changed source pathname after hashing; it decodes the old fd and then refuses changed identity', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }])
    io.beforeZip = async () => {
      await rename(f.archive, `${f.archive}.old`)
      await writeFile(f.archive, zip([{ name: 'TinyTeX/resource.txt', body: 'hostile' }]))
    }
    await expect(extractWindowsTexZip(f.archive, f.install, { expectedSha256: sha(f.bytes) })).rejects.toThrow('变化')
    expect(await readFile(join(f.install, 'resource.txt'), 'utf8')).toBe('safe')
    expect(io.opened).toHaveLength(1)
    expect(io.zipClosed).toEqual(io.opened)
  })
  it('detects in-place source changes before allowing staging to be published', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }])
    io.beforeZip = async () => { await writeFile(f.archive, zip([{ name: 'TinyTeX/resource.txt', body: 'evil' }])) }
    await expect(extractWindowsTexZip(f.archive, f.install, { expectedSha256: sha(f.bytes) })).rejects.toThrow(/变化|SHA-256/)
    expect(io.zipClosed).toEqual(io.opened)
  })
  it('closes caller-owned raw fd when fromFd initialization rejects and sanitizes forged library prefixes', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }])
    io.beforeZip = async () => { throw new Error('TeX password=FIXTURE_ONLY_SECRET') }
    const error: unknown = await extractWindowsTexZip(f.archive, f.install).catch((value: unknown) => value)
    expect(String(error)).toContain('解包失败')
    expect(String(error)).not.toContain('FIXTURE_ONLY_SECRET')
    expect(io.rawClosed).toEqual(io.opened)
  })
  it('closes raw fd on malformed ZIP initialization', async () => {
    const root = await folder(), archive = join(root, 'broken.zip')
    await writeFile(archive, Buffer.alloc(32))
    await expect(extractWindowsTexZip(archive, join(root, 'install'))).rejects.toThrow('解包失败')
    expect(io.rawClosed).toEqual(io.opened)
  })
  it('rejects archive paths through a directory junction/symlink without opening a source fd', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt' }]), root = await folder(), linked = join(root, 'linked')
    await symlink(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(extractWindowsTexZip(join(linked, 'fixture.zip'), join(root, 'install'))).rejects.toThrow()
    expect(io.opened).toEqual([])
  })
})

describe('ZIP path, CRC and output bounds', () => {
  it.each(['TinyTeX/CONIN$', 'TinyTeX/CONOUT$.txt', 'TinyTeX/CLOCK$', 'TinyTeX/COM¹.log', 'TinyTeX/LPT²',
    'TinyTeX/a?b', 'TinyTeX/a|b', 'TinyTeX/a\uD800', 'TinyTeX/../../private', 'TinyTeX/a//b'])('rejects %j', path => {
    expect(() => texArchivePath(path)).toThrow()
  })
  it.each([
    [{ name: 'TinyTeX/link', mode: 0xa1ff, body: '../outside' }],
    [{ name: 'TinyTeX/A', body: 'a' }, { name: 'TinyTeX/a', body: 'b' }],
    [{ name: 'TinyTeX/A/one', body: 'a' }, { name: 'TinyTeX/a/two', body: 'b' }],
    [{ name: 'TinyTeX/a', body: 'a' }, { name: 'TinyTeX/a', body: 'b' }]
  ].map(entries => ({ entries })))('rejects links and file/prefix collisions', async ({ entries }) => {
    const f = await fixture(entries)
    await expect(extractWindowsTexZip(f.archive, f.install, { expectedSha256: sha(f.bytes) })).rejects.toThrow()
    expect(io.zipClosed).toEqual(io.opened)
  })
  it('rejects data with a wrong central/local CRC even if the archive SHA is correctly pinned', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe', checksum: 1 }])
    await expect(extractWindowsTexZip(f.archive, f.install, { expectedSha256: sha(f.bytes) })).rejects.toThrow('CRC')
  })
  it.each([
    { name: 'TinyTeX/resource.txt', body: 'safe', localName: 'TinyTeX/different' },
    { name: 'TinyTeX/resource.txt', body: 'safe', localChecksum: 1 },
    { name: 'TinyTeX/resource.txt', body: 'safe', localMethod: 8 }
  ])('rejects inconsistent local metadata', async entry => {
    const f = await fixture([entry])
    await expect(extractWindowsTexZip(f.archive, f.install)).rejects.toThrow('本地文件头')
  })
  it.each([
    { name: 'TinyTeX/resource.txt', body: 'safe', method: 8 as const, size: 5 },
    { name: 'TinyTeX/resource.txt', body: 'safe', method: 8 as const, size: 192 * 1024 * 1024 + 1 },
    { name: 'TinyTeX/resource.txt', body: 'safe', method: 8 as const, compressed: Buffer.from('not-deflate') },
    { name: 'TinyTeX/resource.txt', body: 'safe', flags: 1 },
    { name: Buffer.concat([Buffer.from('TinyTeX/'), Buffer.from([0xff])]), body: 'safe', flags: 0x800 }
  ])('rejects invalid sizes, compressed streams, encryption and UTF-8 without large allocations', async entry => {
    const f = await fixture([entry])
    await expect(extractWindowsTexZip(f.archive, f.install)).rejects.toThrow()
  })
})

describe('cancel and staging lifetime', () => {
  it('does not open any fd or output directory after preabort and does not expose its reason', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }])
    const error: unknown = await extractWindowsTexZip(f.archive, f.install, { signal: AbortSignal.abort('FIXTURE_ONLY_SECRET') }).catch((value: unknown) => value)
    expect(String(error)).toContain('取消')
    expect(String(error)).not.toContain('FIXTURE_ONLY_SECRET')
    expect(io.opened).toEqual([])
    expect(await readdir(f.root)).toEqual(['fixture.zip'])
  })
  it('observes cancellation between digest and fromFd without leaking either ownership branch', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }]), abort = new AbortController()
    io.beforeZip = async () => { abort.abort() }
    await expect(extractWindowsTexZip(f.archive, f.install, { signal: abort.signal })).rejects.toThrow('取消')
    expect(io.zipClosed).toEqual(io.opened)
    await expect(stat(f.install)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('cancels after one entry, awaits ZIP close and never extracts the next entry', async () => {
    const f = await fixture([{ name: 'TinyTeX/one', body: 'safe' }, { name: 'TinyTeX/two', body: 'safe' }])
    const abort = new AbortController()
    await expect(extractWindowsTexZip(f.archive, f.install, { signal: abort.signal, expectedSha256: sha(f.bytes),
      onProgress: () => abort.abort('FIXTURE_ONLY_SECRET') })).rejects.toThrow('取消')
    expect(await readdir(f.install)).toEqual(['one'])
    expect(io.zipClosed).toEqual(io.opened)
  })
  it('ignores UI callback exceptions and rejects an invalid expected digest before any source access', async () => {
    const f = await fixture([{ name: 'TinyTeX/resource.txt', body: 'safe' }])
    await expect(extractWindowsTexZip(f.archive, f.install, { expectedSha256: 'invalid' })).rejects.toThrow('SHA-256')
    expect(io.opened).toEqual([])
    expect((await extractWindowsTexZip(f.archive, f.install, { onProgress: () => { throw new Error('TeX token=FIXTURE_ONLY_SECRET') } })).entries).toBe(1)
  })
})
