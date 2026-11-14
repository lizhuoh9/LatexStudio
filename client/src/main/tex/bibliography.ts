import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

export type BibliographyTool = 'bibtex' | 'biber' | 'none'
const AUX_MAX = 8 * 1024 * 1024

async function regularFile(path: string): Promise<number | null> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() ? info.size : null
  } catch { return null }
}

/** Reads at most the last AUX_MAX bytes (\bibdata is written where \bibliography appears, usually near the end). */
async function auxTail(path: string, size: number): Promise<string> {
  const length = Math.min(size, AUX_MAX)
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const bytes = Buffer.alloc(length)
    const { bytesRead } = await file.read(bytes, 0, length, size - length)
    return bytes.subarray(0, bytesRead).toString('latin1')
  } finally { await file.close() }
}

/**
 * Decides after the first engine pass which bibliography program the run needs. biblatex's Biber backend writes a
 * .bcf control file; classic \bibliography (natbib, biblatex backend=bibtex) writes \bibdata into the .aux file.
 */
export async function bibliographyTool(output: string): Promise<BibliographyTool> {
  if (await regularFile(join(output, 'paperstudio.bcf')) !== null) return 'biber'
  const aux = join(output, 'paperstudio.aux'), size = await regularFile(aux)
  if (size === null || size === 0) return 'none'
  return /\\bibdata\{/.test(await auxTail(aux, size)) ? 'bibtex' : 'none'
}
