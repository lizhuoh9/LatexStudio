import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const diagnostic = vi.hoisted(() => ({ text: '' }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args)
    child.stderr?.on('data', (bytes: Buffer) => { diagnostic.text = (diagnostic.text + bytes.toString('utf8')).slice(-8192) })
    return child
  } }
})
function nativeFailureCode(): string {
  const kind = /class=([A-Za-z0-9.]{1,80})/.exec(diagnostic.text)?.[1] ?? 'unknown'
  const code = /;win32=([0-9]{1,10}|none)/.exec(diagnostic.text)?.[1] ?? 'none'
  const hresult = /hresult=(0x[0-9A-Fa-f]{8})/.exec(diagnostic.text)?.[1] ?? 'none'
  return `class=${kind};win32=${code};hresult=${hresult}`
}
beforeEach(() => { diagnostic.text = '' })
import { createWindowsSandboxSession } from '../src/main/sandbox/windows'
import { createBuild, removeBuild } from '../src/main/local/build'
import { findPreparedTex } from '../src/main/tex/prepare'
import { assertPrivateDirectory, hashFile } from '../src/main/tex/manifest'
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_MANAGED_TEX_SMOKE === '1'
const slash = String.fromCharCode(92)
const document = [slash + 'documentclass{article}', slash + 'begin{document}',
  'PaperStudio managed native TeX fixture.', slash + 'end{document}', ''].join(String.fromCharCode(10))
it('keeps the managed fixture as TeX command bytes with real LF newlines', () => {
  const bytes = Buffer.from(document)
  expect([...bytes.subarray(0, 2)]).toEqual([92, 100])
  expect(bytes.includes(10)).toBe(true)
  expect(bytes.includes(13)).toBe(false)
})
async function checkHelper(): Promise<void> {
  const hash = await hashFile(resolve('resources/win32/PaperStudio.Sandbox.exe'))
  if (process.env.PAPERSTUDIO_EXPECT_SANDBOX_SHA256) expect(hash).toBe(process.env.PAPERSTUDIO_EXPECT_SANDBOX_SHA256.toLowerCase())
  console.info(`PAPERSTUDIO_NATIVE_HELPER_SHA256=${hash}`)
}
async function preservePreview(engine: string, pdf: Buffer): Promise<void> {
  const base = resolve('release/native-tex-lab/results')
  await mkdir(base, { recursive: true, mode: 0o700 })
  await assertPrivateDirectory(base)
  const path = join(base, `${engine}-${randomUUID()}.pdf`)
  await writeFile(path, pdf, { flag: 'wx', mode: 0o600 })
  console.info(`PAPERSTUDIO_NATIVE_PDF=${engine};bytes=${pdf.length};file=${relative(process.cwd(), path).split(sep).join('/')}`)
}
/** Real app-owned TeX only; never grants ACLs to an existing user MiKTeX/TeX Live installation. */
describe.skipIf(!enabled)('real managed Windows TeX through the production session', () => {
  it.each(['pdflatex', 'xelatex'] as const)('generates a bounded PDF candidate using %s without child processes', async engine => {
    await checkHelper()
    const data = resolve('release/native-tex-lab')
    const prepared = await findPreparedTex(join(data, 'tex/runtimes'), 'win32')
    expect(prepared, 'First run the explicit fixed resource preparation + catalog verification').not.toBeNull()
    if (!prepared) throw new Error('Missing trusted runtime')
    const project = join(data, 'fixture-project')
    await mkdir(project, { recursive: true })
    const build = await createBuild(project, join(data, 'builds'))
    const source = join(build, 'source'), probe = join(build, 'probe')
    await mkdir(source); await mkdir(probe); await mkdir(join(source, '.paperstudio-output'))
    await writeFile(join(source, 'main.tex'), document, { flag: 'wx' })
    const executable = join(prepared.root, prepared.manifest.engines[engine])
    const session = await createWindowsSandboxSession({ executable, runtimeRoot: prepared.root,
      tools: { xdvipdfmx: join(prepared.root, prepared.manifest.tools.xdvipdfmx) }, workDirs: [source, probe], timeoutMs: 120000 })
      .catch(() => { throw new Error(`隔离会话启动未通过验收：${nativeFailureCode()}；未输出原始诊断/路径。`) })
    let output = '', cleanup = false, candidate: Buffer | undefined
    try {
      const format = join(prepared.root, 'install/texmf-var/web2c', engine === 'pdflatex' ? 'pdftex/pdflatex.fmt' : 'xetex/xelatex.fmt')
      const args = ['-no-shell-escape', '-no-parse-first-line', `-progname=${engine}`, `-fmt=${format}`,
        '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder', '-jobname=paperstudio',
        '-output-directory=./.paperstudio-output', ...(engine === 'xelatex' ? ['-no-pdf'] : []), './main.tex']
      const record = (bytes: Buffer): void => { output = (output + bytes.toString('utf8')).slice(-65536) }
      for (let pass = 0; pass < 2; pass++) {
        const result = await session.run(args, source, { onStdout: record, onStderr: record })
        expect(result.code, output).toBe(0)
      }
      if (engine === 'xelatex') {
        const result = await session.run(['-o', './.paperstudio-output/paperstudio.pdf', './.paperstudio-output/paperstudio.xdv'], source,
          { tool: 'xdvipdfmx', onStdout: record, onStderr: record })
        expect(result.code, output).toBe(0)
      }
      const pdf = candidate = await readFile(join(source, '.paperstudio-output/paperstudio.pdf'))
      expect(pdf.length).toBeGreaterThan(1024); expect(pdf.length).toBeLessThan(32 * 1024 * 1024)
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdf.subarray(-1024).includes(Buffer.from('%%EOF'))).toBe(true)
    } finally {
      try { await session.dispose(); cleanup = true }
      catch { throw new Error(`隔离会话终态未通过验收：${nativeFailureCode()}；保留测试快照，禁止直接执行。`) }
      if (cleanup) await removeBuild(build)
    }
    if (candidate) await preservePreview(engine, candidate)
  }, 180000)
})
