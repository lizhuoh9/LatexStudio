import fs, { type Stats } from 'node:fs'
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

/** Every entry is still lstat-checked, in listing order; only the metadata calls of one directory overlap. */
const SCAN_BATCH = 16
async function entryStats(paths: readonly string[]): Promise<Stats[]> {
  const stats: Stats[] = []
  for (let offset = 0; offset < paths.length; offset += SCAN_BATCH) {
    stats.push(...await Promise.all(paths.slice(offset, offset + SCAN_BATCH).map(path => lstat(path))))
  }
  return stats
}

async function rejectLinks(directory: string, budget = { remaining: 100_000 }): Promise<void> {
  const names = await readdir(directory)
  if ((budget.remaining -= names.length) < 0) throw new GitHubError('项目历史文件过多，操作已停止。')
  const paths = names.map(name => join(directory, name)), stats = await entryStats(paths)
  for (const [index, stat] of stats.entries()) {
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new GitHubError('项目历史包含符号链接或特殊文件，操作已停止。')
    }
    if (stat.isDirectory()) await rejectLinks(paths[index]!, budget)
  }
}

/** Refuses a working folder that cannot be saved or synced safely: links, special files, unsafe names, too many
 * entries. It only checks; which files are committed is decided by Git's own status afterwards.
 */
export async function assertWorkingFiles(root: string, directory = '', budget = { remaining: 100_000 }): Promise<void> {
  const names = (await readdir(join(root, directory))).filter(name => directory || name !== '.git')
  if ((budget.remaining -= names.length) < 0) throw new GitHubError('项目文件过多，操作已停止。')
  const paths = names.map(name => directory ? `${directory}/${name}` : name)
  const stats = await entryStats(paths.map(path => safePath(root, path)))
  for (const [index, stat] of stats.entries()) {
    const path = paths[index]!
    if (stat.isSymbolicLink()) throw new GitHubError('项目包含符号链接，不能安全保存或同步。')
    if (excluded(path)) continue
    if (stat.isDirectory()) await assertWorkingFiles(root, path, budget)
    else if (!stat.isFile()) throw new GitHubError('项目包含不支持的特殊文件。')
  }
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

/** `validated` is for checking MANY commits in one pass (an outgoing history): a subtree that already passed at
 * the same path has the same id, so the same entries, and is not read again. Every distinct (path, tree) is still
 * checked once, and a skipped subtree still counts its entries against this commit's size limit. The returned
 * list then omits the skipped subtrees, so pass it only when the list is not used.
 */
export type ValidatedTrees = Map<string, number>
export async function validateTree(root: string, oid: string, cache: GitReadCache = {}, validated?: ValidatedTrees): Promise<string[]> {
  const commit = await git.readCommit({ fs, dir: root, oid, cache })
  const files: string[] = []
  await inspectTree(root, commit.commit.tree, '', files, { remaining: 100_000 }, cache, validated)
  return files
}

async function inspectTree(root: string, oid: string, prefix: string, files: string[], budget: { remaining: number },
  cache: GitReadCache, validated?: ValidatedTrees): Promise<void> {
  const key = `${prefix}\0${oid}`, known = validated?.get(key), before = budget.remaining
  if (known !== undefined) {
    if ((budget.remaining -= known) < 0) throw new GitHubError('远端项目文件过多，操作已停止。')
    return
  }
  const { tree } = await git.readTree({ fs, dir: root, oid, cache })
  const names = new Set<string>()
  for (const entry of tree) {
    if (--budget.remaining < 0) throw new GitHubError('远端项目文件过多，操作已停止。')
    const path = prefix ? `${prefix}/${entry.path}` : entry.path
    safePath(root, path)
    const normalized = entry.path.toLowerCase()
    if (names.has(normalized)) throw new GitHubError('远端文件名在当前平台不唯一，操作已停止。')
    names.add(normalized)
    if (entry.mode === '040000' && entry.type === 'tree') await inspectTree(root, entry.oid, path, files, budget, cache, validated)
    else if (['100644', '100755'].includes(entry.mode) && entry.type === 'blob') {
      if (excluded(path)) throw new GitHubError('远端包含凭据或构建文件，请先整理远端再同步。')
      files.push(path)
    } else throw new GitHubError('远端包含符号链接、子模块或特殊文件，未写入项目目录。')
  }
  validated?.set(key, before - budget.remaining)
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
