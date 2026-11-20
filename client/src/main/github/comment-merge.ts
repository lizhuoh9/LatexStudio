import fs from 'node:fs'
import git, { type TreeEntry } from 'isomorphic-git'
import type { GitReadCache } from './files'

/** Only these paths may be merged automatically: each device appends to its own comment log. */
export const MERGEABLE_COMMENT_PATH = /^\.latexstudio\/comments\/[a-f0-9]{32}\.jsonl$/
const MAX_ENTRIES = 100_000, MAX_LOG_BYTES = 4 * 1024 * 1024

interface FileEntry { oid: string; mode: string }
type FileMap = Map<string, FileEntry>
/** An input too large to inspect within the limits is simply not merged automatically. */
class NotMergeable extends Error {}

/** The narrow automatic merge for diverged histories. It applies only when, since the single common ancestor,
 * one side changed nothing but comment logs — new logs, or existing logs that only grew at the end — and the two
 * sides changed no path in common. The result is the other side's tree plus those comment files, committed with
 * both parents. File contents are never merged. Any other divergence returns null and keeps the conflict stop.
 */
export async function mergeCommentDivergence(root: string, local: string, remote: string,
  author: { name: string; email: string }): Promise<string | null> {
  const cache: GitReadCache = {} // reads only; nothing is written until the tree below is decided
  let tree: string | null
  try { tree = await mergedTree(root, local, remote, cache) } catch (error) {
    if (error instanceof NotMergeable) return null
    throw error
  }
  if (!tree) return null
  return git.commit({ fs, dir: root, author, message: '自动合并评论记录', tree, parent: [local, remote], noUpdateBranch: true })
}

async function mergedTree(root: string, local: string, remote: string, cache: GitReadCache): Promise<string | null> {
  const bases = await git.findMergeBase({ fs, dir: root, oids: [local, remote], cache })
  if (bases.length !== 1) return null
  const trees = new Map<string, TreeEntry[]>()
  const base = await files(root, bases[0] as string, cache, trees)
  const ours = await files(root, local, cache, trees), theirs = await files(root, remote, cache, trees)
  const localChanges = changed(base, ours), remoteChanges = changed(base, theirs)
  if ([...localChanges].some(path => remoteChanges.has(path))) return null
  if (await appendsOnly(root, localChanges, base, ours, cache)) return withComments(root, remote, ours, localChanges, cache)
  if (await appendsOnly(root, remoteChanges, base, theirs, cache)) return withComments(root, local, theirs, remoteChanges, cache)
  return null
}

/** Every tree entry, folders included, counts against the walk's budget (as in validateTree), so a tree that
 * repeats one folder many times cannot make this explode; each tree object is read and parsed only once.
 */
async function files(root: string, commit: string, cache: GitReadCache, trees: Map<string, TreeEntry[]>): Promise<FileMap> {
  const { commit: data } = await git.readCommit({ fs, dir: root, oid: commit, cache })
  const result: FileMap = new Map(), budget = { remaining: MAX_ENTRIES }
  const entries = async (oid: string): Promise<TreeEntry[]> => {
    let known = trees.get(oid)
    if (!known) { known = (await git.readTree({ fs, dir: root, oid, cache })).tree; trees.set(oid, known) }
    return known
  }
  const visit = async (oid: string, prefix: string): Promise<void> => {
    for (const entry of await entries(oid)) {
      if (--budget.remaining < 0) throw new NotMergeable()
      const path = prefix ? `${prefix}/${entry.path}` : entry.path
      if (entry.type === 'tree') await visit(entry.oid, path)
      else result.set(path, { oid: entry.oid, mode: entry.mode })
    }
  }
  await visit(data.tree, '')
  return result
}

function changed(before: FileMap, after: FileMap): Set<string> {
  const paths = new Set<string>()
  for (const [path, entry] of after) {
    const old = before.get(path)
    if (!old || old.oid !== entry.oid || old.mode !== entry.mode) paths.add(path)
  }
  for (const path of before.keys()) if (!after.has(path)) paths.add(path)
  return paths
}

/** Only comment logs changed on this side, each new or grown at the end; deleted, rewritten or truncated logs never merge. */
async function appendsOnly(root: string, changes: Set<string>, base: FileMap, side: FileMap, cache: GitReadCache): Promise<boolean> {
  if (!changes.size) return false
  for (const path of changes) {
    const entry = side.get(path), old = base.get(path)
    if (!MERGEABLE_COMMENT_PATH.test(path) || entry?.mode !== '100644') return false
    if (!old) continue
    if (old.mode !== '100644') return false
    const [before, after] = await Promise.all([blob(root, old.oid, cache), blob(root, entry.oid, cache)])
    if (after.length < before.length || !Buffer.from(after.buffer, after.byteOffset, before.length).equals(Buffer.from(before))) return false
  }
  return true
}

async function blob(root: string, oid: string, cache: GitReadCache): Promise<Uint8Array> {
  const { blob: bytes } = await git.readBlob({ fs, dir: root, oid, cache })
  if (bytes.length > MAX_LOG_BYTES) throw new NotMergeable()
  return bytes
}

/** `target`'s tree with the given comment files from `source`; only `.latexstudio/comments` and its parents change. */
async function withComments(root: string, target: string, source: FileMap, paths: Set<string>, cache: GitReadCache): Promise<string | null> {
  const { commit } = await git.readCommit({ fs, dir: root, oid: target, cache })
  const top = (await git.readTree({ fs, dir: root, oid: commit.tree, cache })).tree
  const folder = top.find(entry => entry.path === '.latexstudio')
  if (folder && folder.type !== 'tree') return null
  const middle = folder ? (await git.readTree({ fs, dir: root, oid: folder.oid, cache })).tree : []
  const comments = middle.find(entry => entry.path === 'comments')
  if (comments && comments.type !== 'tree') return null
  const names = new Map([...paths].map(path => [path.split('/')[2]!, source.get(path)!.oid]))
  const leaves = comments ? (await git.readTree({ fs, dir: root, oid: comments.oid, cache })).tree : []
  if (leaves.some(entry => names.has(entry.path) && entry.type !== 'blob')) return null
  const nextLeaves: TreeEntry[] = [...leaves.filter(entry => !names.has(entry.path)),
    ...[...names].map(([path, oid]) => ({ mode: '100644', path, oid, type: 'blob' as const }))]
  const commentsOid = await git.writeTree({ fs, dir: root, tree: nextLeaves })
  const middleOid = await git.writeTree({ fs, dir: root, tree: [...middle.filter(entry => entry.path !== 'comments'),
    { mode: '040000', path: 'comments', oid: commentsOid, type: 'tree' }] })
  return git.writeTree({ fs, dir: root, tree: [...top.filter(entry => entry.path !== '.latexstudio'),
    { mode: '040000', path: '.latexstudio', oid: middleOid, type: 'tree' }] })
}
