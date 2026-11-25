import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { verifyInstallationCatalog } from './catalog'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { downloadTexAsset } from './download'
import { extractWindowsTexZip } from './archive'
import { findPatchedEngineSource, installPatchedEngines } from './patched-engines'
import { findPackageSource, installPackageTree } from './package-tree'
import { assertPrivateDirectory, enginePaths, hashFile, readManagedManifest, RUNTIME_MANIFEST, runtimeName,
  TEX_ASSETS, TEX_RELEASE, type ManagedTexManifest } from './manifest'

export interface TexPreparationProgress {
  phase: 'checking' | 'downloading' | 'extracting' | 'verifying' | 'prepared'
  completed: number
  total: number
}
export interface PreparedTex {
  root: string
  manifest: ManagedTexManifest
  /** Engines this runtime may run. Absent means every supported engine (the Windows runtime). */
  engines?: ReadonlyArray<'pdflatex' | 'xelatex'>
}
export interface TexPreparationOptions {
  platform?: NodeJS.Platform
  signal?: AbortSignal
  onProgress?: (state: TexPreparationProgress) => void
  /** Directory holding the pinned patched engines; defaults to the packaged resources. */
  engineSource?: string
  /** Directory holding the pinned TeX packages; defaults to the packaged resources. */
  packageSource?: string
  /** Main-only fixed local bundle. When supplied, failure never falls back to a network download. */
  archivePath?: string
}
function publish(listener: ((state: TexPreparationProgress) => void) | undefined, state: TexPreparationProgress): void {
  try { listener?.(state) } catch { /* A renderer cannot authorize or invalidate resources. */ }
}
export async function findPreparedTex(base: string, platform: 'win32' | 'darwin', signal?: AbortSignal): Promise<PreparedTex | null> {
  signal?.throwIfAborted()
  let directories
  try { await assertPrivateDirectory(base); directories = await readdir(base, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const owned = directories.filter(entry => entry.isDirectory() && /^paperstudio-tex-[a-f0-9-]{36}$/.test(entry.name))
  if (owned.length > 20) throw new Error('TeX 资源版本过多，请通过软件清理旧资源后重试')
  for (const entry of owned) {
    const root = join(base, entry.name)
    try {
      signal?.throwIfAborted()
      const manifest = await readManagedManifest(root, signal)
      if (manifest.platform !== platform) continue
      if (platform !== 'win32') continue // No accepted macOS release catalog / real-machine gate yet.
      await verifyInstallationCatalog(root, signal)
      signal?.throwIfAborted()
      return { root, manifest }
    } catch {
      signal?.throwIfAborted()
      // Invalid/incomplete versions are never reused or deleted. A new UUID can repair resources.
    }
  }
  return null
}
async function fixedFile(path: string, maximum: number): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 || info.size > maximum)
    throw new Error('TeX 格式资源缺失或无效；不能显示为离线就绪')
}
async function resourceManifest(root: string, id: string, signal?: AbortSignal): Promise<ManagedTexManifest> {
  const paths = enginePaths('win32')
  const binaryHashes: Record<string, string> = {}
  for (const path of Object.values(paths)) {
    const executable = join(root, path)
    signal?.throwIfAborted()
    const file = await open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat(), header = Buffer.alloc(2)
      const result = await file.read(header, 0, header.length, 0)
      if (!info.isFile() || info.size > 128 * 1024 * 1024 || result.bytesRead !== 2 || header.toString('ascii') !== 'MZ')
        throw new Error('TeX 资源不含审核布局中的原生 Windows 引擎')
    } finally { await file.close() }
    binaryHashes[path] = await hashFile(executable, 128 * 1024 * 1024, signal)
  }
  await fixedFile(join(root, 'install/texmf-var/web2c/pdftex/pdflatex.fmt'), 64 * 1024 * 1024)
  await fixedFile(join(root, 'install/texmf-var/web2c/xetex/xelatex.fmt'), 64 * 1024 * 1024)
  return { schema: 1, id, ready: true, platform: 'win32', distribution: 'texlive', version: TEX_RELEASE,
    assetSha256: TEX_ASSETS.win32.sha256, engines: { pdflatex: paths.pdflatex, xelatex: paths.xelatex },
    tools: { xdvipdfmx: paths.xdvipdfmx }, binaryHashes, chineseResources: false }
}
async function archiveForPreparation(path: string | undefined, cache: string, options: TexPreparationOptions): Promise<string> {
  options.signal?.throwIfAborted()
  const asset = TEX_ASSETS.win32
  if (path === undefined) return downloadTexAsset(asset, cache, { signal: options.signal,
    onProgress: state => publish(options.onProgress, { phase: 'downloading', completed: state.received, total: state.total }) })
  await assertPrivateDirectory(dirname(path))
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== asset.bytes)
    throw new Error('TeX 内置离线 ZIP 类型或固定大小不符；不会改为联网下载')
  options.signal?.throwIfAborted()
  return path // extractWindowsTexZip rechecks the pinned digest on the same fd used to extract.
}
/** Prepares resources only, never enables user TeX or runs any downloaded executable/installer. */
export async function prepareNativeTex(dataRoot: string, options: TexPreparationOptions = {}): Promise<PreparedTex> {
  const platform = options.platform ?? process.platform
  const archivePath = options.archivePath
  if (archivePath !== undefined && (typeof archivePath !== 'string' || !isAbsolute(archivePath)))
    throw new Error('TeX 内置资源路径无效；不会改为联网下载')
  if (platform !== 'win32') throw new Error('此资源准备路径目前仅在 Windows 实现；macOS 须完成原生解包和实机验收后启用')
  const base = resolve(dataRoot, 'tex', 'runtimes')
  const cache = resolve(dataRoot, 'tex', 'downloads')
  options.signal?.throwIfAborted()
  await mkdir(base, { recursive: true, mode: 0o700 })
  await assertPrivateDirectory(base)
  publish(options.onProgress, { phase: 'checking', completed: 0, total: 1 })
  const existing = await findPreparedTex(base, platform, options.signal)
  if (existing) return existing
  const engineSource = options.engineSource ?? await findPatchedEngineSource()
  const packageSource = options.packageSource ?? await findPackageSource()
  const asset = TEX_ASSETS[platform]
  const space = await statfs(base)
  if (space.bavail * space.bsize < asset.bytes * 8 + 512 * 1024 * 1024) throw new Error('TeX 准备空间不足，请至少预留约 3 GB 可用空间')
  const archive = await archiveForPreparation(archivePath, cache, options)
  const id = randomUUID(), root = join(base, runtimeName(id))
  await mkdir(root, { mode: 0o700 })
  try {
    await extractWindowsTexZip(archive, join(root, 'install'), { expectedSha256: asset.sha256, signal: options.signal,
      onProgress: state => publish(options.onProgress, { phase: 'extracting', completed: state.entries, total: 0 }) })
    options.signal?.throwIfAborted()
    publish(options.onProgress, { phase: 'verifying', completed: 0, total: 1 })
    await installPatchedEngines(join(root, 'install'), engineSource, options.signal)
    await installPackageTree(join(root, 'install'), packageSource, options.signal)
    const manifest = await resourceManifest(root, id, options.signal)
    await verifyInstallationCatalog(root, options.signal)
    options.signal?.throwIfAborted()
    await writeFile(join(root, RUNTIME_MANIFEST), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    await readManagedManifest(root, options.signal)
    options.signal?.throwIfAborted()
    publish(options.onProgress, { phase: 'prepared', completed: 1, total: 1 })
    return { root, manifest }
  } catch (error) {
    // A failed rollback must not hide the original cause; without a manifest the leftover is never reused.
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    throw error instanceof Error && error.message.startsWith('TeX ') ? error : new Error('TeX 资源准备失败；未启用不完整资源，可重新准备')
  }
}
