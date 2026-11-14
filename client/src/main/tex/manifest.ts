import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { enginePaths, isRuntimeId, RUNTIME_MANIFEST, validateManifest, type ManagedTexManifest } from './resource-policy'
export * from './resource-policy'
export function runtimeName(id: string = randomUUID()): string {
  if (!isRuntimeId(id)) throw new Error('TeX 资源标识无效')
  return `paperstudio-tex-${id}`
}
export function contained(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path))
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}
export async function assertPrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  let current = absolute
  while (current !== dirname(current)) {
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('TeX 资源目录不能经过链接或普通文件')
    current = dirname(current)
  }
  if ((await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw new Error('TeX 资源目录被重定向')
}
export async function hashFile(path: string, maximum = 512 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error('TeX 资源文件类型或大小无效')
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await file.stat()
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size) throw new Error('TeX 资源在校验时发生变化')
    const hash = createHash('sha256')
    const bytes = Buffer.alloc(128 * 1024)
    let total = 0
    for (;;) {
      signal?.throwIfAborted()
      const result = await file.read(bytes, 0, bytes.length, null)
      if (!result.bytesRead) break
      total += result.bytesRead
      if (total > maximum) throw new Error('TeX 资源超过大小限制')
      hash.update(bytes.subarray(0, result.bytesRead))
    }
    signal?.throwIfAborted()
    if (total !== before.size) throw new Error('TeX 资源在读取时发生变化')
    return hash.digest('hex')
  } finally { await file.close() }
}
export async function readManagedManifest(root: string, signal?: AbortSignal): Promise<ManagedTexManifest> {
  signal?.throwIfAborted()
  await assertPrivateDirectory(root)
  const file = resolve(root, RUNTIME_MANIFEST)
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('TeX 资源清单文件无效')
  const manifest = validateManifest(JSON.parse(await readFile(file, 'utf8')))
  if (root.split(/[\\/]/).pop() !== runtimeName(manifest.id)) throw new Error('TeX 资源目录标识不匹配')
  for (const [name, path] of Object.entries(enginePaths(manifest.platform))) {
    const absolute = await realpath(resolve(root, path))
    if (!contained(resolve(root, 'install'), absolute) || await hashFile(absolute, 512 * 1024 * 1024, signal) !== manifest.binaryHashes[path])
      throw new Error(`TeX ${name} 资源校验失败，请通过软件重新准备`)
  }
  signal?.throwIfAborted()
  return manifest
}
