import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createMacSandboxSession } from '../src/main/sandbox/macos-session'
import { runMacSelfTest } from '../src/main/sandbox/macos-selftest'
import type { SandboxSessionOptions } from '../src/main/sandbox/session'
import { LocalCompiler, type CompilerDependencies } from '../src/main/tex/compiler'
import { DARWIN_TOOLS, MacTrustedRuntime } from '../src/main/tex/darwin-runtime'

/**
 * REAL macOS acceptance of the App Sandbox backend (explicit opt-in; skipped everywhere else). It uses the product's
 * own session, self-test and compiler against the real helper and the real TinyTeX tree:
 *
 *   PAPERSTUDIO_MAC_APPSANDBOX=1
 *   PAPERSTUDIO_MAC_HELPER=<...>/LatexStudioCompiler.app/Contents/MacOS/latexstudio-compiler
 *   PAPERSTUDIO_MAC_RESOURCES=<...>/LatexStudioCompiler.app/Contents/Resources  (tex-darwin/install and tex-packages)
 *   PAPERSTUDIO_MAC_TREE_SHA256=<treeSha256 reported by scripts/prepare-bundled-tex-darwin.cjs>  (optional)
 *
 * A pass here is evidence for THIS Mac and macOS version only. A skipped run is not a pass.
 */
const enabled = process.env.PAPERSTUDIO_MAC_APPSANDBOX === '1'
const helper = process.env.PAPERSTUDIO_MAC_HELPER ?? ''
const resources = process.env.PAPERSTUDIO_MAC_RESOURCES ?? ''
const runtimeRoot = join(resources, 'tex-darwin'), overlayRoot = join(resources, 'tex-packages', 'texmf-paperstudio')
// The sentinel must live in the user's home for the "cannot read user data" control to mean anything.
const dataRoot = process.env.PAPERSTUDIO_MAC_DATA ?? join(homedir(), 'LatexStudio-build', 'phase0-data')
const prepared = { root: runtimeRoot, manifest: { platform: 'darwin', engines: { pdflatex: DARWIN_TOOLS.pdflatex, xelatex: DARWIN_TOOLS.xelatex },
  tools: { xdvipdfmx: DARWIN_TOOLS.xdvipdfmx } } }
const session = (options: SandboxSessionOptions) => createMacSandboxSession(options, { helper, overlayRoot })
const roots: string[] = []

async function project(files: Record<string, string>): Promise<{ source: string; builds: string }> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-phase0-'))
  roots.push(root)
  const source = join(root, 'project'), builds = join(root, 'builds')
  await mkdir(source)
  for (const [name, text] of Object.entries(files)) await writeFile(join(source, name), text)
  return { source, builds }
}
async function compile(files: Record<string, string>, mainFile: string, engine: 'pdflatex' | 'xelatex') {
  const paths = await project(files)
  const deps: CompilerDependencies = { platform: 'darwin', macAccepted: true, runtimes: { get: async () => prepared } as never,
    createSession: session, latch: { latched: false } }
  const compiler = new LocalCompiler(paths.source, paths.builds, dataRoot, undefined, deps)
  const result = await compiler.run({ mainFile, engine })
  if (!result.ok) console.info(`--- log tail (${mainFile}, ${engine}) ---\n${result.log.slice(-3000)}`)
  return { result, compiler, deps }
}
const ARTICLE = '\\documentclass{article}\n\\begin{document}\nHello from the sandbox. $e^{i\\pi}+1=0$\n\\end{document}\n'
afterAll(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe.skipIf(!enabled)('REAL macOS App Sandbox acceptance (explicit opt-in)', () => {
  it('runs on macOS with a helper and resources supplied', () => {
    expect(process.platform).toBe('darwin'); expect(helper).not.toBe(''); expect(resources).not.toBe('')
  })

  it('Q1: the ad-hoc signed helper starts inside the App Sandbox and reports its container', async () => {
    const paths = await project({ 'main.tex': ARTICLE })
    await mkdir(join(paths.source, '.paperstudio-output'))
    const active = await session({ executable: join(runtimeRoot, ...DARWIN_TOOLS.pdflatex.split('/')), runtimeRoot, workDirs: [paths.source] })
    console.info(`snapshot root inside the sandbox: ${active.remoteRoot}`)
    expect(active.remoteRoot).toMatch(/^\//)
    await active.dispose()
  }, 60_000)

  it('Q2+Q4: the product self-test passes (real PDF; user data, outside writes and network refused)', async () => {
    const result = await runMacSelfTest(runtimeRoot, dataRoot, { createSession: session })
    console.info(`self-test passed; XeLaTeX accepted on this Mac: ${result.xelatex}`)
    expect(result).toHaveProperty('xelatex')
  }, 120_000)

  it('Q4 (informational): what else the sandbox can read', async () => {
    const paths = await project({ 'main.tex': ARTICLE })
    await mkdir(join(paths.source, '.paperstudio-output'))
    const active = await session({ executable: join(runtimeRoot, ...DARWIN_TOOLS.pdflatex.split('/')), runtimeRoot, workDirs: [paths.source] })
    const rows: Array<{ path: string; read: string }> = []
    for (const path of ['/etc/hosts', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts', '/Applications', '/Users/Shared',
      join(homedir(), '.zshrc'), join(homedir(), 'Library', 'Preferences'), join(runtimeRoot, ...DARWIN_TOOLS.pdflatex.split('/'))])
      rows.push({ path, read: (await active.probe('read', path)).allowed ? 'ALLOWED' : 'denied' })
    console.table(rows)
    await active.dispose()
  }, 60_000)

  // The same gate the app uses before it offers compilation, with this build's values standing in for the pins.
  it.skipIf(!process.env.PAPERSTUDIO_MAC_TREE_SHA256)('the app\u2019s own verification accepts this bundle and refuses a wrong pin', async () => {
    const tree = process.env.PAPERSTUDIO_MAC_TREE_SHA256 ?? ''
    const helperHash = createHash('sha256').update(await readFile(helper)).digest('hex')
    const trusted = new MacTrustedRuntime({ pins: { tree, helper: helperHash }, candidates: () => [runtimeRoot] })
    const accepted = await trusted.get(dataRoot)
    expect(trusted.failure).toBeNull(); expect(accepted?.engines).toEqual(['pdflatex', 'xelatex'])
    for (const pins of [{ tree: '0'.repeat(64), helper: helperHash }, { tree, helper: '0'.repeat(64) }]) {
      const wrong = new MacTrustedRuntime({ pins, candidates: () => [runtimeRoot] })
      expect(await wrong.get(dataRoot)).toBeNull(); expect(wrong.failure).toContain('校验值不符')
    }
    const paths = await project({ 'main.tex': ARTICLE })
    const compiler = new LocalCompiler(paths.source, paths.builds, dataRoot, undefined, { platform: 'darwin', macAccepted: true,
      runtimes: trusted as never, createSession: trusted.createSession, latch: { latched: false } })
    expect((await compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).ok).toBe(true)
  }, 300_000)

  it('Q2: pdfLaTeX compiles a document through the product compiler', async () => {
    const { result } = await compile({ 'main.tex': ARTICLE }, 'main.tex', 'pdflatex')
    expect(result.ok).toBe(true); expect(result.synctex?.files).toContain('main.tex')
  }, 180_000)

  it('Q6: BibTeX runs in the same session and the citation resolves', async () => {
    const { result } = await compile({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nSee \\cite{knuth84}.\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n',
      'refs.bib': '@book{knuth84, author={Donald E. Knuth}, title={The TeXbook}, publisher={Addison-Wesley}, year={1984}}\n'
    }, 'main.tex', 'pdflatex')
    expect(result.ok).toBe(true); expect(result.log).toContain('BibTeX：处理参考文献'); expect(result.log).toContain('第 3/3 遍')
    // The pass right after BibTeX still warns; only the final pass must be free of undefined citations.
    expect(result.log.slice(result.log.lastIndexOf('遍\n'))).not.toMatch(/undefined/i)
  }, 180_000)

  it('Q5a: XeLaTeX compiles and xdvipdfmx converts inside the sandbox', async () => {
    const { result } = await compile({ 'main.tex': ARTICLE }, 'main.tex', 'xelatex')
    expect(result.ok).toBe(true)
  }, 180_000)

  it('Q5b: a ctex document finds the system Chinese fonts by name', async () => {
    const { result } = await compile({ 'main.tex': '\\documentclass{ctexart}\n\\begin{document}\n中文排版测试：你好，世界。\n\\end{document}\n' }, 'main.tex', 'xelatex')
    expect(result.ok).toBe(true)
  }, 180_000)

  it('a Chinese main file name compiles (NFD/NFC file names)', async () => {
    const { result } = await compile({ '中文论文.tex': ARTICLE }, '中文论文.tex', 'pdflatex')
    expect(result.ok).toBe(true)
  }, 180_000)

  it('a TeX error is reported and the compiler stays usable', async () => {
    const { result, compiler, deps } = await compile({ 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n' }, 'main.tex', 'pdflatex')
    expect(result.ok).toBe(false); expect(deps.latch).toEqual({ latched: false })
    expect((await compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).ok).toBe(false)
  }, 180_000)

  it('shell escape is refused inside the sandbox', async () => {
    const { result } = await compile({ 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\immediate\\write18{touch /tmp/latexstudio-write18}\nx\n\\end{document}\n' }, 'main.tex', 'pdflatex')
    expect(result.ok).toBe(true) // the document compiles; the command must not have run
    const { existsSync } = await import('node:fs')
    expect(existsSync('/tmp/latexstudio-write18')).toBe(false)
  }, 180_000)

  it('cancels an endless run with confirmed cleanup and can compile again', async () => {
    const paths = await project({ 'main.tex': '\\def\\x{\\x}\\x\n' })
    const deps: CompilerDependencies = { platform: 'darwin', macAccepted: true, runtimes: { get: async () => prepared } as never,
      createSession: session, latch: { latched: false } }
    const compiler = new LocalCompiler(paths.source, paths.builds, dataRoot, undefined, deps)
    const running = compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })
    await new Promise(resolve => setTimeout(resolve, 4000))
    compiler.cancel()
    const result = await running
    expect(result.canceled).toBe(true); expect(deps.latch).toEqual({ latched: false })
    await writeFile(join(paths.source, 'main.tex'), ARTICLE)
    expect((await compiler.run({ mainFile: 'main.tex', engine: 'pdflatex' })).ok).toBe(true)
  }, 240_000)
})
