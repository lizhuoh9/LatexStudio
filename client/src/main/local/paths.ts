import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { ProjectFile } from '../../shared/workspace-contracts'

export const LIMITS = Object.freeze({ text: 4 * 1024 * 1024, file: 32 * 1024 * 1024,
  project: 128 * 1024 * 1024, entries: 10_000, depth: 32, pdf: 32 * 1024 * 1024 })
const SKIP = new Set(['.git', 'node_modules', 'build', 'dist', 'out', 'release', 'coverage',
  '.next', '.cache', '.paperstudio', 'target'])
const OUTPUT = /\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|toc|lof|lot|nav|snm|vrb|fmt|base|mem|pool|cnf|fndb)$/i
const TEXT = /\.(?:tex|ltx|bib|sty|cls|bst|txt|md|csv|tsv|json|yaml|yml|toml|cfg|def|clo|dtx|ins|ist)$/i
const RESERVED = /^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

export function failure(message: string): Error { return new Error(message) }
export function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}
export function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function skipped(path: string): boolean {
  return path.split('/').some((part) => SKIP.has(part.toLowerCase()) || part.toLowerCase().startsWith('.paperstudio-')) || OUTPUT.test(path)
}

export function projectPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\uD800-\uDFFF]/u.test(value))
    throw failure('项目路径无效')
  if (/^[\\/]|[\\:%<>"|?*\x00-\x1f\x7f]/.test(value)) throw failure('项目路径必须是安全的相对路径')
  const parts = value.split('/')
  if (parts.length > LIMITS.depth || parts.some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || RESERVED.test(p)))
    throw failure('项目路径包含不安全的目录或文件名')
  if (skipped(value)) throw failure('不能访问版本数据、依赖或构建输出')
  return value
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength > LIMITS.text) throw failure('文本超过 4 MiB 限制')
  if (bytes.includes(0)) throw failure('文件不是 UTF-8 文本')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw failure('文件包含非法 UTF-8 编码，请先转换编码') }
}
export function encodeText(content: string): Buffer {
  if (typeof content !== 'string' || /[\uD800-\uDFFF]/u.test(content) || content.includes('\0'))
    throw failure('文本包含非法字符或编码')
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.length > LIMITS.text) throw failure('文本超过 4 MiB 限制')
  return bytes
}

export class SafeProject {
  readonly root: string
  private canonical = ''
  private identity: { ino: number; dev: number } | undefined
  constructor(root: string) {
    // Local disks and network shares (\\server\share\folder) are allowed; device namespaces (\\?\, \\.\) are not.
    if (!isAbsolute(root) || /^(?:\\\\|\/\/)[?.](?:\\|\/|$)/.test(root)) throw failure('项目根目录必须是本机磁盘或网络共享上的文件夹')
    this.root = resolve(root)
    if (this.root === parse(this.root).root) throw failure('不能将整个磁盘或整个网络共享作为项目，请选择其中的文件夹')
  }
  async initialize(): Promise<void> {
    const info = await lstat(this.root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('项目根目录必须是真实目录，不能是符号链接')
    this.canonical = await realpath(this.root)
    this.identity = { ino: info.ino, dev: info.dev }
  }
  async verifyRoot(): Promise<void> {
    if (!this.canonical) await this.initialize()
    const info = await lstat(this.root)
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(this.root) !== this.canonical ||
      info.ino !== this.identity?.ino || info.dev !== this.identity.dev)
      throw failure('项目目录已被替换或重定向，请重新打开项目')
  }
  async resolve(path: string, missingLeaf = false): Promise<string> {
    return (await this.locate(path, missingLeaf)).target
  }
  /** `info` is the leaf lstat that passed the no-link and containment checks; null only for an allowed missing leaf. */
  private async locate(path: string, missingLeaf = false): Promise<{ target: string; info: Stats | null }> {
    projectPath(path)
    await this.verifyRoot()
    let target = this.root, leaf: Stats | null = null
    const parts = path.split('/')
    for (const [index, part] of parts.entries()) {
      target = join(target, part)
      try {
        const info = await lstat(target)
        if (info.isSymbolicLink()) throw failure('不允许读取或写入符号链接')
        if (index < parts.length - 1 && !info.isDirectory()) throw failure('路径的上级不是目录')
        const canonical = await realpath(target)
        if (!inside(this.canonical, canonical)) throw failure('路径逃逸出项目目录')
        projectPath(relative(this.canonical, canonical).split(sep).join('/'))
        leaf = info
      } catch (error) {
        if (missingLeaf && index === parts.length - 1 && code(error) === 'ENOENT') return { target, info: null }
        throw error
      }
    }
    return { target, info: leaf }
  }
  async readBytes(path: string, limit = LIMITS.file): Promise<Buffer> {
    const target = await this.resolve(path)
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > limit) throw failure('文件类型无效或超过大小限制')
      const bytes = Buffer.alloc(before.size + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat()
      const current = await lstat(await this.resolve(path))
      if (bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.ino !== current.ino || before.dev !== current.dev || current.isSymbolicLink())
        throw failure('文件在读取期间发生变化，请重试')
      return bytes.subarray(0, bytesRead)
    } finally { await handle.close() }
  }
  /** GUI may request directories, while compilation/history keep the default file-only snapshot.
   * `observe` receives, for every listed entry, the verified lstat sample that classified it.
   */
  async list(includeDirectories = false, observe?: (file: ProjectFile, info: Stats) => void): Promise<ProjectFile[]> {
    await this.verifyRoot()
    const files: ProjectFile[] = []
    const budget = { entries: 0 }
    const add = (file: ProjectFile, info: Stats): void => { files.push(file); observe?.(file, info) }
    await this.walk('', add, budget, includeDirectories === true)
    return files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  }
  private async walk(folder: string, add: (file: ProjectFile, info: Stats) => void, budget: { entries: number }, includeDirectories: boolean): Promise<void> {
    if (folder.split('/').length > LIMITS.depth) throw failure('项目目录深度超过限制')
    const target = folder ? await this.resolve(folder) : this.root
    const directory = await opendir(target)
    for await (const entry of directory) {
      if (++budget.entries > LIMITS.entries) throw failure('项目超过 10000 个目录项限制')
      const path = folder ? `${folder}/${entry.name}` : entry.name
      if (skipped(path) || entry.isSymbolicLink()) continue
      projectPath(path)
      // The leaf lstat that just passed locate()'s checks classifies the entry; a second lstat adds no check.
      const info = (await this.locate(path)).info!
      if (info.isDirectory()) {
        if (includeDirectories) add({ path, kind: 'directory', size: 0 }, info)
        await this.walk(path, add, budget, includeDirectories)
      } else if (info.isFile()) add({ path, size: info.size, kind: TEXT.test(path) ? 'text' : 'binary' }, info)
      else throw failure('项目包含不支持的特殊文件')
    }
  }
}
