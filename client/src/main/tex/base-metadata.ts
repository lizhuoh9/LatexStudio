import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { assertPrivateDirectory, contained } from './manifest'

export interface PackageMetadata { present: boolean; date: string | null; version: string | null }
export interface ChineseBaseMetadata {
  latexSourceDate: string | null
  packages: Record<string, PackageMetadata>
  minimumSourceDatesMet: boolean
  missingBaseFiles: string[]
  formatCompatibilityVerified: false
  chineseCompilationVerified: false
}
const CANDIDATES = {
  expl3: ['tex/latex/l3kernel/expl3.sty'],
  fontspec: ['tex/latex/fontspec/fontspec.sty'],
  'fontspec-xetex': ['tex/latex/fontspec/fontspec-xetex.sty'],
  xtemplate: ['tex/latex/l3packages/xtemplate/xtemplate.sty', 'tex/latex/xtemplate/xtemplate.sty', 'tex/latex/base/xtemplate.sty'],
  'fix-cm': ['tex/latex/base/fix-cm.sty', 'tex/latex/fix-cm/fix-cm.sty'],
  fontenc: ['tex/latex/base/fontenc.sty']
} as const
function normalizedDate(value: string): string | null {
  if (!/^20\d{2}[-/]\d{2}[-/]\d{2}$/.test(value)) return null
  const text = value.replaceAll('/', '-'), date = new Date(`${text}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null
}
function withoutComments(header: string): string { return header.replace(/(^|[^\\])%[^\r\n]*/g, '$1') }
function constantDate(token: string, source: string): string | null {
  const value = token.trim()
  if (!/^\\ExplFileDate(?:\\space)?$/.test(value)) return normalizedDate(value)
  const definitions = [...source.matchAll(/\\(?:e?def)\s*\\ExplFileDate\s*\{(20\d{2}[-/]\d{2}[-/]\d{2})\}/g)]
  return definitions.length === 1 ? normalizedDate(definitions[0]?.[1] ?? '') : null
}
export function latexSourceDate(header: string): string | null {
  const value = /\\(?:e?def)\s*\\fmtversion\s*\{(20\d{2}[-/]\d{2}[-/]\d{2})\}/.exec(withoutComments(header))?.[1]
  return value ? normalizedDate(value) : null
}
/** Header hints only: strip comments and recognize one literal ExplFileDate; never evaluate TeX or authorize execution. */
export function packageHeader(name: string, header: string | null): PackageMetadata {
  if (header === null) return { present: false, date: null, version: null }
  const pattern = /\\Provides(?:Expl)?(?:Package|File)\s*\{([^{}]{1,80})\}\s*(?:\{([^{}]{1,30})\}\s*\{([^{}]{1,40})\}|\[([^\]]{1,150})\])/g
  const source = withoutComments(header)
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== name && match[1] !== `${name}.sty`) continue
    const classic = match[4] ?? ''
    const date = constantDate((match[2] ?? classic.trim().split(/\s+/)[0]) ?? '', source)
    const version = match[3] ?? /\s+v([A-Za-z0-9.+-]{1,32})(?:\s|$)/.exec(classic)?.[1] ?? null
    return { present: true, date, version: version && /^[A-Za-z0-9.+-]{1,32}$/.test(version) ? version : null }
  }
  return { present: true, date: null, version: null }
}
async function header(installation: string, path: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted()
  const file = join(installation, 'texmf-dist', ...path.split('/'))
  try {
    await assertPrivateDirectory(dirname(file))
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 192 * 1024 * 1024 || !contained(installation, await realpath(file)))
      throw new Error('基础 TeX 元数据文件类型无效')
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const current = await handle.stat()
      if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size) throw new Error('基础 TeX 元数据读取时发生变化')
      const bytes = Buffer.alloc(Math.min(info.size, 64 * 1024))
      const result = await handle.read(bytes, 0, bytes.length, 0)
      signal?.throwIfAborted()
      return bytes.subarray(0, result.bytesRead).toString('utf8')
    } finally { await handle.close() }
  } catch (error) {
    signal?.throwIfAborted()
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('基础 TeX 元数据无法安全读取')
  }
}
/** Static known-TDS evidence only. Caller must separately authenticate the entire installation. */
export async function auditChineseBase(installation: string, signal?: AbortSignal): Promise<ChineseBaseMetadata> {
  if (!isAbsolute(installation) || resolve(installation) === parse(resolve(installation)).root) throw new Error('基础 TeX 元数据目录无效')
  signal?.throwIfAborted()
  await assertPrivateDirectory(installation)
  const latex = latexSourceDate(await header(installation, 'tex/latex/base/latex.ltx', signal) ?? '')
  const packages: Record<string, PackageMetadata> = {}
  for (const [name, paths] of Object.entries(CANDIDATES)) {
    let text: string | null = null
    for (const path of paths) { text = await header(installation, path, signal); if (text !== null) break }
    packages[name] = packageHeader(name, text)
  }
  signal?.throwIfAborted()
  const expl3 = packages.expl3?.date
  return { latexSourceDate: latex, packages,
    minimumSourceDatesMet: !!latex && latex >= '2026-06-01' && !!expl3 && expl3 >= '2025-10-09',
    missingBaseFiles: Object.entries(packages).filter(([, value]) => !value.present).map(([name]) => name),
    formatCompatibilityVerified: false, chineseCompilationVerified: false }
}
