export class GitHubError extends Error {}

export interface GitHubTarget { url: string; owner: string; repository: string }
export interface GitRequest {
  url: string
  method?: string
  signal?: AbortSignal
  headers?: Record<string, string>
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>
}

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}$/

export function githubTarget(input: string): GitHubTarget {
  if (typeof input !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/?$/i.test(input)) {
    throw new GitHubError('仅支持不含凭据、查询或片段的 HTTPS github.com 仓库地址。')
  }
  const parts = input.replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').split('/')
  const owner = parts[0] ?? ''
  const repository = (parts[1] ?? '').replace(/\.git$/, '')
  if (!ownerPattern.test(owner) || owner.includes('--') || !repositoryPattern.test(repository) || repository === '.' || repository === '..') {
    throw new GitHubError('GitHub 地址必须包含有效账号和仓库名称。')
  }
  return { owner, repository, url: `https://github.com/${owner}/${repository}.git` }
}

export function checkedTarget(target: GitHubTarget): GitHubTarget {
  const canonical = githubTarget(target?.url)
  if (typeof target.owner !== 'string' || typeof target.repository !== 'string' ||
    canonical.owner.toLowerCase() !== target.owner.toLowerCase() || canonical.repository.toLowerCase() !== target.repository.toLowerCase()) {
    throw new GitHubError('GitHub 仓库地址与仓库标识不一致。')
  }
  return canonical
}

export function sameRepository(left: string, right: string): boolean {
  return githubTarget(left).url.toLowerCase() === githubTarget(right).url.toLowerCase()
}

export function safeBranch(branch: string): string {
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch === 'HEAD' || branch === '@' || branch.startsWith('-') ||
    /[^\x21-\x7e]/.test(branch) || /[~^:?*\\[\]]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || /\.lock$/i.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new GitHubError('远端默认历史名称无法安全使用。')
  }
  return branch
}

export function checkedToken(token: string): string {
  if (typeof token !== 'string' || !token || token.length > 4096 || /[^\x21-\x7e]/.test(token)) {
    throw new GitHubError('请输入有效 GitHub 凭据。')
  }
  return token
}

export function checkedLogin(login: unknown): login is string {
  return typeof login === 'string' && ownerPattern.test(login) && !login.includes('--')
}

function gitUrl(input: string): URL {
  try {
    const url = new URL(input)
    if (!/^https:\/\/github\.com\//i.test(input) || /[^\x21-\x7e]/.test(input) || /[%\\]/.test(input) ||
      url.origin !== 'https://github.com' || url.username || url.password || url.hash ||
      input.slice('https://github.com'.length) !== `${url.pathname}${url.search}`) throw new Error()
    return url
  } catch { throw new GitHubError('已阻止向非受信 GitHub 地址发送凭据。') }
}

export function checkedGitRequest(target: GitHubTarget, request: GitRequest, readOnly: boolean): { url: URL; method: string } {
  const url = gitUrl(request.url)
  const base = new URL(target.url).pathname
  const method = request.method ?? 'GET'
  const discovery = url.pathname === `${base}/info/refs` && method === 'GET' && request.body === undefined &&
    (url.search === '?service=git-upload-pack' || url.search === '?service=git-receive-pack')
  const upload = url.pathname === `${base}/git-upload-pack` && method === 'POST' && !url.search
  const receive = url.pathname === `${base}/git-receive-pack` && method === 'POST' && !url.search
  if (!discovery && !upload && !receive) throw new GitHubError('已阻止不属于当前仓库或 Git 协议的网络请求。')
  if (readOnly && (receive || url.search === '?service=git-receive-pack')) throw new GitHubError('只读连接不能上传远端历史。')
  return { url, method }
}

export function gitHeaders(token: string, supplied: GitRequest['headers']): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'LatexStudio', Authorization: `Basic ${btoa(`x-access-token:${checkedToken(token)}`)}` }
  for (const [name, value] of Object.entries(supplied ?? {})) {
    const key = name.toLowerCase()
    if (!['accept', 'content-type', 'git-protocol'].includes(key)) continue
    if (typeof value !== 'string' || value.length > 1024 || /[^\x20-\x7e]/.test(value)) {
      throw new GitHubError('Git 请求头无法安全使用。')
    }
    headers[key] = value
  }
  return headers
}
