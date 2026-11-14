import fs from 'node:fs'
import git from 'isomorphic-git'
import type { RevisionDetail, RevisionEntry } from '../../shared/workspace-contracts'
import { decodeText, digest, LIMITS, projectPath, SafeProject } from '../local/paths'
import { hasRepository, headOid } from './files'
import { publicText } from './metadata'
import { excluded, GitHubError, safePath } from './policy'

const MAX_COMMITS = 100
const MAX_ENTRIES = 200
const TEXT = /\.(?:tex|ltx|bib|sty|cls|bst|txt|md|csv|tsv|json|yaml|yml|toml|cfg|def|clo|dtx|ins|ist)$/i
const OID = /^[a-f0-9]{40}$/
type Commit = Awaited<ReturnType<typeof git.readCommit>>
interface Budget { trees: number; bytes: number }
interface Context { project: SafeProject; commits: Commit[]; trees: Map<string, Map<string, string>>; budget: Budget }

function allowed(root: string, path: string): boolean {
  try { projectPath(path); safePath(root, path); return !excluded(path) }
  catch { return false }
}
function entryId(oid: string, path: string): string { return `git:${oid}:${Buffer.from(path, 'utf8').toString('hex')}` }
function parseId(root: string, id: string): { oid: string; path: string } {
  if (typeof id !== 'string' || id.length > 8250) throw new GitHubError('Git 文件版本标识无效。')
  const match = /^git:([a-f0-9]{40}):([a-f0-9]+)$/.exec(id)
  if (!match || match[2]!.length % 2) throw new GitHubError('Git 文件版本标识无效。')
  const bytes = Buffer.from(match[2]!, 'hex')
  const path = decodeText(bytes)
  if (Buffer.from(path, 'utf8').toString('hex') !== match[2] || !allowed(root, path) || !TEXT.test(path))
    throw new GitHubError('Git 文件版本路径不安全或不是支持的文本。')
  return { oid: match[1]!, path }
}

/** Read-only view of existing Git commits; authors are commit authors, not verified editors.
 * No init, index update, checkout, shell or network. Blob limits apply AFTER isomorphic-git
 * unpacks an object: this adapter is not a hard decompression/memory isolation boundary.
 */
export class GitVersions {
  constructor(private readonly root: string) {}

  async list(): Promise<RevisionEntry[]> {
    const context = await this.context()
    if (!context) return []
    const current = new Set((await context.project.list()).filter(file => file.kind === 'text' && allowed(this.root, file.path)).map(file => file.path))
    const entries: RevisionEntry[] = []
    for (const commit of context.commits) {
      const after = await this.tree(commit.commit.tree, context)
      const before = await this.parentTree(commit, context)
      for (const [path, oid] of after) {
        if (entries.length === MAX_ENTRIES) return this.sorted(entries)
        if (!current.has(path) || oid === before.get(path)) continue
        const detail = await this.readDetail(commit, path, after, before, context)
        if (detail) entries.push(detail.entry)
        if (entries.length === MAX_ENTRIES) return this.sorted(entries)
      }
    }
    return this.sorted(entries)
  }

  async detail(id: string): Promise<RevisionDetail> {
    const { oid, path } = parseId(this.root, id)
    const context = await this.context()
    // Membership is checked BEFORE looking up any object named by the caller.
    const commit = context?.commits.find(item => item.oid === oid)
    if (!context || !commit) throw new GitHubError('Git 文件版本不在当前 HEAD 的有限历史中。')
    const after = await this.tree(commit.commit.tree, context)
    const before = await this.parentTree(commit, context)
    if (!after.has(path) || after.get(path) === before.get(path)) throw new GitHubError('此提交没有可恢复的该文件版本。')
    const detail = await this.readDetail(commit, path, after, before, context)
    if (!detail) throw new GitHubError('此版本不是可恢复的现存 UTF-8 文本，或超过读取限额。')
    return detail
  }

  private sorted(entries: RevisionEntry[]): RevisionEntry[] {
    return entries.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
  }

  private async context(): Promise<Context | null> {
    const project = new SafeProject(this.root)
    await project.initialize()
    if (!await hasRepository(this.root)) return null
    const head = await headOid(this.root)
    if (!head) return null
    const commits: Commit[] = [], queue = [head], seen = new Set<string>()
    while (queue.length && commits.length < MAX_COMMITS) {
      const oid = queue.shift()!
      if (seen.has(oid)) continue
      if (!OID.test(oid)) throw new GitHubError('Git 历史包含无效对象标识。')
      seen.add(oid)
      const commit = await git.readCommit({ fs, dir: this.root, oid })
      commits.push(commit)
      for (const parent of commit.commit.parent) {
        if (queue.length + seen.size >= MAX_COMMITS) break
        if (!seen.has(parent) && !queue.includes(parent)) queue.push(parent)
      }
    }
    commits.sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp || a.oid.localeCompare(b.oid))
    return { project, commits, trees: new Map(), budget: { trees: 0, bytes: 0 } }
  }

  private async parentTree(commit: Commit, context: Context): Promise<Map<string, string>> {
    const oid = commit.commit.parent[0]
    if (!oid) return new Map()
    // Only the first parent is used for merge comparisons; the boundary parent is
    // reached through a validated commit, never through a caller-provided object ID.
    const parent = context.commits.find(item => item.oid === oid) ?? await git.readCommit({ fs, dir: this.root, oid })
    return this.tree(parent.commit.tree, context)
  }

  private async tree(oid: string, context: Context): Promise<Map<string, string>> {
    const cached = context.trees.get(oid)
    if (cached) return cached
    const result = new Map<string, string>()
    await this.walk(oid, '', 0, result, context)
    context.trees.set(oid, result)
    return result
  }

  private async walk(oid: string, prefix: string, depth: number, result: Map<string, string>, context: Context): Promise<void> {
    if (depth > LIMITS.depth) throw new GitHubError('Git 历史目录深度超过限制。')
    const { tree } = await git.readTree({ fs, dir: this.root, oid })
    const names = new Set<string>()
    for (const item of tree) {
      if (++context.budget.trees > LIMITS.entries) throw new GitHubError('Git 历史遍历超过 10000 个目录项限制。')
      const path = prefix ? `${prefix}/${item.path}` : item.path
      if (item.path.includes('/') || !allowed(this.root, path)) continue
      const normalized = item.path.toLowerCase()
      if (names.has(normalized)) throw new GitHubError('Git 历史文件名在当前平台不唯一。')
      names.add(normalized)
      if (item.type === 'tree' && item.mode === '040000') await this.walk(item.oid, path, depth + 1, result, context)
      else if (item.type === 'blob' && ['100644', '100755'].includes(item.mode) && TEXT.test(path)) result.set(path, item.oid)
    }
  }

  private async blob(oid: string, context: Context): Promise<Buffer | null> {
    const { blob } = await git.readBlob({ fs, dir: this.root, oid })
    // Checking byteLength before decoding bounds accepted text and aggregate work,
    // but the library has already materialized/unpacked this particular object.
    this.charge(blob.byteLength, context)
    if (blob.byteLength > LIMITS.text) return null
    try { decodeText(blob); return Buffer.from(blob) } catch { return null }
  }

  private charge(bytes: number, context: Context): void {
    context.budget.bytes += bytes
    if (context.budget.bytes > LIMITS.project) throw new GitHubError('Git 历史文本读取超过 128 MiB 限制。')
  }

  private async readDetail(commit: Commit, path: string, afterTree: Map<string, string>, beforeTree: Map<string, string>, context: Context): Promise<RevisionDetail | null> {
    let current: Buffer
    try { current = await context.project.readBytes(path, LIMITS.text); decodeText(current) } catch { return null }
    this.charge(current.byteLength, context)
    const after = await this.blob(afterTree.get(path)!, context)
    if (!after) return null
    const previous = beforeTree.get(path)
    const before = previous ? await this.blob(previous, context) : null
    if (previous && !before) return null
    const timestamp = commit.commit.author.timestamp * 1000
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null
    const entry: RevisionEntry = { id: entryId(commit.oid, path), path,
      author: publicText(commit.commit.author.name, 100) || '未知提交作者', date: new Date(timestamp).toISOString(),
      kind: previous ? 'save' : 'create', summary: `Git 提交：${publicText(commit.commit.message, 400)}（提交作者，非实际编辑者归因）`,
      beforeRevision: before ? digest(before) : null, afterRevision: digest(after) }
    return { entry, before: before ? decodeText(before) : null, after: decodeText(after) }
  }
}
