import { randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitHubConnection } from '../../shared/workspace-contracts'
import { isMissing } from './files'
import { githubTarget, GitHubError, safeBranch } from './policy'

export interface RepositoryMetadata {
  version: 1
  connection: GitHubConnection | null
  accountId: number | null
  conflict: boolean
}

export function emptyMetadata(): RepositoryMetadata {
  return { version: 1, connection: null, accountId: null, conflict: false }
}

export async function readMetadata(root: string): Promise<RepositoryMetadata> {
  try {
    const value = JSON.parse(await readFile(join(root, '.git', 'paperstudio.json'), 'utf8')) as RepositoryMetadata
    if (value.version !== 1 || typeof value.conflict !== 'boolean') throw new Error()
    if (value.connection === null) return { ...emptyMetadata(), conflict: value.conflict }
    const connection = value.connection
    const target = githubTarget(connection.url)
    if (target.owner !== connection.owner || target.repository !== connection.repository ||
      !/^[A-Za-z0-9-]{1,39}$/.test(connection.login) || !Number.isSafeInteger(value.accountId) || !value.accountId || value.accountId < 0) throw new Error()
    return { version: 1, connection: { ...target, login: connection.login, branch: safeBranch(connection.branch) },
      accountId: value.accountId, conflict: value.conflict }
  } catch (error) {
    if (isMissing(error)) return emptyMetadata()
    throw new GitHubError('项目关联信息无法安全读取，请检查本地历史目录。')
  }
}

export async function writeMetadata(root: string, value: RepositoryMetadata): Promise<void> {
  const path = join(root, '.git', 'paperstudio.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!isMissing(error)) throw new GitHubError('无法清理本地历史临时文件。') })
  }
}

export function author(metadata: RepositoryMetadata): { name: string; email: string } {
  const login = metadata.connection?.login
  return login && metadata.accountId ? { name: login, email: `${metadata.accountId}+${login}@users.noreply.github.com` } :
    { name: 'LatexStudio', email: 'paperstudio@users.noreply.github.com' }
}

export function publicText(value: string, limit = 200): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏凭据]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, '[已隐藏地址]')
    .replace(/(?:authorization|password|token)\s*[:=]\s*\S+/gi, '[已隐藏凭据]').trim().slice(0, limit)
}
