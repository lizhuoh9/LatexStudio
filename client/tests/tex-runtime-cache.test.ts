import { describe, expect, it, vi } from 'vitest'
import { TrustedRuntimeCache } from '../src/main/tex/runtime-cache'
import type { PreparedTex } from '../src/main/tex/prepare'

const runtime = { root: 'C:\\data\\tex\\runtimes\\paperstudio-tex-x', manifest: {} } as unknown as PreparedTex
function quickChecks(format = 'f'.repeat(64)) {
  return { manifest: vi.fn(async () => undefined), engines: vi.fn(async () => undefined), hash: vi.fn(async () => format),
    packages: vi.fn(async () => undefined) }
}
function cache(find: ReturnType<typeof vi.fn>, quick = quickChecks()) {
  return { cache: new TrustedRuntimeCache(find as never, quick), quick }
}

describe('trusted runtime cache', () => {
  it('does the whole-tree check once, then only the quick manifest and engine checks', async () => {
    const find = vi.fn(async () => runtime), { cache: c, quick } = cache(find)
    expect(await c.get('C:\\data')).toBe(runtime)
    expect(await c.get('C:\\data')).toBe(runtime)
    expect(find).toHaveBeenCalledTimes(1)
    expect(quick.manifest).toHaveBeenCalledTimes(1); expect(quick.engines).toHaveBeenCalledTimes(1)
  })
  it('never caches a missing runtime, so later preparation is found', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(runtime), { cache: c } = cache(find)
    expect(await c.get('C:\\data')).toBeNull()
    expect(await c.get('C:\\data')).toBe(runtime)
  })
  it('drops the entry and re-verifies the whole tree when a quick check fails', async () => {
    const find = vi.fn().mockResolvedValueOnce(runtime).mockResolvedValueOnce(null)
    const quick = { ...quickChecks(), engines: vi.fn(async () => { throw new Error('tampered') }) }
    const { cache: c } = cache(find, quick)
    expect(await c.get('C:\\data')).toBe(runtime)
    expect(await c.get('C:\\data')).toBeNull()
    expect(find).toHaveBeenCalledTimes(2)
  })
  it('re-verifies the whole tree when the pdflatex format changes during the run', async () => {
    const find = vi.fn().mockResolvedValueOnce(runtime).mockResolvedValueOnce(null)
    const quick = quickChecks()
    const { cache: c } = cache(find, quick)
    expect(await c.get('C:\\data')).toBe(runtime)
    quick.hash.mockResolvedValue('0'.repeat(64))
    expect(await c.get('C:\\data')).toBeNull()
    expect(find).toHaveBeenCalledTimes(2)
  })
  it('lets one waiter stop waiting without aborting the shared check for others', async () => {
    let release!: (value: PreparedTex) => void
    const find = vi.fn(() => new Promise<PreparedTex>(done => { release = done })), { cache: c } = cache(find)
    const abort = new AbortController()
    const first = c.get('C:\\data', abort.signal), second = c.get('C:\\data')
    abort.abort('canceled')
    await expect(first).rejects.toBe('canceled')
    release(runtime)
    expect(await second).toBe(runtime)
    expect(find).toHaveBeenCalledTimes(1)
    expect(find.mock.calls[0]).toHaveLength(2) // no caller signal is passed to the shared check
  })
  it('shares one in-flight whole-tree check and honours cancellation', async () => {
    let release!: (value: PreparedTex) => void
    const find = vi.fn(() => new Promise<PreparedTex>(done => { release = done })), { cache: c } = cache(find)
    const both = Promise.all([c.get('C:\\data'), c.get('C:\\data')])
    release(runtime)
    expect(await both).toEqual([runtime, runtime])
    expect(find).toHaveBeenCalledTimes(1)
    await expect(c.get('C:\\data', AbortSignal.abort())).rejects.toThrow()
  })
})
