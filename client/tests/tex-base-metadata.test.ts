import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditChineseBase, latexSourceDate, packageHeader } from '../src/main/tex/base-metadata'
const slash = String.fromCharCode(92)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-base-metadata-')); roots.push(root)
  const install = join(root, 'install'); await mkdir(install)
  return { root, install }
}
async function put(install: string, path: string, text: string) {
  const file = join(install, 'texmf-dist', path)
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, text)
  return file
}
describe('bounded static TeX metadata — never a compiled-format or Chinese capability', () => {
  it.each(['2026/06/01', '2026-06-01'])('normalizes source date %s', date => {
    expect(latexSourceDate(`${slash}def${slash}fmtversion{${date}}`)).toBe('2026-06-01')
    expect(latexSourceDate(`${slash}edef ${slash}fmtversion {${date}}`)).toBe('2026-06-01')
  })
  it.each(['2026/02/30', '2026/13/01', '2026/00/01', 'not-a-date'])('rejects invalid date %s', date => {
    expect(latexSourceDate(`${slash}def${slash}fmtversion{${date}}`)).toBeNull()
  })
  it('reads modern expl headers and classic package headers without exposing source', () => {
    expect(packageHeader('fontspec', `${slash}ProvidesExplPackage {fontspec} {2026/08/11} {2.9h} {text}`))
      .toEqual({ present: true, date: '2026-08-11', version: '2.9h' })
    expect(packageHeader('expl3', `${slash}ProvidesPackage{expl3}[2025-10-09 v1.2 public description]`))
      .toEqual({ present: true, date: '2025-10-09', version: '1.2' })
  })
  it('handles generated comment separators and one literal loader date without evaluating macros', () => {
    expect(packageHeader('fontspec', `${slash}ProvidesExplPackage{fontspec}% comment\n{2026/08/11}{2.9h}{text}`).date).toBe('2026-08-11')
    const source = `${slash}def${slash}ExplFileDate{2026-09-09}%\n${slash}ProvidesPackage{expl3}[%\n${slash}ExplFileDate${slash}space public]`
    expect(packageHeader('expl3', source).date).toBe('2026-09-09')
    expect(packageHeader('expl3', source + `\n${slash}def${slash}ExplFileDate{2026-10-10}`).date).toBeNull()
    expect(packageHeader('expl3', `${slash}ProvidesPackage{expl3}[${slash}unknownDate public]`).date).toBeNull()
  })
  it('does not substitute another package, a copyright date or arbitrary version payload', () => {
    expect(packageHeader('fontspec', `${slash}ProvidesPackage{unrelated}[2026/08/11 v9]\nCopyright 2026/08/11`))
      .toEqual({ present: true, date: null, version: null })
    expect(packageHeader('fontspec', `${slash}ProvidesExplPackage{fontspec}{2026/08/11}{SECRET value}{x}`).version).toBeNull()
    expect(packageHeader('expl3', null)).toEqual({ present: false, date: null, version: null })
  })
})
describe('safe bounded metadata reads and explicitly unverified formats', () => {
  it('keeps minimum-source hints separate from missing files and actual formats', async () => {
    const { install } = await fixture()
    await put(install, 'tex/latex/base/latex.ltx', `${slash}def${slash}fmtversion{2026-06-01}`)
    await put(install, 'tex/latex/l3kernel/expl3.sty', `${slash}ProvidesPackage{expl3}[2025/10/09 public]`)
    const result = await auditChineseBase(install)
    expect(result.minimumSourceDatesMet).toBe(true)
    expect(result.missingBaseFiles).toContain('fontspec')
    expect(result.formatCompatibilityVerified).toBe(false)
    expect(result.chineseCompilationVerified).toBe(false)
  })
  it('fails the date hint for older or unknown source headers', async () => {
    const { install } = await fixture()
    const file = await put(install, 'tex/latex/base/latex.ltx', `${slash}def${slash}fmtversion{2025-11-01}`)
    await put(install, 'tex/latex/l3kernel/expl3.sty', `${slash}ProvidesPackage{expl3}[2026/01/01 public]`)
    expect((await auditChineseBase(install)).minimumSourceDatesMet).toBe(false)
    await writeFile(file, 'unknown header')
    expect((await auditChineseBase(install)).latexSourceDate).toBeNull()
  })
  it('uses only the bounded header and leaves files unchanged', async () => {
    const { install } = await fixture()
    const text = 'x'.repeat(64 * 1024) + `${slash}def${slash}fmtversion{2026-06-01}`
    const file = await put(install, 'tex/latex/base/latex.ltx', text)
    expect((await auditChineseBase(install)).latexSourceDate).toBeNull()
    expect(await readFile(file, 'utf8')).toBe(text)
  })
  it('rejects a linked parent instead of reading external metadata or leaking provider paths', async () => {
    const { root, install } = await fixture(); const external = join(root, 'external')
    await mkdir(external); await writeFile(join(external, 'latex.ltx'), 'PRIVATE_METADATA_SENTINEL')
    const parent = join(install, 'texmf-dist/tex/latex'); await mkdir(parent, { recursive: true })
    await symlink(external, join(parent, 'base'), 'junction')
    await expect(auditChineseBase(install)).rejects.toThrow('基础 TeX 元数据无法安全读取')
    expect(await readFile(join(external, 'latex.ltx'), 'utf8')).toBe('PRIVATE_METADATA_SENTINEL')
  })
  it('rejects directory-as-header and cancels before traversal', async () => {
    const { install } = await fixture()
    await mkdir(join(install, 'texmf-dist/tex/latex/base/latex.ltx'), { recursive: true })
    await expect(auditChineseBase(install)).rejects.toThrow('无法安全读取')
    const controller = new AbortController(); controller.abort()
    await expect(auditChineseBase(install, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
