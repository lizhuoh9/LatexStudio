import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installationDigest } from './catalog'
import { assertPrivateDirectory, hashFile, TEX_ASSETS, TEX_RELEASE, type ManagedTexManifest } from './manifest'
import { findPackageSource, PACKAGE_TREE_DIR, readPackageManifest, verifyPackageTree } from './package-tree'
import type { PreparedTex } from './prepare'
import { createMacSandboxSession, findMacHelper, macHelperCandidates, macHelperResources, type MacSandboxSession } from '../sandbox/macos-session'
import { runMacSelfTest, type MacSelfTestResult } from '../sandbox/macos-selftest'
import { SessionNotStarted, type SandboxSession, type SandboxSessionOptions } from '../sandbox/session'

/**
 * macOS TeX resources. Unlike Windows nothing is unpacked into the user's data folder: the pinned TinyTeX tree and
 * the package tree ship inside the compile helper's own bundle (LatexStudioCompiler.app/Contents/Resources/tex-darwin
 * and tex-packages, links removed at staging), the one place its App Sandbox can read wherever the app is installed.
 * Release catalog values are application code, never read from the shipped files.
 *
 * The two pins were produced and accepted on a real Mac (docs/MACOS-COMPILE-PLAN.md, section 11). The tree pin is the
 * digest of the staged TinyTeX tree; the helper pin is the SHA-256 of resources/darwin/signed/latexstudio-compiler,
 * whose embedded signature in turn seals every file of both trees. Change them only together with those files
 * (resources/darwin/compiler/export-signed.sh). If either is null this platform reports "not enabled": no resource
 * is looked up and no helper is started.
 */
export const DARWIN_INSTALL_TREE_SHA256: string | null = '1b5c6f34e2aac7b5841692abafe4307e32ae38e7419aa9256b2bd9514f616a33'
export const MAC_HELPER_SHA256: string | null = '91d1e7af4d546d6514f3f354adecb470f3d3be6482abdd907cbd2672a59566b0'

export const DARWIN_TOOL_DIR = 'install/bin/universal-darwin'
export const DARWIN_TOOLS = Object.freeze({ pdflatex: `${DARWIN_TOOL_DIR}/pdftex`, xelatex: `${DARWIN_TOOL_DIR}/xetex`,
  xdvipdfmx: `${DARWIN_TOOL_DIR}/xdvipdfmx`, bibtex: `${DARWIN_TOOL_DIR}/bibtex` } as const)
const FORMATS: ReadonlyArray<string> = ['install/texmf-var/web2c/pdftex/pdflatex.fmt', 'install/texmf-var/web2c/xetex/xelatex.fmt']
const MACHO = new Set(['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const HASH = /^[a-f0-9]{64}$/
const TOOL_MAX = 256 * 1024 * 1024
/** verify() re-runs a refused check only when the refusal is older than this (it usually follows a lookup at once). */
const RECHECK_AFTER_MS = 5_000
/** A refusal is not permanent: a transient file error must not disable compiling until restart. */
const REFUSAL_TTL_MS = 60_000
const NOT_VERIFIED = 'macOS 原生隔离不可用，已拒绝编译：编译组件尚未通过本机自检'
/** Stands in for the per-install UUID of a Windows runtime; the bundled tree has exactly one identity. */
const BUNDLED_ID = '00000000-0000-4000-8000-000000000000'

export interface DarwinPins { tree: string | null; helper: string | null }
export function macCompileAccepted(pins: DarwinPins = { tree: DARWIN_INSTALL_TREE_SHA256, helper: MAC_HELPER_SHA256 }): boolean {
  return typeof pins.tree === 'string' && HASH.test(pins.tree) && typeof pins.helper === 'string' && HASH.test(pins.helper)
}
/** One per place the helper may be: the tree sits in that helper bundle's own Resources folder. */
export function darwinRuntimeCandidates(): string[] {
  return macHelperCandidates().map(helper => join(macHelperResources(helper), 'tex-darwin'))
}
/** The helper and the package tree are only ever the ones in the same bundle as the verified TeX tree. */
function helperBeside(root: string): string { return resolve(root, '..', '..', 'MacOS', 'latexstudio-compiler') }
function packagesBeside(root: string): string { return resolve(root, '..', 'tex-packages') }

async function machO(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || !(info.mode & 0o111)) throw new Error('TeX 引擎文件类型无效')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const magic = Buffer.alloc(4)
    const { bytesRead } = await file.read(magic, 0, 4, 0)
    if (bytesRead !== 4 || !MACHO.has(magic.toString('hex'))) throw new Error('TeX 引擎不是原生程序')
  } finally { await file.close() }
}
function raceSignal<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  signal.throwIfAborted()
  return new Promise<T>((done, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    task.then(done, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
async function verifiedPackages(root: string, signal?: AbortSignal): Promise<string> {
  const source = await findPackageSource([packagesBeside(root)])
  await verifyPackageTree(source, await readPackageManifest(source), signal)
  return join(source, PACKAGE_TREE_DIR)
}

type BoundSession = (options: SandboxSessionOptions) => Promise<MacSandboxSession>
export interface DarwinRuntimeDependencies {
  pins?: DarwinPins
  candidates?: () => string[]
  digest?: (installation: string, signal?: AbortSignal) => Promise<string>
  hash?: (path: string, signal?: AbortSignal) => Promise<string>
  executable?: (path: string) => Promise<void>
  /** Verifies the pinned package tree beside the TeX tree `root` and returns its texmf root. */
  packages?: (root: string, signal?: AbortSignal) => Promise<string>
  /** The helper of the bundle that holds the TeX tree `root`. */
  helper?: (root: string) => Promise<string>
  selfTest?: (runtimeRoot: string, dataRoot: string, session: BoundSession) => Promise<MacSelfTestResult>
  createSession?: (options: SandboxSessionOptions, bound: { helper: string; overlayRoot: string }) => Promise<MacSandboxSession>
  now?: () => number
}
interface Entry { runtime: PreparedTex; helper: string; overlayRoot: string; quick: string }

/**
 * Full check once per app run (tree digest, tools, package tree, helper bytes, then the real isolation self-test);
 * later lookups re-hash the tools, the formats and the helper and re-verify the package tree. Any mismatch drops the
 * entry and redoes everything. `failure` keeps the reason of the last refused check for the setup panel. The shared
 * full check carries no caller's signal: each caller only stops waiting when its own signal aborts.
 */
export class MacTrustedRuntime {
  failure: string | null = null
  private refusedAt: number | null = null
  private entry: Entry | null = null
  private pending: Promise<Entry | null> | null = null
  private readonly deps: Required<DarwinRuntimeDependencies>

  constructor(deps: DarwinRuntimeDependencies = {}) {
    this.deps = {
      pins: deps.pins ?? { tree: DARWIN_INSTALL_TREE_SHA256, helper: MAC_HELPER_SHA256 },
      candidates: deps.candidates ?? darwinRuntimeCandidates,
      digest: deps.digest ?? ((installation, signal) => installationDigest(installation, signal)),
      hash: deps.hash ?? ((path, signal) => hashFile(path, TOOL_MAX, signal)),
      executable: deps.executable ?? machO,
      packages: deps.packages ?? verifiedPackages,
      helper: deps.helper ?? (root => findMacHelper([helperBeside(root)])),
      selfTest: deps.selfTest ?? ((root, dataRoot, session) => runMacSelfTest(root, dataRoot, { createSession: session })),
      createSession: deps.createSession ?? ((options, bound) => createMacSandboxSession(options, bound)),
      now: deps.now ?? Date.now
    }
  }

  /** Explicit (re)check for the setup panel: resolves with the accepted runtime or throws the refusal reason. */
  async verify(dataRoot: string, signal?: AbortSignal): Promise<PreparedTex> {
    // A refusal that is only moments old (the lookup that led here) is reported as is instead of re-hashing ~1 GB.
    if (this.refusedAt !== null && this.deps.now() - this.refusedAt > RECHECK_AFTER_MS) this.refusedAt = null
    const runtime = await this.get(dataRoot, signal)
    if (!runtime) throw new Error(this.failure ?? '此版本没有随附 Mac 编译组件')
    return runtime
  }

  async get(dataRoot: string, signal?: AbortSignal): Promise<PreparedTex | null> {
    signal?.throwIfAborted()
    if (!macCompileAccepted(this.deps.pins)) return null
    // A refused check is not repeated on every lookup, but it does expire.
    if (this.refusedAt !== null && this.deps.now() - this.refusedAt <= REFUSAL_TTL_MS) return null
    const known = this.entry
    if (known) {
      try {
        if (await this.quick(known.runtime.root, known.helper, known.overlayRoot, signal) === known.quick) return known.runtime
      } catch { signal?.throwIfAborted() }
      if (this.entry === known) this.entry = null // never discard a newer entry another caller just verified
    }
    this.pending ??= this.full(resolve(dataRoot)).finally(() => { this.pending = null })
    return (await raceSignal(this.pending, signal))?.runtime ?? null
  }

  /** Bound to the verified helper and package tree; refuses (before starting anything) without an accepted check. */
  readonly createSession = async (options: SandboxSessionOptions): Promise<SandboxSession> => {
    const entry = this.entry
    if (!entry || resolve(options.runtimeRoot) !== entry.runtime.root) throw new SessionNotStarted(NOT_VERIFIED)
    return this.deps.createSession(options, { helper: entry.helper, overlayRoot: entry.overlayRoot })
  }

  private async quick(root: string, helper: string, overlayRoot: string, signal?: AbortSignal): Promise<string> {
    const values: string[] = []
    for (const path of [...Object.values(DARWIN_TOOLS), ...FORMATS]) values.push(await this.deps.hash(join(root, ...path.split('/')), signal))
    values.push(await this.deps.hash(helper, signal))
    if (await this.deps.packages(root, signal) !== overlayRoot) throw new Error('TeX 宏包目录内容不符；请重新准备')
    return values.join()
  }

  private async locate(): Promise<string> {
    for (const candidate of this.deps.candidates()) {
      try {
        const root = resolve(candidate)
        await assertPrivateDirectory(join(root, 'install'))
        return root
      } catch { /* try the next candidate */ }
    }
    throw new Error('此版本没有随附 Mac 编译组件')
  }

  private async full(dataRoot: string): Promise<Entry | null> {
    try {
      const root = await this.locate()
      if (await this.deps.digest(join(root, 'install')) !== this.deps.pins.tree) throw new Error('Mac 编译组件与软件内置的校验值不符')
      for (const path of Object.values(DARWIN_TOOLS)) await this.deps.executable(join(root, ...path.split('/')))
      const overlayRoot = await this.deps.packages(root)
      const helper = await this.deps.helper(root)
      if (await this.deps.hash(helper) !== this.deps.pins.helper) throw new Error('Mac 编译助手与软件内置的校验值不符')
      const quick = await this.quick(root, helper, overlayRoot)
      const tested = await this.deps.selfTest(root, dataRoot, options => this.deps.createSession(options, { helper, overlayRoot }))
      // Each engine is offered only if it actually ran inside the sandbox on this Mac.
      const runtime: PreparedTex = { root, manifest: await this.manifest(root), engines: tested.xelatex ? ['pdflatex', 'xelatex'] : ['pdflatex'] }
      const entry: Entry = { runtime, helper, overlayRoot, quick }
      this.entry = entry
      this.failure = null
      this.refusedAt = null
      return entry
    } catch (error) {
      this.entry = null
      this.failure = error instanceof Error ? error.message : 'Mac 编译组件检查失败'
      this.refusedAt = this.deps.now()
      return null
    }
  }

  private async manifest(root: string): Promise<ManagedTexManifest> {
    const binaryHashes: Record<string, string> = {}
    for (const path of [DARWIN_TOOLS.pdflatex, DARWIN_TOOLS.xelatex, DARWIN_TOOLS.xdvipdfmx])
      binaryHashes[path] = await this.deps.hash(join(root, ...path.split('/')))
    return { schema: 1, id: BUNDLED_ID, ready: true, platform: 'darwin', distribution: 'texlive', version: TEX_RELEASE,
      assetSha256: TEX_ASSETS.darwin.sha256, engines: { pdflatex: DARWIN_TOOLS.pdflatex, xelatex: DARWIN_TOOLS.xelatex },
      tools: { xdvipdfmx: DARWIN_TOOLS.xdvipdfmx }, binaryHashes, chineseResources: false }
  }
}

/** One process-wide instance shared by environment detection, the setup panel and every compiler. */
export const macTrustedRuntimes = new MacTrustedRuntime()
