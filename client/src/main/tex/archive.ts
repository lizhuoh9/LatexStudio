import { createHash } from 'node:crypto'
import { constants, createWriteStream, open as rawOpen, close as rawClose, fstat, read, type Stats } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import { fromFdPromise, type Entry, type ZipFile } from 'yauzl'
import { assertPrivateDirectory, contained } from './manifest'

const MAX_ENTRIES = 150_000
const MAX_FILE = 192 * 1024 * 1024
const MAX_TOTAL = 4 * 1024 * 1024 * 1024
const MAX_ARCHIVE = 512 * 1024 * 1024
const MESSAGES = {
  path: 'TeX 压缩包含无效、越界或保留路径', entry: 'TeX 压缩包含链接、特殊文件、加密内容或超限资源',
  duplicate: 'TeX 压缩包含重复或大小写冲突路径', limit: 'TeX 压缩包总量超过安全上限',
  size: 'TeX 解压数据大小与文件记录不一致', crc: 'TeX 解压数据 CRC 校验失败',
  header: 'TeX ZIP 本地文件头与目录记录不一致', encoding: 'TeX ZIP 文件名编码无效',
  source: 'TeX ZIP 来源不是有界普通文件或在读取期间发生变化', hash: 'TeX ZIP SHA-256 来源校验失败',
  canceled: 'TeX 解包已取消或超时；未启用不完整资源', cleanup: 'TeX ZIP 文件句柄未能确认关闭',
  generic: 'TeX 解包失败；未启用不完整资源'
} as const
type Code = keyof typeof MESSAGES
const INTERNAL = new WeakMap<object, Code>()
function failure(code: Code): Error { const error = new Error(MESSAGES[code]); INTERNAL.set(error, code); return error }
function sanitized(error: unknown, signal: AbortSignal): Error {
  const code = error !== null && typeof error === 'object' ? INTERNAL.get(error) : undefined
  return failure(signal.aborted ? 'canceled' : code ?? 'generic')
}
export interface ExtractionProgress { entries: number; bytes: number }
export interface TexExtractionOptions {
  signal?: AbortSignal
  /** Production MUST pass the application-pinned archive digest; omission is for synthetic fixtures only. */
  expectedSha256?: string
  onProgress?: (value: ExtractionProgress) => void
}
type OpenArchive = { fd: number; source: string; before: Stats; digest: string }
const fdStat = (fd: number): Promise<Stats> => new Promise((done, fail) => fstat(fd, (error, value) => error ? fail(error) : done(value)))
const fdClose = (fd: number): Promise<void> => new Promise((done, fail) => rawClose(fd, error => error ? fail(error) : done()))
const fdRead = (fd: number, buffer: Buffer, position: number): Promise<number> => new Promise((done, fail) =>
  read(fd, buffer, 0, buffer.length, position, (error, count) => error ? fail(error) : done(count)))
function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs
}
async function hashFd(fd: number, size: number, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
  let offset = 0
  for (;;) {
    signal.throwIfAborted()
    const count = await fdRead(fd, buffer, offset)
    if (!count) break
    offset += count
    if (offset > size) throw failure('source')
    hash.update(buffer.subarray(0, count))
  }
  if (offset !== size) throw failure('source')
  signal.throwIfAborted()
  return hash.digest('hex')
}
async function openArchive(path: string, expected: string | undefined, signal: AbortSignal): Promise<OpenArchive> {
  const source = resolve(path)
  await assertPrivateDirectory(dirname(source))
  const before = await lstat(source)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 22 || before.size > MAX_ARCHIVE) throw failure('source')
  const fd = await new Promise<number>((done, fail) => rawOpen(source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), (error, value) => error ? fail(error) : done(value)))
  try {
    if (!sameFile(before, await fdStat(fd))) throw failure('source')
    const digest = await hashFd(fd, before.size, signal)
    if (expected && digest !== expected.toLowerCase()) throw failure('hash')
    if (!sameFile(before, await fdStat(fd)) || !sameFile(before, await lstat(source))) throw failure('source')
    return { fd, source, before, digest }
  } catch (error) { await fdClose(fd).catch(() => { throw failure('cleanup') }); throw error }
}
async function checkArchive(file: OpenArchive, signal: AbortSignal): Promise<void> {
  if (!sameFile(file.before, await fdStat(file.fd))) throw failure('source')
  if (await hashFd(file.fd, file.before.size, signal) !== file.digest) throw failure('hash')
  if (!sameFile(file.before, await fdStat(file.fd)) || !sameFile(file.before, await lstat(file.source))) throw failure('source')
}
export function texArchivePath(name: string): string {
  if (typeof name !== 'string' || Buffer.byteLength(name) > 1024 || /[\\\u0000-\u001f\u007f:<>"|?*]/.test(name) ||
    /[\uD800-\uDFFF]/u.test(name) || !name.startsWith('TinyTeX/')) throw failure('path')
  const pieces = name.replace(/\/$/, '').split('/')
  if (pieces.length > 64 || pieces.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
    /^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) throw failure('path')
  return pieces.slice(1).join('/')
}
function nameEncoding(entry: Entry): void {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    if (entry.generalPurposeBitFlag & 0x800) decoder.decode(entry.fileNameRaw)
    for (const extra of entry.extraFields) {
      if (extra.id === 0x7075 && extra.data.length >= 5 && extra.data[0] === 1 &&
        extra.data.readUInt32LE(1) === crc32(entry.fileNameRaw)) decoder.decode(extra.data.subarray(5))
    }
  } catch { throw failure('encoding') }
}
function approvedEntry(entry: Entry): string {
  nameEncoding(entry)
  const path = texArchivePath(entry.fileName), mode = (entry.externalFileAttributes >>> 16) & 0xf000
  if ((mode && ![0x8000, 0x4000].includes(mode)) || entry.isEncrypted() || !entry.canDecodeFileData() ||
    !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_FILE ||
    !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 || entry.compressedSize > MAX_ARCHIVE ||
    (mode === 0x4000 && !entry.fileName.endsWith('/'))) throw failure('entry')
  if (entry.fileName.endsWith('/') && entry.uncompressedSize !== 0) throw failure('entry')
  return path
}
function registerPath(path: string, seen: Set<string>, names: Map<string, string>): void {
  const key = path.toUpperCase()
  if (seen.has(key)) throw failure('duplicate')
  seen.add(key)
  let prefix = ''
  for (const piece of path.split('/')) {
    prefix = prefix ? `${prefix}/${piece}` : piece
    const previous = names.get(prefix.toUpperCase())
    if (previous !== undefined && previous !== prefix) throw failure('duplicate')
    names.set(prefix.toUpperCase(), prefix)
  }
}
function boundedBytes(entry: Entry): Transform {
  let received = 0, checksum = 0
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    received += chunk.byteLength
    if (received > entry.uncompressedSize) { callback(failure('size')); return }
    checksum = crc32(chunk, checksum)
    callback(null, chunk)
  }, flush(callback) {
    callback(received !== entry.uncompressedSize ? failure('size') : checksum !== entry.crc32 ? failure('crc') : undefined)
  } })
}
async function checkHeader(zip: ZipFile, entry: Entry): Promise<void> {
  const header = await zip.readLocalFileHeaderPromise(entry)
  if (!header.fileName.equals(entry.fileNameRaw) || header.compressionMethod !== entry.compressionMethod ||
    header.generalPurposeBitFlag !== entry.generalPurposeBitFlag) throw failure('header')
  if (!(entry.generalPurposeBitFlag & 8) && (header.crc32 !== entry.crc32 ||
    (header.compressedSize !== 0xffffffff && header.compressedSize !== entry.compressedSize) ||
    (header.uncompressedSize !== 0xffffffff && header.uncompressedSize !== entry.uncompressedSize))) throw failure('header')
}
async function extractEntry(zip: ZipFile, entry: Entry, target: string, signal: AbortSignal): Promise<void> {
  await checkHeader(zip, entry)
  signal.throwIfAborted()
  const directory = entry.fileName.endsWith('/')
  await mkdir(directory ? target : dirname(target), { recursive: true, mode: 0o700 })
  await assertPrivateDirectory(directory ? target : dirname(target))
  const input = await zip.openReadStreamPromise(entry)
  try {
    const output = directory ? new Writable({ write(_chunk, _encoding, done) { done() } }) :
      createWriteStream(target, { flags: 'wx', mode: 0o600 })
    await pipeline(input, boundedBytes(entry), output, { signal })
  } finally { input.destroy() }
}
async function extractEntries(zip: ZipFile, installation: string, signal: AbortSignal,
  listener: TexExtractionOptions['onProgress']): Promise<ExtractionProgress> {
  if (zip.entryCount > MAX_ENTRIES) throw failure('limit')
  const seen = new Set<string>(), names = new Map<string, string>(), progress = { entries: 0, bytes: 0 }
  for await (const entry of zip.eachEntry()) {
    signal.throwIfAborted()
    const path = approvedEntry(entry)
    if (++progress.entries > MAX_ENTRIES || (progress.bytes += entry.uncompressedSize) > MAX_TOTAL) throw failure('limit')
    registerPath(path, seen, names)
    const target = resolve(installation, path)
    if (!contained(installation, target)) throw failure('path')
    await extractEntry(zip, entry, target, signal)
    try { listener?.({ ...progress }) } catch { /* UI callbacks cannot authorize resources or leak errors. */ }
  }
  return progress
}
async function closeZip(zip: ZipFile): Promise<void> {
  await new Promise<void>((done, fail) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); zip.removeListener('close', closed); zip.removeListener('error', failed)
      if (error) fail(failure('cleanup')); else done()
    }
    const closed = () => finish(), failed = () => finish(failure('cleanup'))
    const timer = setTimeout(() => finish(failure('cleanup')), 5000)
    zip.once('close', closed); zip.once('error', failed)
    try { zip.close() } catch { finish(failure('cleanup')) }
  })
}
/** Same-fd digest/ZIP/digest, not a lock against a fully compromised same-user process. Caller pins the output tree. */
export async function extractWindowsTexZip(archive: string, installation: string,
  options: TexExtractionOptions = {}): Promise<ExtractionProgress> {
  let signal = AbortSignal.timeout(15 * 60_000), file: OpenArchive | undefined, zip: ZipFile | undefined
  try {
    if (options.signal) signal = AbortSignal.any([options.signal, signal])
    signal.throwIfAborted()
    if (options.expectedSha256 !== undefined && (typeof options.expectedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(options.expectedSha256))) throw failure('hash')
    file = await openArchive(archive, options.expectedSha256, signal)
    zip = await fromFdPromise(file.fd, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true })
    zip.on('error', () => { /* Iteration/stream/close promises report errors without an unhandled emitter. */ })
    signal.throwIfAborted()
    await assertPrivateDirectory(dirname(resolve(installation)))
    await mkdir(installation, { mode: 0o700 })
    const progress = await extractEntries(zip, resolve(installation), signal, options.onProgress)
    await checkArchive(file, signal)
    signal.throwIfAborted()
    return progress
  } catch (error) { throw sanitized(error, signal) }
  finally {
    // fromFd takes raw-fd ownership on success. Never double-close a FileHandle or reopen the source path.
    if (zip) await closeZip(zip)
    else if (file) await fdClose(file.fd).catch(() => { throw failure('cleanup') })
  }
}
