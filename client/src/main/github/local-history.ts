import fs from 'node:fs'
import git from 'isomorphic-git'
import type { FileChange, HistoryEntry } from '../../shared/workspace-contracts'
import { assertWorkingFiles, hasRepository, headOid } from './files'
import { author, publicText, type RepositoryMetadata } from './metadata'
import { excluded, GitHubError, safePath } from './policy'

export async function ensureRepository(root: string): Promise<void> {
  if (!await hasRepository(root)) await git.init({ fs, dir: root, defaultBranch: 'main' })
}

export async function localChanges(root: string): Promise<FileChange[]> {
  await assertWorkingFiles(root)
  const tracked = await git.listFiles({ fs, dir: root })
  for (const path of tracked) {
    safePath(root, path)
    if (excluded(path)) throw new GitHubError('现有历史跟踪了凭据或构建文件；请先移除敏感历史再同步。')
  }
  const matrix = await git.statusMatrix({ fs, dir: root })
  return matrix.filter(([path, head, work, stage]) => !excluded(path) && (head !== work || stage !== head))
    .map(([path, head, work]) => ({ path, kind: head === 0 ? 'added' : work === 0 ? 'deleted' : 'modified' }))
}

export async function saveSnapshot(root: string, metadata: RepositoryMetadata, summary: string,
  who?: { name: string; email: string }): Promise<HistoryEntry | null> {
  const changes = await localChanges(root)
  if (!changes.length) return null
  for (const change of changes) {
    if (change.kind === 'deleted') await git.remove({ fs, dir: root, filepath: change.path })
    else await git.add({ fs, dir: root, filepath: change.path })
  }
  const oid = await git.commit({ fs, dir: root, author: who ?? author(metadata),
    message: publicText(summary, 500) || '保存本地快照' })
  const { commit } = await git.readCommit({ fs, dir: root, oid })
  return historyEntry(oid, commit)
}

interface CommitDisplay {
  message: string
  author: { name: string; timestamp: number }
}

function historyEntry(oid: string, commit: CommitDisplay): HistoryEntry {
  return { id: oid, summary: publicText(commit.message, 500), author: publicText(commit.author.name, 100),
    date: new Date(commit.author.timestamp * 1000).toISOString() }
}

export async function localHistory(root: string): Promise<HistoryEntry[]> {
  if (!await headOid(root)) return []
  const log = await git.log({ fs, dir: root, depth: 100 })
  return log.map(({ oid, commit }) => historyEntry(oid, commit))
}
