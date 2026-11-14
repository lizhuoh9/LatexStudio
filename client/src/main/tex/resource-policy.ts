/** Pure release metadata policy. No public manifest can grant executable or Chinese capabilities. */
export const TEX_RELEASE = '2026.11'
export const RUNTIME_MANIFEST = 'paperstudio-runtime.json'
export interface TexAsset { platform: 'win32' | 'darwin'; url: string; bytes: number; sha256: string; archive: 'zip' | 'tar.xz' }
export const TEX_ASSETS: Readonly<Record<'win32' | 'darwin', TexAsset>> = {
  win32: { platform: 'win32', archive: 'zip', bytes: 247432160,
    url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-v2026.11.zip',
    sha256: 'a13d14ba987873d1bdf81773f5bdfcc34537882b825dd2134f61eb6ee21d5f69' },
  darwin: { platform: 'darwin', archive: 'tar.xz', bytes: 210514532,
    url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-darwin-v2026.11.tar.xz',
    sha256: 'a54a3a16aca1717580b1cc0e4965791487c0650a450d1502dda457dd68e41962' }
}
export interface ManagedTexManifest {
  schema: 1
  id: string
  ready: true
  platform: 'win32' | 'darwin'
  distribution: 'texlive'
  version: typeof TEX_RELEASE
  assetSha256: string
  engines: { pdflatex: string; xelatex: string }
  tools: { xdvipdfmx: string }
  binaryHashes: Record<string, string>
  /** This base release has no accepted Chinese supplement. Resource presence never proves compilation. */
  chineseResources: false
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/
const FIELDS = ['schema', 'id', 'ready', 'platform', 'distribution', 'version', 'assetSha256',
  'engines', 'tools', 'binaryHashes', 'chineseResources'] as const
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
export function isRuntimeId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
/** Windows engines are the patched overlay binaries (see patched-engines.ts); the TinyTeX bin/windows entries are
 * never launched because their kpathsea fails path initialization under AppContainer. */
export function enginePaths(platform: 'win32' | 'darwin'): ManagedTexManifest['engines'] & ManagedTexManifest['tools'] {
  if (platform === 'win32') return { pdflatex: 'install/bin/paperstudio-x64/pdflatex.exe',
    xelatex: 'install/bin/paperstudio-x64/xelatex.exe', xdvipdfmx: 'install/bin/paperstudio-x64/xdvipdfmx.exe' }
  const base = 'install/bin/universal-darwin/'
  return { pdflatex: `${base}pdflatex`, xelatex: `${base}xelatex`, xdvipdfmx: `${base}xdvipdfmx` }
}
/** Metadata index only. Callers must additionally verify the app-pinned whole tree and real platform acceptance. */
export function validateManifest(value: unknown): ManagedTexManifest {
  if (!record(value) || !exactFields(value, FIELDS)) throw new Error('TeX 资源清单字段无效')
  const m = value
  if (m.schema !== 1 || m.ready !== true || !isRuntimeId(m.id) || m.distribution !== 'texlive' ||
    m.version !== TEX_RELEASE || (m.platform !== 'win32' && m.platform !== 'darwin')) throw new Error('TeX 资源版本或平台无效')
  const paths = enginePaths(m.platform), hashes = m.binaryHashes
  if (m.assetSha256 !== TEX_ASSETS[m.platform].sha256 || m.chineseResources !== false ||
    !record(m.engines) || !exactFields(m.engines, ['pdflatex', 'xelatex']) ||
    !record(m.tools) || !exactFields(m.tools, ['xdvipdfmx']) ||
    m.engines.pdflatex !== paths.pdflatex || m.engines.xelatex !== paths.xelatex || m.tools.xdvipdfmx !== paths.xdvipdfmx ||
    !record(hashes) || !exactFields(hashes, Object.values(paths))) throw new Error('TeX 资源来源或能力清单不匹配')
  const binaryHashes: Record<string, string> = {}
  for (const path of Object.values(paths)) {
    const hash = hashes[path]
    if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('TeX 工具校验记录缺失')
    binaryHashes[path] = hash
  }
  return { schema: 1, id: m.id, ready: true, platform: m.platform, distribution: 'texlive', version: TEX_RELEASE,
    assetSha256: TEX_ASSETS[m.platform].sha256, engines: { pdflatex: paths.pdflatex, xelatex: paths.xelatex },
    tools: { xdvipdfmx: paths.xdvipdfmx }, binaryHashes, chineseResources: false }
}
