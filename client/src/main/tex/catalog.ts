import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { assertPrivateDirectory, hashFile } from './manifest'
import { mapVerification } from './verification'
import { PATCHED_ENGINE_DIR, verifyPatchedEngines } from './patched-engines'
import { findPackageSource, PACKAGE_TREE_DIR, readPackageManifest, verifyPackageTree } from './package-tree'

/** Separately pinned overlays that are not part of the TinyTeX release tree. */
export const OVERLAY_DIRS: ReadonlyArray<string> = Object.freeze([PATCHED_ENGINE_DIR, PACKAGE_TREE_DIR])

/** Release catalog is application code, NOT a value supplied by the runtime's public manifest. */
// TinyTeX v2026.11 ZIP a13d14ba…5f69, same-fd verified extraction, 2026-11-12; developer catalog test passed.
export const WINDOWS_INSTALL_TREE_SHA256 = 'ec94461fbf7e9528aa931dac71ab94b9b907d1e43c4485b63bd2da963ed447a5'
interface Budget { entries: number; bytes: number }
async function files(root: string, directory: string, budget: Budget, signal?: AbortSignal, depth = 0,
  exclude: ReadonlyArray<string> = []): Promise<string[]> {
  if (depth > 64) throw new Error('TeX 资源目录超过深度限制')
  signal?.throwIfAborted()
  const result: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  budget.entries += entries.length
  if (budget.entries > 150000) throw new Error('TeX 资源超过文件数限制')
  const metadata = await mapVerification(entries, async entry => {
    const path = join(directory, entry.name)
    return { path, info: await lstat(path) }
  }, signal)
  for (const { path, info } of metadata) {
    signal?.throwIfAborted()
    if (exclude.includes(relative(root, path).split(sep).join('/'))) continue
    if (info.isSymbolicLink()) throw new Error('TeX 资源不能包含链接')
    if (info.isDirectory()) result.push(...await files(root, path, budget, signal, depth + 1, exclude))
    else if (info.isFile()) {
      budget.bytes += info.size
      if (info.size > 192 * 1024 * 1024 || budget.bytes > 4 * 1024 ** 3) throw new Error('TeX 资源超过大小限制')
      result.push(relative(root, path).split(sep).join('/'))
    } else throw new Error('TeX 资源包含特殊文件')
  }
  return result
}
/** Content + relative paths only: deterministic across installation directories and ACL changes.
 * `exclude` skips exactly these relative subtrees (the separately pinned overlays). */
export async function installationDigest(installation: string, signal?: AbortSignal,
  exclude: string | ReadonlyArray<string> = []): Promise<string> {
  const root = resolve(installation)
  await assertPrivateDirectory(root)
  const paths = await files(root, root, { entries: 0, bytes: 0 }, signal, 0, typeof exclude === 'string' ? [exclude] : exclude)
  paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const hash = createHash('sha256')
  const digests = await mapVerification(paths, async path => ({ path,
    digest: await hashFile(join(root, ...path.split('/')), 192 * 1024 * 1024, signal) }), signal)
  for (const { path, digest } of digests) {
    hash.update(path); hash.update('\0'); hash.update(digest); hash.update('\n')
  }
  signal?.throwIfAborted()
  return hash.digest('hex')
}
export async function verifyInstallationCatalog(root: string, signal?: AbortSignal): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(WINDOWS_INSTALL_TREE_SHA256)) throw new Error('此版本未附可信 TeX 发行目录，已拒绝使用资源')
  if (await installationDigest(join(root, 'install'), signal, OVERLAY_DIRS) !== WINDOWS_INSTALL_TREE_SHA256)
    throw new Error('TeX 安装树与软件内置发行目录不符；请重新准备，不会运行修改后的资源')
  await verifyPatchedEngines(join(root, 'install'), signal)
  await verifyPackageTree(join(root, 'install'), await readPackageManifest(await findPackageSource()), signal)
}
