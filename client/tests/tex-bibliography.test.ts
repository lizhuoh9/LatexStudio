import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bibliographyTool } from '../src/main/tex/bibliography'

const roots: string[] = []
async function output(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-bib-')); roots.push(root); return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('bibliography tool detection', () => {
  it('needs nothing without an aux file or without \\bibdata', async () => {
    const dir = await output()
    expect(await bibliographyTool(dir)).toBe('none')
    await writeFile(join(dir, 'paperstudio.aux'), '\\relax\n\\citation{knuth}\n')
    expect(await bibliographyTool(dir)).toBe('none')
  })
  it('selects BibTeX for \\bibdata, including when it is at the end of a large aux file', async () => {
    const dir = await output()
    await writeFile(join(dir, 'paperstudio.aux'), `\\relax\n${'\\@writefile{toc}{x}\n'.repeat(600000)}\\bibstyle{plain}\n\\bibdata{refs}\n`)
    expect(await bibliographyTool(dir)).toBe('bibtex')
  })
  it('reports Biber when biblatex wrote a control file', async () => {
    const dir = await output()
    await writeFile(join(dir, 'paperstudio.aux'), '\\bibdata{paperstudio-blx}\n')
    await writeFile(join(dir, 'paperstudio.bcf'), '<bcf:controlfile/>')
    expect(await bibliographyTool(dir)).toBe('biber')
  })
})
