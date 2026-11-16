export interface ProjectLink { owner: string; name: string; githubUrl: string; appUrl: string }

const invalid = (): Error => new Error('项目分享链接无效。请使用 LatexStudio 加入链接或 HTTPS GitHub 仓库地址。')

/** Sharing addresses are not Git clone URLs: a repository named paper.git stays paper.git. */
export function parseProjectLink(input: unknown): ProjectLink {
  if (typeof input !== 'string' || input.length > 256 || /[^\x21-\x7e]/.test(input)) throw invalid()
  const match = /^(?:https:\/\/github\.com\/|latexstudio:\/\/join\/)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/i.exec(input)
  if (!match) throw invalid()
  const owner = match[1]!, name = match[2]!
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || owner.includes('--') ||
    name.length > 100 || name === '.' || name === '..') throw invalid()
  return { owner, name, githubUrl: `https://github.com/${owner}/${name}`, appUrl: `latexstudio://join/${owner}/${name}` }
}
