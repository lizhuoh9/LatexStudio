import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SafeProject, skipped } from '../local/paths'

// Build products are not evidence that the author edited the paper. SafeProject already excludes
// private history/Git/dependency/output directories and its ordinary TeX output suffixes.
const GENERATED = /\.(?:dvi|xdv|bbl|blg|bcf|run\.xml|idx|ilg|ind|glg|glo|gls|glsdefs|acn|acr|alg|tmp|temp|bak|swp|swo|lock)$/i
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right

async function realParents(root: string): Promise<void> {
  const parents: string[] = []
  for (let current = root; ; current = dirname(current)) {
    parents.push(current)
    if (current === dirname(current)) break
  }
  // Check outward ancestors first, before issuing metadata calls through a potentially linked parent.
  for (const current of parents.reverse()) {
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked project parent')
  }
  if (!samePath(await realpath(root), root)) throw new Error('Redirected project root')
}

function contentFile(path: string, generatedPdf: Set<string>): boolean {
  if (/\.pdf$/i.test(path) && (generatedPdf.has(path.toLowerCase()) || /^(?:main|document|paper|output|compiled)\.pdf$/i.test(path))) return false
  return !skipped(path) && !GENERATED.test(path) && !path.endsWith('~') &&
    !path.split('/').some(part => part.startsWith('.') || part.startsWith('~$'))
}

/** Display-only, read-only mtime aggregation. Never reads file bytes or treats registry recency as modification.
 * SafeProject supplies the existing depth/10,000-entry/path/no-symlink bounds, and the lstat sample that passed
 * those checks for each listed file is the one whose mtime is used. Any incomplete scan is unknown.
 */
export async function readProjectLastModified(root: string): Promise<string | null> {
  try {
    const project = new SafeProject(root)
    await realParents(project.root)
    await project.initialize()
    const samples = new Map<string, Stats>()
    const files = await project.list(false, (file, info) => { samples.set(file.path, info) })
    const generatedPdf = new Set(files.filter(file => /\.tex$/i.test(file.path)).map(file => file.path.replace(/\.tex$/i, '.pdf').toLowerCase()))
    let latest: number | null = null
    for (const file of files) {
      if (!contentFile(file.path, generatedPdf)) continue
      const info = samples.get(file.path)
      if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !Number.isFinite(info.mtimeMs)) return null
      latest = latest === null ? info.mtimeMs : Math.max(latest, info.mtimeMs)
    }
    await project.verifyRoot()
    await realParents(project.root)
    return latest === null ? null : new Date(latest).toISOString()
  } catch { return null }
}
