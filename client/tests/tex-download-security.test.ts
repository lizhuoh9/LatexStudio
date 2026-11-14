import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadTexAsset, type AssetFetch } from '../src/main/tex/download'
import type { TexAsset } from '../src/main/tex/manifest'

const TEXT = 'safe fixed fixture', SECRET = 'FIXTURE_ONLY_DO_NOT_EXPOSE'
const folders: string[] = []
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
const asset = (): TexAsset => ({ platform: 'win32', archive: 'zip', bytes: Buffer.byteLength(TEXT), sha256: sha(TEXT),
  url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/fixture.zip' })
async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-download-unit-')); folders.push(root); return root
}
function response(text = TEXT): Response { return new Response(text, { headers: { 'content-length': String(Buffer.byteLength(text)) } }) }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function activeResponse(status = 200, headers: Record<string, string> = {}, text = TEXT) {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(text)) }, cancel })
  return { response: new Response(stream, { status, headers }), cancel }
}
afterEach(async () => {
  vi.useRealTimers()
  for (const root of folders.splice(0)) await rm(root, { recursive: true, force: true })
})

// All responses are in-memory provider fixtures. These tests never access a network or execute resources.
describe('branded download errors and response lifetime', () => {
  it.each([`TeX password=${SECRET}`, `已有 TeX token=${SECRET}`, `HTTP Authorization: ${SECRET}`])(
    'does not trust provider error message prefixes', async (message) => {
      const root = await folder()
      const error: unknown = await downloadTexAsset(asset(), root, { fetcher: async () => { throw new Error(message) } }).catch((e: unknown) => e)
      expect(String(error)).toContain('无法准备 TeX')
      expect(String(error)).not.toContain(SECRET)
      expect(await readdir(root)).toEqual([])
    })
  it('reconstructs even a stolen branded error instead of emitting its mutated message', async () => {
    const root = await folder()
    const stolen: unknown = await downloadTexAsset({ ...asset(), bytes: 0 }, root).catch((e: unknown) => e)
    expect(stolen).toBeInstanceOf(Error)
    if (!(stolen instanceof Error)) throw new Error('Expected an internal fixture error')
    stolen.message = `TeX password=${SECRET}`
    const error: unknown = await downloadTexAsset(asset(), root, { fetcher: async () => { throw stolen } }).catch((e: unknown) => e)
    expect(String(error)).toContain('固定资源记录无效')
    expect(String(error)).not.toContain(SECRET)
  })
  it.each([404, 500, 206, 201])('cancels an HTTP %s response body before opening partial output', async (status) => {
    const root = await folder(), fixture = activeResponse(status)
    await expect(downloadTexAsset(asset(), root, { fetcher: async () => fixture.response })).rejects.toThrow('下载失败')
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
  })
  it.each(['1', '-1', '1e2', 'nonsense'])('cancels mismatched/nondecimal content-length %s', async (length) => {
    const root = await folder(), fixture = activeResponse(200, { 'content-length': length })
    await expect(downloadTexAsset(asset(), root, { fetcher: async () => fixture.response })).rejects.toThrow('大小')
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
  })
  it('rejects unexpected HTTP content encoding and cancels its body', async () => {
    const fixture = activeResponse(200, { 'content-encoding': 'gzip' })
    await expect(downloadTexAsset(asset(), await folder(), { fetcher: async () => fixture.response })).rejects.toThrow('大小')
    expect(fixture.cancel).toHaveBeenCalledOnce()
  })
  it('cancels redirect bodies even when the target is forbidden', async () => {
    const fixture = activeResponse(302, { location: `https://user:${SECRET}@127.0.0.1/private` })
    const fetcher = vi.fn<AssetFetch>(async () => fixture.response)
    const error: unknown = await downloadTexAsset(asset(), await folder(), { fetcher }).catch((e: unknown) => e)
    expect(String(error)).toContain('未批准')
    expect(String(error)).not.toContain(SECRET)
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('bounds cleanup even when a provider cancellation promise never settles', async () => {
    const root = await folder(), started = deferred<void>()
    const stream = new ReadableStream<Uint8Array>({ cancel() { started.resolve(); return new Promise(() => undefined) } })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = downloadTexAsset(asset(), root, { fetcher: async () => new Response(stream, { status: 500 }) })
      .catch((e: unknown) => e)
    await started.promise
    await vi.advanceTimersByTimeAsync(1501)
    expect(String(await result)).toContain('无法确认关闭')
    expect(await readdir(root)).toEqual([])
  })
})

describe('bounded streaming, cache and cancellation', () => {
  it('writes only verified bytes, emits numeric progress and sends no ambient credentials', async () => {
    const root = await folder(), onProgress = vi.fn(() => { throw new Error(`TeX token=${SECRET}`) })
    const fetcher = vi.fn<AssetFetch>(async () => response())
    const path = await downloadTexAsset(asset(), root, { fetcher, onProgress })
    expect(await readFile(path, 'utf8')).toBe(TEXT)
    expect(onProgress).toHaveBeenCalledWith({ received: asset().bytes, total: asset().bytes })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(JSON.stringify(fetcher.mock.calls[0]?.[1].headers)).not.toMatch(/authorization|cookie/i)
    expect(await readdir(root)).toEqual([`${asset().sha256}.zip`])
    await downloadTexAsset(asset(), root, { fetcher })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('cancels oversized streaming output and removes its partial file', async () => {
    const root = await folder(), fixture = activeResponse(200, {}, `${TEXT}!`)
    await expect(downloadTexAsset(asset(), root, { fetcher: async () => fixture.response })).rejects.toThrow('上限')
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
  })
  it('rejects truncated and wrong-digest bytes without publishing a cache entry', async () => {
    for (const text of ['short', TEXT.toUpperCase()]) {
      const root = await folder()
      await expect(downloadTexAsset(asset(), root, { fetcher: async () => new Response(text) })).rejects.toThrow('SHA-256')
      expect(await readdir(root)).toEqual([])
    }
  })
  it('sanitizes stream failures carrying a forged internal prefix', async () => {
    const root = await folder()
    const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error(`TeX password=${SECRET}`) } })
    const error: unknown = await downloadTexAsset(asset(), root, { fetcher: async () => new Response(stream) }).catch((e: unknown) => e)
    expect(String(error)).not.toContain(SECRET)
    expect(String(error)).toContain('无法准备 TeX')
    expect(await readdir(root)).toEqual([])
  })
  it('aborts a pending reader, cancels its body, closes output and ignores the caller reason', async () => {
    const root = await folder(), started = deferred<void>(), abort = new AbortController(), cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull() { started.resolve() }, cancel }, { highWaterMark: 0 })
    const result = downloadTexAsset(asset(), root, { signal: abort.signal, fetcher: async () => new Response(stream) }).catch((e: unknown) => e)
    await started.promise
    abort.abort(`TeX password=${SECRET}`)
    expect(String(await result)).toContain('取消')
    expect(String(await result)).not.toContain(SECRET)
    expect(cancel).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
  })
  it('aborts an uncooperative fetch and cancels a response that arrives after cancellation', async () => {
    const root = await folder(), called = deferred<void>(), late = deferred<Response>(), abort = new AbortController()
    const result = downloadTexAsset(asset(), root, { signal: abort.signal,
      fetcher: async () => { called.resolve(); return late.promise } }).catch((e: unknown) => e)
    await called.promise
    abort.abort(SECRET)
    expect(String(await result)).toContain('取消')
    const fixture = activeResponse()
    late.resolve(fixture.response)
    await new Promise<void>(done => setImmediate(done))
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(await readdir(root)).toEqual([])
  })
  it('stops after progress cancellation and does not publish a cache entry', async () => {
    const root = await folder(), abort = new AbortController()
    await expect(downloadTexAsset(asset(), root, { signal: abort.signal, fetcher: async () => response(),
      onProgress: () => abort.abort() })).rejects.toThrow('取消')
    expect(await readdir(root)).toEqual([])
  })
  it('does not fetch on preabort or silently replace a corrupt cache', async () => {
    const root = await folder(), fetcher = vi.fn<AssetFetch>()
    await expect(downloadTexAsset(asset(), root, { signal: AbortSignal.abort(SECRET), fetcher })).rejects.toThrow('取消')
    const path = join(root, `${asset().sha256}.zip`)
    await writeFile(path, 'corrupt')
    await expect(downloadTexAsset(asset(), root, { fetcher })).rejects.toThrow('缓存损坏')
    expect(await readFile(path, 'utf8')).toBe('corrupt')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects invalid records and secret-bearing URLs without provider access', async () => {
    const fetcher = vi.fn<AssetFetch>()
    const inputs: TexAsset[] = [{ ...asset(), bytes: 512 * 1024 * 1024 + 1 },
      { ...asset(), archive: '../escape' as TexAsset['archive'] }, { ...asset(), url: `https://user:${SECRET}@github.com/file.zip` }]
    for (const input of inputs) {
      const error: unknown = await downloadTexAsset(input, await folder(), { fetcher }).catch((e: unknown) => e)
      expect(String(error)).not.toContain(SECRET)
      expect(error).toBeInstanceOf(Error)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})
