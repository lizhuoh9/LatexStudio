import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { LocalCompiler } from '../src/main/tex/compiler'
import { createWindowsSandboxSession } from '../src/main/sandbox/windows'

// Opt-in real-machine acceptance of the production compiler (real AppContainer helper, prepared lab runtime).
// Hard-killing the helper is deliberately NOT exercised: it would leave an uncleanable AppContainer profile.
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_COMPILER_NATIVE === '1'
const execute = promisify(execFile)
const data = resolve('release/native-tex-lab')
const projects = join(data, 'compiler-projects'), builds = join(data, 'compiler-builds')
const slash = String.fromCharCode(92)
const tex = (...lines: string[]) => lines.map(line => line.replaceAll('\\', slash)).join('\n') + '\n'
const SIMPLE = tex('\\documentclass{article}', '\\begin{document}', 'PaperStudio compiler acceptance.', '\\end{document}')
const LOOP = tex('\\documentclass{article}', '\\begin{document}', '\\def\\loopforever{\\loopforever}\\loopforever', '\\end{document}')

/** PDF text including Flate-compressed streams (xdvipdfmx puts font objects into compressed object streams). */
function pdfText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf), parts = [raw.toString('latin1')]
  for (let at = raw.indexOf('stream'); at !== -1; at = raw.indexOf('stream', at + 6)) {
    const start = raw[at + 6] === 13 ? at + 8 : at + 7, end = raw.indexOf('endstream', start)
    if (end === -1) break
    try { parts.push(inflateSync(raw.subarray(start, end)).toString('latin1')) } catch { /* not a Flate stream */ }
  }
  return parts.join('\n')
}
async function profiles(): Promise<string> {
  const script = '$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings");if($k){foreach($s in $k.GetSubKeyNames()){$e=$k.OpenSubKey($s);$n=$e.GetValue("DisplayName");if($n -like "PaperStudio.Compiler.*"){Write-Output $n};$e.Close()};$k.Close()}'
  return (await execute('powershell.exe', ['-NoProfile', '-Command', script], { maxBuffer: 65536 })).stdout.trim().split(/\r?\n/).filter(Boolean).sort().join('\n')
}
async function helpers(): Promise<number> {
  const out = (await execute('tasklist.exe', ['/FO', 'CSV', '/NH'], { maxBuffer: 4 * 1024 * 1024 })).stdout
  return out.split(/\r?\n/).filter(line => line.startsWith('"PaperStudio.Sandbox.exe"')).length
}
async function projectWith(name: string, files: Record<string, string>): Promise<string> {
  const root = join(projects, name)
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content)
  }
  return root
}
function compilerFor(root: string, timeoutMs?: number, onLog?: (message: string) => void) {
  return new LocalCompiler(root, join(builds, root.split(/[\\/]/).pop()!), data, onLog, { latch: { latched: false }, timeoutMs })
}
async function leftovers(root: string): Promise<string[]> {
  try { return await readdir(join(builds, root.split(/[\\/]/).pop()!)) } catch { return [] }
}

describe.skipIf(!enabled)('production compiler acceptance in the real Windows sandbox', () => {
  it('covers success, TeX error, cancel, timeout, restart and subdirectory input without residue', async () => {
    const profilesBefore = await profiles()
    const report: Record<string, unknown> = {}

    const simple = await projectWith('simple', { 'main.tex': SIMPLE })
    let started = Date.now()
    const ok = await compilerFor(simple).run({ mainFile: 'main.tex', engine: 'pdflatex' })
    report.success = { ok: ok.ok, bytes: ok.pdf?.length, ms: Date.now() - started, leftovers: (await leftovers(simple)).length }
    expect(ok.ok, ok.log.slice(-2000)).toBe(true)
    expect(Buffer.from(ok.pdf!).subarray(0, 5).toString()).toBe('%PDF-')

    const broken = await projectWith('broken', { 'main.tex': tex('\\documentclass{article}', '\\begin{document}', '\\undefinedpaperstudiomacro', '\\end{document}') })
    started = Date.now()
    const error = await compilerFor(broken).run({ mainFile: 'main.tex', engine: 'pdflatex' })
    report.texError = { ok: error.ok, ms: Date.now() - started, undefinedReported: error.log.includes('Undefined control sequence'), leftovers: (await leftovers(broken)).length }
    expect(error.ok).toBe(false); expect(error.log).toContain('Undefined control sequence')

    const loop = await projectWith('cancel', { 'main.tex': LOOP })
    let passStarted = false
    const cancelable = compilerFor(loop, undefined, message => { if (message.includes('第 1/2 遍')) passStarted = true })
    started = Date.now()
    const pending = cancelable.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    while (!passStarted && Date.now() - started < 90_000) await new Promise(done => setTimeout(done, 100))
    await new Promise(done => setTimeout(done, 2000))
    cancelable.cancel()
    const canceled = await pending
    report.cancel = { canceled: canceled.canceled, ok: canceled.ok, ms: Date.now() - started, leftovers: (await leftovers(loop)).length,
      latched: canceled.log.includes('请重新启动') }
    expect(canceled).toMatchObject({ canceled: true, ok: false, pdf: null })

    const slow = await projectWith('timeout', { 'main.tex': LOOP })
    started = Date.now()
    const timedOut = await compilerFor(slow, 8000).run({ mainFile: 'main.tex', engine: 'pdflatex' })
    report.timeout = { canceled: timedOut.canceled, ok: timedOut.ok, ms: Date.now() - started, leftovers: (await leftovers(slow)).length,
      limitReported: timedOut.log.includes('编译超过 8 秒限制'), latched: timedOut.log.includes('请重新启动') }
    expect(timedOut).toMatchObject({ canceled: false, ok: false, pdf: null })
    expect(timedOut.log).toContain('编译超过 8 秒限制')

    const nested = await projectWith('nested', { 'paper/main.tex': tex('\\documentclass{article}', '\\begin{document}',
      '\\input{paper/section}', '\\end{document}'), 'paper/section.tex': 'Included section text.\n' })
    started = Date.now()
    const restart = await compilerFor(nested).run({ mainFile: 'paper/main.tex', engine: 'pdflatex' })
    report.restartNested = { ok: restart.ok, ms: Date.now() - started, bytes: restart.pdf?.length, leftovers: (await leftovers(nested)).length }
    expect(restart.ok, restart.log.slice(-2000)).toBe(true)

    const xe = await projectWith('xelatex', {
      'latin.tex': tex('\\documentclass{article}', '\\usepackage{fontspec}', '\\begin{document}', 'XeLaTeX Unicode: café, naïve, Ω, ≤.', '\\end{document}'),
      'system.tex': tex('\\documentclass{article}', '\\usepackage{fontspec}', '\\setmainfont{Arial}', '\\begin{document}',
        'System font through fontconfig.', '\\end{document}') })
    for (const name of ['latin', 'system']) {
      started = Date.now()
      const result = await compilerFor(xe).run({ mainFile: `${name}.tex`, engine: 'xelatex' })
      report[`xelatex-${name}`] = { ok: result.ok, ms: Date.now() - started, bytes: result.pdf?.length,
        fontconfigWarning: /Fontconfig (?:error|warning)/i.test(result.log), leftovers: (await leftovers(xe)).length }
      expect(result.ok, result.log.slice(-2000)).toBe(true)
      expect(Buffer.from(result.pdf!).subarray(0, 5).toString()).toBe('%PDF-')
    }

    const lastPass = (log: string): string => log.slice(log.lastIndexOf('遍\n'))
    const bib = await projectWith('bibtex', {
      'main.tex': tex('\\documentclass{article}', '\\begin{document}', 'See \\cite{knuth84}.', '\\bibliographystyle{plain}',
        '\\bibliography{refs}', '\\end{document}'),
      'refs.bib': '@book{knuth84, author = {Donald E. Knuth}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1984}}\n' })
    started = Date.now()
    const cited = await compilerFor(bib).run({ mainFile: 'main.tex', engine: 'pdflatex' })
    report.bibtex = { ok: cited.ok, ms: Date.now() - started, ranBibtex: cited.log.includes('BibTeX：处理参考文献'),
      threePasses: cited.log.includes('第 3/3 遍'), undefinedInFinalPass: /undefined/i.test(lastPass(cited.log)), leftovers: (await leftovers(bib)).length }
    expect(cited.ok, cited.log.slice(-2500)).toBe(true)
    expect(report.bibtex).toMatchObject({ ranBibtex: true, threePasses: true, undefinedInFinalPass: false })

    const zh = await projectWith('chinese', {
      'main.tex': tex('\\documentclass{ctexart}', '\\usepackage{gbt7714}', '\\begin{document}', '\\section{中文支持}', '这是宋体正文，\\textbf{这是黑体加粗}。',
        '引用见\\cite{zhang2020}。', '\\bibliographystyle{gbt7714-numerical}', '\\bibliography{refs}', '\\end{document}'),
      'refs.bib': '@article{zhang2020, author = {张三 and 李四}, title = {中文论文标题}, journal = {计算机学报}, year = {2020}, volume = {43}, pages = {1--10}}\n' })
    started = Date.now()
    const chinese = await compilerFor(zh).run({ mainFile: 'main.tex', engine: 'xelatex' })
    const text = chinese.pdf ? pdfText(chinese.pdf) : ''
    if (chinese.pdf) await writeFile(join(data, 'results', 'chinese-acceptance.pdf'), chinese.pdf)
    report.chinese = { ok: chinese.ok, ms: Date.now() - started, bytes: chinese.pdf?.length, ranBibtex: chinese.log.includes('BibTeX：处理参考文献'),
      simsun: /SimSun/i.test(text), simhei: /SimHei/i.test(text), undefinedInFinalPass: /undefined/i.test(lastPass(chinese.log)),
      leftovers: (await leftovers(zh)).length }
    console.info(`PAPERSTUDIO_CHINESE_REPORT=${JSON.stringify(report.chinese)}`)
    expect(chinese.ok, chinese.log.slice(-3000)).toBe(true)
    expect(report.chinese).toMatchObject({ ranBibtex: true, simsun: true, simhei: true, undefinedInFinalPass: false })

    for (const root of [simple, broken, loop, slow, nested, xe, bib, zh]) expect(await leftovers(root)).toEqual([])
    report.helpersAfter = await helpers()
    report.profilesUnchanged = await profiles() === profilesBefore
    console.info(`PAPERSTUDIO_COMPILER_ACCEPTANCE=${JSON.stringify(report)}`)
    expect(report.helpersAfter).toBe(0)
    expect(report.profilesUnchanged).toBe(true)
  }, 600_000)

  it('loads only the pinned runtime formats even when the snapshot carries decoy .fmt files', async () => {
    // Snapshots already drop .fmt files; this plants decoys where kpathsea's default TEXFORMATS would look
    // ('.', and $TEXMFHOME/$TEXMFVAR = the snapshot), after the copy, to prove the helper pins the format path itself.
    const decoy = Buffer.from('not a TeX format file\n')
    const plant = async (source: string): Promise<void> => {
      for (const dir of ['', 'web2c', 'web2c/pdftex', 'web2c/xetex', 'texmf/web2c', 'texmf/web2c/pdftex', 'texmf/web2c/xetex']) {
        await mkdir(join(source, dir), { recursive: true })
        for (const name of ['pdflatex.fmt', 'xelatex.fmt']) await writeFile(join(source, dir, name), decoy)
      }
    }
    const root = await projectWith('decoy-formats', { 'main.tex': SIMPLE })
    const compiler = new LocalCompiler(root, join(builds, 'decoy-formats'), data, undefined, { latch: { latched: false },
      createSession: async options => { await plant(options.workDirs[0]!); return createWindowsSandboxSession(options) } })
    for (const engine of ['pdflatex', 'xelatex'] as const) {
      const result = await compiler.run({ mainFile: 'main.tex', engine })
      expect(result.log, `${engine} must not read a decoy format`).not.toMatch(/format file error|stymied/i)
      expect(result.ok, result.log.slice(-2000)).toBe(true)
    }
    expect(await leftovers(root)).toEqual([])
  }, 300_000)
})
