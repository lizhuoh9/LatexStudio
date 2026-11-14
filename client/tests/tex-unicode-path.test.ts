import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareNativeTex } from '../src/main/tex/prepare'
import { LocalCompiler } from '../src/main/tex/compiler'

// Opt-in: a Chinese Windows user name puts the TeX runtime (userData) under a non-ASCII path. Prepare a complete runtime
// under such a folder (cached ZIP, no network) and compile from a non-ASCII project folder, then remove the lab data.
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_UNICODE_PATH_SMOKE === '1'
const slash = String.fromCharCode(92)
const tex = (...lines: string[]) => lines.map(line => line.replaceAll('\\', slash)).join('\n') + '\n'

describe.skipIf(!enabled)('non-ASCII data and project paths', () => {
  it('prepares and compiles pdfLaTeX+BibTeX and Chinese XeLaTeX under Chinese folder names', async () => {
    const data = resolve('release', '中文用户 数据'), project = join(data, '论文 项目')
    await rm(data, { recursive: true, force: true })
    await mkdir(join(data, 'tex', 'downloads'), { recursive: true }); await mkdir(project)
    const cache = resolve('release/native-tex-lab/tex/downloads')
    for (const zip of await readdir(cache)) await copyFile(join(cache, zip), join(data, 'tex', 'downloads', zip))
    await writeFile(join(project, 'main.tex'), tex('\\documentclass{article}', '\\begin{document}', 'Unicode path \\cite{knuth84}.',
      '\\bibliographystyle{plain}', '\\bibliography{refs}', '\\end{document}'))
    await writeFile(join(project, 'refs.bib'), '@book{knuth84, author = {Donald E. Knuth}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1984}}\n')
    await writeFile(join(project, 'zh.tex'), tex('\\documentclass{ctexart}', '\\begin{document}', '中文路径下的中文文档。', '\\end{document}'))
    const report: Record<string, unknown> = {}
    try {
      let started = Date.now()
      const prepared = await prepareNativeTex(data)
      report.prepareMs = Date.now() - started
      report.runtimeRoot = prepared.root.replace(resolve('release'), '<release>')
      const compiler = new LocalCompiler(project, join(data, 'builds', 'p'), data, undefined, { latch: { latched: false } })
      for (const [file, engine] of [['main.tex', 'pdflatex'], ['zh.tex', 'xelatex']] as const) {
        started = Date.now()
        const result = await compiler.run({ mainFile: file, engine })
        report[file] = { ok: result.ok, ms: Date.now() - started, bibtex: result.log.includes('BibTeX：处理参考文献'),
          ctex: result.log.includes('ctex-fontset-windows'), tail: result.ok ? undefined : result.log.slice(-1500) }
      }
      console.info(`PAPERSTUDIO_UNICODE_PATH=${JSON.stringify(report)}`)
      expect(report['main.tex']).toMatchObject({ ok: true, bibtex: true })
      expect(report['zh.tex']).toMatchObject({ ok: true, ctex: true })
    } finally { await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  }, 900_000)
})
