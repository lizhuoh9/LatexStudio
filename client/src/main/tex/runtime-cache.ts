import { join, resolve } from 'node:path'
import { hashFile, readManagedManifest } from './manifest'
import { verifyPatchedEngines } from './patched-engines'
import { findPackageSource, readPackageManifest, verifyPackageTree } from './package-tree'
import { findPreparedTex, type PreparedTex } from './prepare'

type Finder = (base: string, platform: 'win32', signal?: AbortSignal) => Promise<PreparedTex | null>
interface Quick {
  manifest(root: string, signal?: AbortSignal): Promise<unknown>
  engines(installation: string, signal?: AbortSignal): Promise<void>
  packages(installation: string, signal?: AbortSignal): Promise<void>
  hash(path: string, signal?: AbortSignal): Promise<string>
}
interface Entry { runtime: PreparedTex; formats: string[] }
/** Files the compiler passes explicitly; re-hashed on every lookup against the value seen at full verification. */
export const RUNTIME_FORMATS = Object.freeze({ pdflatex: 'install/texmf-var/web2c/pdftex/pdflatex.fmt',
  xelatex: 'install/texmf-var/web2c/xetex/xelatex.fmt' } as const)
const FORMAT_PATHS: ReadonlyArray<string> = Object.values(RUNTIME_FORMATS)
const FORMAT_MAX = 64 * 1024 * 1024

function raceSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  signal.throwIfAborted()
  return new Promise<T>((resolvePromise, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    task.then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * The whole-tree trust check hashes ~1 GB, so it runs once per app run and data root. Later lookups re-check the
 * manifest, the pinned engine bytes and the engine formats (a few MB). Other tree files are trusted from the full
 * check until restart (documented residual risk; they are only read inside the sandbox). A missing runtime is never
 * cached, and any failed quick check drops the entry and redoes the full check. The shared full check carries no
 * caller's signal: each caller only stops waiting when its own signal aborts.
 */
export class TrustedRuntimeCache {
  private readonly verified = new Map<string, Entry>()
  private readonly pending = new Map<string, Promise<Entry | null>>()

  constructor(private readonly find: Finder = findPreparedTex, private readonly quick: Quick = {
    manifest: readManagedManifest, engines: verifyPatchedEngines, hash: (path, signal) => hashFile(path, FORMAT_MAX, signal),
    packages: async (installation, signal) => verifyPackageTree(installation, await readPackageManifest(await findPackageSource()), signal) }) {}

  async get(dataRoot: string, signal?: AbortSignal): Promise<PreparedTex | null> {
    signal?.throwIfAborted()
    const base = resolve(dataRoot, 'tex', 'runtimes')
    const known = this.verified.get(base)
    if (known) {
      try {
        await this.recheck(known, signal)
        return known.runtime
      } catch {
        signal?.throwIfAborted()
        if (this.verified.get(base) === known) this.verified.delete(base)
      }
    }
    return (await raceSignal(this.full(base), signal))?.runtime ?? null
  }

  private async recheck(entry: Entry, signal?: AbortSignal): Promise<void> {
    await this.quick.manifest(entry.runtime.root, signal)
    await this.quick.engines(join(entry.runtime.root, 'install'), signal)
    await this.quick.packages(join(entry.runtime.root, 'install'), signal)
    if ((await this.formatHashes(entry.runtime.root, signal)).join() !== entry.formats.join())
      throw new Error('TeX 格式文件在本次运行中发生变化')
  }

  private async formatHashes(root: string, signal?: AbortSignal): Promise<string[]> {
    const hashes: string[] = []
    for (const path of FORMAT_PATHS) hashes.push(await this.quick.hash(join(root, ...path.split('/')), signal))
    return hashes
  }

  private full(base: string): Promise<Entry | null> {
    let task = this.pending.get(base)
    if (!task) {
      task = this.find(base, 'win32').then(async found => {
        if (!found) return null
        const entry = { runtime: found, formats: await this.formatHashes(found.root) }
        this.verified.set(base, entry)
        return entry
      }).finally(() => { this.pending.delete(base) })
      this.pending.set(base, task)
    }
    return task
  }
}

/** One process-wide cache shared by environment detection and every compiler instance. */
export const trustedRuntimes = new TrustedRuntimeCache()
