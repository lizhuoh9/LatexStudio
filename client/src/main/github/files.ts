import fs from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import git from 'isomorphic-git'
import { excluded, GitHubError, safePath } from './policy'

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function assertProjectDirectory(root: string): Promise<void> {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GitHubError('项目目录不能是符号链接。')
}

export async function hasRepository(root: string): Promise<boolean> {
  await assertProjectDirectory(root)
  try {
    const metadata = await lstat(join(root, '.git'))
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new GitHubError('项目历史目录不安全。')
    await rejectLinks(join(root, '.git'))
    return true
  } catch (error) { if (isMissing(error)) return false; throw error }
}

async function rejectLinks(directory: string, budget = { remaining: 100_000 }): Promise<void> {
  for (const name of await readdir(directory)) {
    if (--budget.remaining < 0) throw new GitHubError('项目历史文件过多，操作已停止。')
    const path = join(directory, name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new GitHubError('项目历史包含符号链接或特殊文件，操作已停止。')
    }
    if (stat.isDirectory()) await rejectLinks(path, budget)
  }
}

export async function workingFiles(root: string, directory = '', budget = { remaining: 100_000 }): Promise<string[]> {
  const result: string[] = []
  for (const name of await readdir(join(root, directory))) {
    const path = directory ? `${directory}/${name}` : name
    if (path === '.git') continue
    if (--budget.remaining < 0) throw new GitHubError('项目文件过多，操作已停止。')
    const target = safePath(root, path)
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) throw new GitHubError('项目包含符号链接，不能安全保存或同步。')
    if (excluded(path)) continue
    if (stat.isDirectory()) result.push(...await workingFiles(root, path, budget))
    else if (!stat.isFile()) throw new GitHubError('项目包含不支持的特殊文件。')
    else if (!await git.isIgnored({ fs, dir: root, filepath: path })) result.push(path)
  }
  return result
}

export async function headOid(root: string): Promise<string | null> {
  try { return await git.resolveRef({ fs, dir: root, ref: 'HEAD' }) }
  catch (error) {
    if ((error as { code?: string }).code === 'NotFoundError') return null
    throw error
  }
}

/** isomorphic-git object cache for ONE read-only pass. Without it every object read re-reads and re-indexes each
 * packfile (a cloned project is one big pack). Every object is still read and checked; never keep a cache across
 * a fetch, commit, checkout or another operation.
 */
export type GitReadCache = object

export async function validateTree(root: string, oid: string, cache: GitReadCache = {}): Promise<string[]> {
  const commit = await git.readCommit({ fs, dir: root, oid, cache })
  const files: string[] = []
  await inspectTree(root, commit.commit.tree, '', files, { remaining: 100_000 }, cache)
  return files
}

async function inspectTree(root: string, oid: string, prefix: string, files: string[], budget: { remaining: number },
  cache: GitReadCache): Promise<void> {
  const { tree } = await git.readTree({ fs, dir: root, oid, cache })
  const names = new Set<string>()
  for (const entry of tree) {
    if (--budget.remaining < 0) throw new GitHubError('远端项目文件过多，操作已停止。')
    const path = prefix ? `${prefix}/${entry.path}` : entry.path
    safePath(root, path)
    const normalized = entry.path.toLowerCase()
    if (names.has(normalized)) throw new GitHubError('远端文件名在当前平台不唯一，操作已停止。')
    names.add(normalized)
    if (entry.mode === '040000' && entry.type === 'tree') await inspectTree(root, entry.oid, path, files, budget, cache)
    else if (['100644', '100755'].includes(entry.mode) && entry.type === 'blob') {
      if (excluded(path)) throw new GitHubError('远端包含凭据或构建文件，请先整理远端再同步。')
      files.push(path)
    } else throw new GitHubError('远端包含符号链接、子模块或特殊文件，未写入项目目录。')
  }
}

export async function checkCheckout(root: string, oid: string): Promise<void> {
  const files = await validateTree(root, oid)
  const tracked = new Set(await headOid(root) ? await git.listFiles({ fs, dir: root, ref: 'HEAD' }) : [])
  for (const path of files) {
    if (tracked.has(path)) continue
    try {
      await lstat(safePath(root, path))
      throw new GitHubError('远端文件与未纳入本地历史的文件冲突；本地文件未覆盖。')
    } catch (error) { if (!isMissing(error)) throw error }
  }
}
