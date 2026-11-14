import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPrivateDirectory, type TexAsset } from './manifest'

export interface DownloadProgress { received: number; total: number }
export type AssetFetch = (url: string, init: RequestInit) => Promise<Response>
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
const MESSAGES = {
  url: 'TeX 资源重定向到未批准的地址，已停止下载', redirects: 'TeX 资源重定向次数过多',
  status: 'TeX 资源下载失败，请检查网络后重试', length: 'TeX 资源大小与固定发行记录不一致',
  limit: 'TeX 资源超过固定发行大小或分片上限，已停止下载', hash: 'TeX 资源 SHA-256 校验失败；不会执行该资源',
  cache: '已有 TeX 下载缓存损坏；不会执行或覆盖该文件', record: 'TeX 固定资源记录无效',
  write: 'TeX 下载缓存写入失败', body: 'TeX 下载响应无法确认关闭，未启用该资源',
  canceled: 'TeX 资源下载已取消或超时；可重新准备', cleanup: '无法清理未完成的 TeX 下载缓存',
  generic: '无法准备 TeX 下载缓存，请检查网络、空间和目录权限'
} as const
type Code = keyof typeof MESSAGES
const INTERNAL = new WeakMap<object, Code>()
function failure(code: Code): Error { const error = new Error(MESSAGES[code]); INTERNAL.set(error, code); return error }
function sanitized(error: unknown, signal: AbortSignal): Error {
  const code = error !== null && typeof error === 'object' ? INTERNAL.get(error) : undefined
  return failure(signal.aborted ? 'canceled' : code ?? 'generic')
}
function approvedUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !HOSTS.has(url.hostname) ||
      (url.port && url.port !== '443')) throw failure('url')
    return url
  } catch { throw failure('url') }
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void
  const canceled = new Promise<never>((_resolve, reject) => { abort = () => reject(failure('canceled')) })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try { return await Promise.race([pending, canceled]) }
  finally { signal.removeEventListener('abort', abort) }
}
async function cancelWithin(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([pending.catch(() => undefined), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(failure('body')), 1500)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
async function cancelBody(response: Response): Promise<void> {
  await cancelWithin(Promise.resolve().then(() => response.body?.cancel()))
}
async function responseFor(url: string, signal: AbortSignal, fetcher: AssetFetch): Promise<Response> {
  let target = approvedUrl(url)
  for (let count = 0; count < 6; count++) {
    signal.throwIfAborted()
    const pending = Promise.resolve().then(() => fetcher(target.href, { method: 'GET', redirect: 'manual', signal,
      headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' } })).then(response => {
      if (signal.aborted) void cancelBody(response).catch(() => undefined)
      return response
    })
    const response = await abortable(pending, signal)
    let handedOff = false
    try {
      signal.throwIfAborted()
      if (![301, 302, 303, 307, 308].includes(response.status)) { handedOff = true; return response }
      const location = response.headers.get('location')
      if (!location) throw failure('url')
      target = approvedUrl(new URL(location, target).href)
    } finally { if (!handedOff) await cancelBody(response) }
  }
  throw failure('redirects')
}
function progress(listener: ((value: DownloadProgress) => void) | undefined, received: number, total: number): void {
  try { listener?.({ received, total }) } catch { /* UI callbacks cannot authorize resources or leak their errors. */ }
}
function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs
}
async function cached(path: string, asset: TexAsset, signal: AbortSignal): Promise<boolean> {
  let handle: FileHandle | undefined
  try {
    signal.throwIfAborted()
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.bytes) throw failure('cache')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    if (!sameFile(before, await handle.stat())) throw failure('cache')
    const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
    let offset = 0
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, asset.bytes - offset + 1), offset)
      if (!bytesRead) break
      offset += bytesRead
      if (offset > asset.bytes) throw failure('cache')
      hash.update(buffer.subarray(0, bytesRead))
    }
    if (offset !== asset.bytes || hash.digest('hex') !== asset.sha256 || !sameFile(before, await handle.stat()) ||
      !sameFile(before, await lstat(path))) throw failure('cache')
    signal.throwIfAborted()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  } finally { await handle?.close() }
}
function validResponse(response: Response, asset: TexAsset): ReadableStream<Uint8Array> {
  if (response.status !== 200 || !response.body) throw failure('status')
  const declared = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
  if ((declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== asset.bytes)) ||
    (encoding && encoding.toLowerCase() !== 'identity')) throw failure('length')
  return response.body
}
async function receive(response: Response, part: string, asset: TexAsset, signal: AbortSignal,
  listener?: (value: DownloadProgress) => void): Promise<void> {
  let output: FileHandle | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cleanup: Promise<void> | undefined
  const cancel = () => cleanup ??= cancelWithin(Promise.resolve().then(() => reader?.cancel()))
  const onAbort = () => { void cancel().catch(() => undefined) }
  try {
    const body = validResponse(response, asset)
    signal.throwIfAborted()
    output = await open(part, 'wx', 0o600)
    reader = body.getReader()
    signal.addEventListener('abort', onAbort, { once: true })
    const hash = createHash('sha256')
    let received = 0, chunks = 0
    for (;;) {
      signal.throwIfAborted()
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array) || ++chunks > 1_000_000) throw failure('limit')
      received += chunk.value.byteLength
      if (received > asset.bytes) throw failure('limit')
      hash.update(chunk.value)
      let offset = 0
      while (offset < chunk.value.byteLength) {
        signal.throwIfAborted()
        const written = await output.write(chunk.value, offset, chunk.value.byteLength - offset)
        if (!written.bytesWritten) throw failure('write')
        offset += written.bytesWritten
      }
      progress(listener, received, asset.bytes)
    }
    if (received !== asset.bytes || hash.digest('hex') !== asset.sha256) throw failure('hash')
    signal.throwIfAborted()
    await output.sync()
  } finally {
    signal.removeEventListener('abort', onAbort)
    try { if (reader) { await cancel(); reader.releaseLock() } else await cancelBody(response) }
    finally { await output?.close() }
  }
}
function validateAsset(asset: TexAsset): void {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
    asset.bytes > 512 * 1024 * 1024 || !['win32', 'darwin'].includes(asset.platform) ||
    asset.archive !== (asset.platform === 'win32' ? 'zip' : 'tar.xz')) throw failure('record')
  approvedUrl(asset.url)
}
/** Fixed bytes only; public errors are reconstructed from private codes, never provider message prefixes. */
export async function downloadTexAsset(asset: TexAsset, directory: string, options: {
  signal?: AbortSignal; onProgress?: (value: DownloadProgress) => void; fetcher?: AssetFetch
} = {}): Promise<string> {
  let signal = AbortSignal.timeout(15 * 60_000), part: string | undefined
  try {
    if (options.signal) signal = AbortSignal.any([options.signal, signal])
    signal.throwIfAborted()
    validateAsset(asset)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await assertPrivateDirectory(directory)
    const destination = join(directory, `${asset.sha256}.${asset.archive}`)
    if (await cached(destination, asset, signal)) { progress(options.onProgress, asset.bytes, asset.bytes); return destination }
    part = join(directory, `.paperstudio-download-${randomUUID()}.part`)
    await receive(await responseFor(asset.url, signal, options.fetcher ?? fetch), part, asset, signal, options.onProgress)
    signal.throwIfAborted()
    if (!await cached(part, asset, signal)) throw failure('cache')
    try { await link(part, destination) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (!await cached(destination, asset, signal)) throw failure('cache')
    signal.throwIfAborted()
    return destination
  } catch (error) { throw sanitized(error, signal) }
  finally {
    if (part) await unlink(part).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure('cleanup')
    })
  }
}
