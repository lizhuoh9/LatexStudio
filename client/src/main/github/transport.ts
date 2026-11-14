import type { HttpClient } from 'isomorphic-git'
import { checkedGitRequest, checkedLogin, checkedTarget, checkedToken, gitHeaders, GitHubError, safeBranch,
  type GitHubTarget, type GitRequest } from './remote-policy'
import { GitHubTransfer, type TransferOptions } from './transfer'
import { withVerificationLifecycle } from './verification-lifecycle'

export type { TransferLimits, TransferOptions } from './transfer'
export { GITHUB_TRANSFER_LIMITS } from './transfer'
export interface GitHubIdentity { login: string; id: number; branch: string }
export type GitHubHttpClient = HttpClient & { close(): Promise<void> }
const apiMaximumBytes = 1024 * 1024

/** The budget belongs to this client, not an entire repository/UI workflow. */
export function githubHttp(target: GitHubTarget, token: string, options: TransferOptions = {}): GitHubHttpClient {
  const canonical = checkedTarget(target)
  checkedToken(token)
  const transfer = new GitHubTransfer(options)
  const readOnly = options.readOnly === true
  return {
    close: () => transfer.close(),
    request: async (request: GitRequest) => {
      const endpoint = checkedGitRequest(canonical, request, readOnly)
      const headers = gitHeaders(token, request.headers)
      const response = await transfer.open(endpoint.url.href, { method: endpoint.method, headers, signal: request.signal }, request.body)
      return { url: endpoint.url.href, method: endpoint.method, statusCode: response.statusCode,
        statusMessage: 'OK', headers: response.headers, body: response.body }
    },
  }
}

async function api(transfer: GitHubTransfer, path: string, token: string): Promise<Record<string, unknown>> {
  const response = await transfer.open(`https://api.github.com${path}`, { method: 'GET', headers: {
    Authorization: `Bearer ${token}`, 'User-Agent': 'LatexStudio', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  } })
  return withVerificationLifecycle(async () => {
    const length = response.headers['content-length']
    if (length && Number(length) > apiMaximumBytes) throw new GitHubError('GitHub 身份响应过大。')
    const mediaType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (!mediaType || !['application/json', 'application/vnd.github+json', 'application/vnd.github.v3+json'].includes(mediaType)) {
      throw new GitHubError('GitHub 身份响应不是受支持的 JSON 类型。')
    }
    let text = ''
    let bytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > apiMaximumBytes) throw new GitHubError('GitHub 身份响应过大。')
      text += decoder.decode(chunk, { stream: true })
    }
    const value: unknown = JSON.parse(text + decoder.decode())
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new GitHubError('GitHub 返回了无法识别的响应。')
    return value as Record<string, unknown>
  }, () => response.body.return())
}

export async function verifyGitHub(target: GitHubTarget, token: string, options: TransferOptions = {}): Promise<GitHubIdentity> {
  const canonical = checkedTarget(target)
  checkedToken(token)
  const transfer = new GitHubTransfer(options)
  return withVerificationLifecycle(async () => {
    const user = await api(transfer, '/user', token)
    if (!checkedLogin(user.login) || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) {
      throw new GitHubError('无法验证 GitHub 账号身份。')
    }
    const repository = await api(transfer, `/repos/${canonical.owner}/${canonical.repository}`, token)
    if (typeof repository.default_branch !== 'string') throw new GitHubError('无法读取远端默认历史。')
    return { login: user.login, id: user.id, branch: safeBranch(repository.default_branch) }
  }, () => transfer.close())
}
