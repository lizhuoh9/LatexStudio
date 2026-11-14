import { resolve, relative, isAbsolute } from 'node:path'

import { GitHubError } from './remote-policy'
export { GitHubError, githubTarget, sameRepository, safeBranch, type GitHubTarget } from './remote-policy'

export function safePath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.split('/').some(unsafeSegment)) {
    throw new GitHubError('仓库包含不安全的文件路径，操作已停止。')
  }
  const target = resolve(root, path)
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new GitHubError('仓库文件不能越出项目目录。')
  return target
}

function unsafeSegment(segment: string): boolean {
  return !segment || segment === '.' || segment === '..' || /[\x00-\x1f\x7f:<>"|?*]/.test(segment) ||
    /[. ]$/.test(segment) || segment.toLowerCase() === '.git' || /^git~[1-9]/i.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
}

const excludedDirectories = new Set(['.git', 'node_modules', 'build', 'dist', 'out', 'release',
  '.cache', '.next', '.nuxt', '.output', 'coverage', '.venv', 'venv', '__pycache__', '.ssh', '.aws', '.azure', '.gnupg', '.kube',
  '.paperstudio'])
const credentialNames = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|_netrc|\.git-credentials|credentials(?:\..*)?|(?:secrets?|tokens?|passwords?|vault)(?:\..*)?|\.gitmodules|\.gitconfig|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i
const buildNames = /\.(?:aux|log|fls|fdb_latexmk|synctex(?:\.gz)?|toc|out|bbl|blg|nav|snm|vrb)$/i

export function excluded(path: string): boolean {
  const parts = path.split('/')
  return parts.some((part) => excludedDirectories.has(part.toLowerCase()) || credentialNames.test(part)) ||
    buildNames.test(parts.at(-1) ?? '')
}

export function publicError(error: unknown): Error {
  return error instanceof GitHubError ? error : new GitHubError('GitHub 或本地历史操作失败，请检查网络、权限和项目文件；凭据未显示。')
}
