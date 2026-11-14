import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { assertPrivateDirectory, TEX_ASSETS } from './manifest'

const INVALID = 'TeX 内置离线资源缺失或校验不符；请重新安装完整软件，不会改为联网下载'

/** Fixed application locations only. No renderer path, PATH lookup, user cache or network fallback. */
export function bundledTexArchiveCandidates(): string[] {
  const name = `${TEX_ASSETS.win32.sha256}.zip`
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [...new Set([resources ? join(resources, 'tex-runtime', name) : '',
    resolve(__dirname, '../../resources/tex-runtime', name),
    resolve(__dirname, '../../../resources/tex-runtime', name),
    resolve(process.cwd(), 'resources/tex-runtime', name)].filter(Boolean))]
}
function sameFile(before: Stats, after: Stats): boolean {
  return after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && before.dev === after.dev &&
    before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}
async function verifyArchive(path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const asset = TEX_ASSETS.win32, directory = dirname(path)
  await assertPrivateDirectory(directory)
  const parent = await lstat(directory), before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== asset.bytes) throw new Error(INVALID)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!sameFile(before, await file.stat())) throw new Error(INVALID)
    const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
    let total = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, asset.bytes - total + 1), total)
      if (!bytesRead) break
      if ((total += bytesRead) > asset.bytes) throw new Error(INVALID)
      hash.update(buffer.subarray(0, bytesRead))
    }
    signal?.throwIfAborted()
    const after = await lstat(directory)
    if (total !== asset.bytes || hash.digest('hex') !== asset.sha256 || !sameFile(before, await file.stat()) ||
      !sameFile(before, await lstat(path)) || parent.dev !== after.dev || parent.ino !== after.ino) throw new Error(INVALID)
    await assertPrivateDirectory(directory)
    signal?.throwIfAborted()
  } finally { await file.close() }
}
/** Missing candidates may be skipped; an existing invalid payload fails closed rather than hiding a broken install. */
export async function findBundledTexArchive(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (process.platform !== 'win32') throw new Error('TeX 离线资源目前仅支持已验收的 Windows 平台；macOS 尚未启用')
  for (const candidate of bundledTexArchiveCandidates()) {
    signal?.throwIfAborted()
    try { await lstat(candidate) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error(INVALID) }
    try { await verifyArchive(candidate, signal); return candidate }
    catch { signal?.throwIfAborted(); throw new Error(INVALID) }
  }
  signal?.throwIfAborted()
  throw new Error(INVALID)
}
