import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseSyncTex, type SyncTexData } from '../../shared/synctex'
import { code, decodeText, failure, inside, LIMITS, SafeProject } from './paths'

export function checkCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw failure(signal.reason === 'timeout' ? '编译超过 120 秒限制' : '编译已取消')
}
async function predictedRealpath(path: string): Promise<string> {
  let ancestor = path
  while (true) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)) }
    catch (error) {
      if (code(error) !== 'ENOENT' || dirname(ancestor) === ancestor) throw error
      ancestor = dirname(ancestor)
    }
  }
}
export async function createBuild(root: string, buildRoot: string): Promise<string> {
  if (!isAbsolute(buildRoot) || /^\\\\|^\/\//.test(buildRoot) || resolve(buildRoot) === parse(resolve(buildRoot)).root)
    throw failure('编译缓存必须是本机非磁盘根目录的绝对路径')
  const source = await realpath(root)
  const proposed = await predictedRealpath(resolve(buildRoot))
  if (inside(source, proposed) || inside(proposed, source)) throw failure('编译缓存与源项目必须相互独立')
  await mkdir(buildRoot, { recursive: true, mode: 0o700 })
  const info = await lstat(buildRoot)
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(buildRoot) !== proposed)
    throw failure('编译缓存目录不能是符号链接或发生重定向')
  return mkdtemp(join(proposed, 'paperstudio-'))
}
export async function copyProject(project: SafeProject, destination: string, signal: AbortSignal): Promise<void> {
  await mkdir(destination, { mode: 0o700 })
  let total = 0
  for (const file of await project.list()) {
    checkCanceled(signal)
    if (file.size > LIMITS.file) throw failure('项目文件超过 32 MiB 编译限制')
    total += file.size
    if (total > LIMITS.project) throw failure('项目超过 128 MiB 编译限制')
    const bytes = await project.readBytes(file.path)
    if (file.kind === 'text') decodeText(bytes)
    total += bytes.length - file.size
    if (total > LIMITS.project) throw failure('项目在复制期间增长到大小限制之外')
    const target = join(destination, file.path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
  }
}
async function diskUsage(folder: string, budget: { entries: number; bytes: number }, depth = 0): Promise<void> {
  if (depth > LIMITS.depth + 4) throw failure('编译输出目录深度超过限制')
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (++budget.entries > LIMITS.entries + 200) throw failure('编译输出文件数超过限制')
    const path = join(folder, entry.name)
    let info
    try { info = await lstat(path) } catch (error) {
      if (code(error) === 'ENOENT') continue // TeX may delete temporary files while the scan runs.
      throw error
    }
    if (info.isSymbolicLink()) throw failure('编译输出包含符号链接')
    if (info.isDirectory()) await diskUsage(path, budget, depth + 1)
    else {
      budget.bytes += info.size
      if (info.size > LIMITS.file || budget.bytes > LIMITS.project + 64 * 1024 * 1024)
        throw failure('编译输出超过大小限制')
    }
  }
}
export function monitorBuild(folder: string, controller: AbortController): () => Promise<void> {
  let pending: Promise<void> | undefined
  const timer = setInterval(() => {
    if (pending || controller.signal.aborted) return
    pending = diskUsage(folder, { entries: 0, bytes: 0 }).catch((error: unknown) => {
      // Only fixed policy messages reach the log; raw filesystem errors would expose local paths.
      controller.abort(error instanceof Error && !code(error) ? error.message : '无法检查编译输出大小')
    }).finally(() => { pending = undefined })
  }, 500)
  timer.unref()
  return async () => { clearInterval(timer); await pending }
}
export async function removeBuild(folder: string): Promise<void> {
  if ((await lstat(folder)).isSymbolicLink() || await realpath(folder) !== folder)
    throw failure('编译临时目录已被重定向，未执行清理')
  await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** Reads the fixed output PDF only if it is a bounded regular file inside the output folder and looks complete. */
export async function loadPdf(output: string): Promise<Uint8Array> {
  const path = join(output, 'paperstudio.pdf')
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > LIMITS.pdf || !inside(output, await realpath(path)))
    throw failure('生成的 PDF 不安全或超过 32 MiB 限制')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = Buffer.alloc(info.size + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== info.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-' ||
      !bytes.subarray(Math.max(0, bytesRead - 1024), bytesRead).includes(Buffer.from('%%EOF')))
      throw failure('TeX 未生成完整有效的 PDF')
    return Uint8Array.from(bytes.subarray(0, bytesRead))
  } finally { await handle.close() }
}

/** Reads optional SyncTeX output safely with bounded size and gzip output cap; never blocks a valid PDF compile. */
export async function loadSynctex(output: string, sourceRoot: string): Promise<SyncTexData | null> {
  for (const [name, compressed] of [['paperstudio.synctex.gz', true], ['paperstudio.synctex', false]] as const) {
    const path = join(output, name)
    let info
    try { info = await lstat(path) } catch (error) {
      if (code(error) === 'ENOENT') continue
      return null
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > LIMITS.pdf) return null
    try {
      if (!inside(output, await realpath(path))) return null
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const bytes = Buffer.alloc(info.size + 1)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== info.size) return null
        const raw = bytes.subarray(0, bytesRead)
        const text = (compressed ? gunzipSync(raw, { maxOutputLength: LIMITS.pdf }) : raw).toString('utf8')
        return parseSyncTex(text, sourceRoot)
      } finally { await handle.close() }
    } catch { return null }
  }
  return null
}
