import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installationDigest } from '../src/main/tex/catalog'
import { hashFile } from '../src/main/tex/manifest'
import { mapVerification, VERIFICATION_CONCURRENCY } from '../src/main/tex/verification'

const roots: string[] = []
async function folder() { const root = await mkdtemp(join(await realpath(tmpdir()), 'paperstudio-verify-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function sequential(root: string): Promise<string> {
  const names: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry), info = await lstat(path)
      if (info.isDirectory()) await walk(path)
      else names.push(relative(root, path).split(sep).join('/'))
    }
  }
  await walk(root); names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const hash = createHash('sha256')
  for (const name of names) hash.update(name).update('\0').update(await hashFile(join(root, name), 192 * 1024 ** 2)).update('\n')
  return hash.digest('hex')
}

describe('bounded full-byte verification, never a persistent ready/stat cache', () => {
  it('bounds active work and keeps input order even when I/O completes backwards', async () => {
    const gates = Array.from({ length: 9 }, () => deferred<number>()), started: number[] = []
    const task = mapVerification(gates, async (gate) => { started.push(gates.indexOf(gate)); return gate.promise })
    await vi.waitFor(() => expect(started).toHaveLength(VERIFICATION_CONCURRENCY))
    for (let index = 3; index >= 0; index--) gates[index]!.resolve(index)
    await vi.waitFor(() => expect(started).toHaveLength(8))
    for (let index = 7; index >= 4; index--) gates[index]!.resolve(index)
    await vi.waitFor(() => expect(started).toHaveLength(9)); gates[8]!.resolve(8)
    expect(await task).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('drains siblings after a synchronous failure and never starts another batch', async () => {
    const gate = deferred<void>(), work = vi.fn((index: number) => { if (index === 0) throw new Error('failed'); return gate.promise })
    let ended = false
    const task = mapVerification([0, 1, 2, 3, 4], work).catch(error => { ended = true; return error })
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(4)); expect(ended).toBe(false)
    gate.resolve(); expect((await task).message).toBe('failed'); expect(work).toHaveBeenCalledTimes(4)
  })
  it('drains an aborted batch before rejection and does not launch more reads', async () => {
    const gate = deferred<void>(), abort = new AbortController(), work = vi.fn(() => gate.promise)
    let ended = false
    const task = mapVerification([0, 1, 2, 3, 4], work, abort.signal).catch(() => { ended = true })
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(4)); abort.abort(); await Promise.resolve()
    expect(ended).toBe(false); gate.resolve(); await task; expect(ended).toBe(true); expect(work).toHaveBeenCalledTimes(4)
    await expect(mapVerification([], work, AbortSignal.abort())).rejects.toThrow()
  })
  it('produces the exact old ordered digest and still reads same-size, restored-mtime changes', async () => {
    const root = await folder(); await mkdir(join(root, 'nested'))
    for (const name of ['z', 'a', '中文', 'nested/b']) await writeFile(join(root, name), 'original')
    const before = await installationDigest(root); expect(before).toBe(await sequential(root))
    const file = join(root, 'a'), metadata = await lstat(file)
    await writeFile(file, 'tampered'); await utimes(file, metadata.atime, metadata.mtime)
    expect(await installationDigest(root)).not.toBe(before)
  })
})

it.skipIf(process.env.PAPERSTUDIO_VERIFY_BENCH !== '1')('measures serial versus bounded verification on owned fixture files only', async () => {
  const root = await folder(), small = Buffer.alloc(4096, 42), large = Buffer.alloc(4 * 1024 ** 2, 43)
  for (let index = 0; index < 8; index++) await mkdir(join(root, 'd' + index))
  for (let index = 0; index < 1024; index++) await writeFile(join(root, 'd' + index % 8, String(index)), small)
  for (let index = 0; index < 8; index++) await writeFile(join(root, 'large' + index), large)
  const timings: { serialMs: number; boundedMs: number }[] = []
  for (let index = 0; index < 3; index++) {
    let expected = '', actual = '', serialMs = 0, boundedMs = 0
    const serial = async () => { const start = performance.now(); expected = await sequential(root); serialMs = performance.now() - start }
    const bounded = async () => { const start = performance.now(); actual = await installationDigest(root); boundedMs = performance.now() - start }
    if (index % 2) { await bounded(); await serial() } else { await serial(); await bounded() }
    expect(actual).toBe(expected); timings.push({ serialMs: Math.round(serialMs), boundedMs: Math.round(boundedMs) })
  }
  const result = { kind: 'owned-fixture-byte-verification', platform: process.platform, files: 1032, bytes: 36 * 1024 ** 2,
    concurrency: VERIFICATION_CONCURRENCY, timings, realUserRuntimeMeasured: false, nativeCompileExecuted: false }
  await mkdir('release', { recursive: true }); await writeFile('release/startup-verification-benchmark.json', JSON.stringify(result, null, 2) + '\n')
  console.log('VERIFICATION_BENCH=' + JSON.stringify(result))
}, 60_000)
