import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { posix } from 'node:path'

export interface MacSandbox { command: string; argsPrefix: string[]; env: NodeJS.ProcessEnv }
export const MAC_SANDBOX_STATUS = 'experimental: sandbox-exec is deprecated; real Mac acceptance is required'
const RUNNER = '/usr/bin/sandbox-exec'
const ENGINE = /^(.*)\/bin\/(?:universal-darwin|x86_64-darwin|arm64-darwin)\/(?:pdftex|pdflatex|xetex|xelatex|xdvipdfmx)$/
const RUNTIME = /^\/Users\/[^/]+\/Library\/Application Support\/PaperStudio\/tex\/runtimes\/paperstudio-tex-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\/install$/
const TOOL_NAMES = ['pdflatex', 'pdftex', 'xelatex', 'xetex', 'xdvipdfmx']
const ALIAS = /^\/Library\/TeX\/texbin\/(?:pdftex|pdflatex|xetex|xelatex)$/
const SYSTEM_READ = ['/usr/lib', '/System/Library/Frameworks', '/System/Library/PrivateFrameworks',
  '/System/Library/Fonts', '/Library/Fonts', '/usr/share/icu', '/usr/share/locale',
  '/usr/share/zoneinfo.default', '/private/var/db/timezone', '/System/Library/dyld',
  '/System/Cryptexes/OS', '/System/Cryptexes/App', '/System/Volumes/Preboot/Cryptexes/OS',
  '/System/Volumes/Preboot/Cryptexes/App', '/Library/Apple/System/Library/Frameworks']

function fail(message: string): Error { return new Error(`macOS 原生隔离不可用，已拒绝编译：${message}`) }
function macOnly(): void { if (process.platform !== 'darwin') throw fail('必须在真实 macOS 上验证，不能使用 Windows/WSL/VM 代替') }
function absolute(path: string): string {
  if (typeof path !== 'string' || !posix.isAbsolute(path) || path.startsWith('//') || path.endsWith('/') || path === '/' ||
    path !== posix.normalize(path) || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(path) ||
    /[\uD800-\uDFFF]/u.test(path) || Buffer.byteLength(path) > 1024)
    throw fail('需要无跳转、控制字符或非法编码的本机绝对路径')
  return path
}
function within(root: string, path: string): boolean { return path === root || path.startsWith(`${root}/`) }
function installationRoot(executable: string): string {
  const root = ENGINE.exec(absolute(executable))?.[1]
  const installed = root && /^\/usr\/local\/texlive\/20\d{2}(?:basic)?$/.test(root)
  const managed = root && /^\/(?:Users\/[^/]+\/Library\/Application Support\/PaperStudio|Applications\/PaperStudio\.app\/Contents\/Resources)\/tex\/[a-f0-9]{64}\/TinyTeX$/.test(root)
  if (!root || (!installed && !managed && !RUNTIME.test(root)))
    throw fail('仅接受专属 TeX Live、候选摘要 TinyTeX 或应用 UUIDv4 runtime install 布局')
  if (posix.basename(executable) === 'xdvipdfmx' && !RUNTIME.test(root))
    throw fail('converter 仅接受应用 UUIDv4 runtime 的固定原生工具，不开放系统或项目工具')
  return root
}
function snapshot(path: string): string {
  const work = absolute(path)
  if (!/^paperstudio-[a-z0-9-]{6,100}$/i.test(posix.basename(posix.dirname(work))))
    throw fail('工作目录必须是应用随机创建的独立快照子目录')
  return work
}
function rootsFor(executable: string, work: string, roots: readonly string[]): string[] {
  const installation = installationRoot(executable)
  if (!Array.isArray(roots) || roots.length !== 1 || absolute(roots[0] ?? '') !== installation)
    throw fail('只读授权必须恰好是该引擎的专属 TeX 根，不能授权整个 /usr、Library 或用户目录')
  if (within(installation, work) || within(work, installation)) throw fail('TeX 安装与快照目录必须独立')
  return [installation, ...SYSTEM_READ]
}
function quoted(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` }
function filters(paths: readonly string[], operation: 'literal' | 'subpath'): string {
  return paths.map((path) => `(${operation} ${quoted(path)})`).join(' ')
}
function ancestors(paths: readonly string[]): string[] {
  const result = new Set<string>(['/'])
  for (const path of paths) {
    let parent = posix.dirname(path)
    while (parent !== '/') { result.add(parent); parent = posix.dirname(parent) }
  }
  return [...result]
}

/** Pure policy builder, NOT a platform/self-test success indication. No project-provided SBPL. */
export function buildMacSandboxProfile(executable: string, workDir: string, readRoots: readonly string[]): string {
  const engine = absolute(executable)
  const work = snapshot(workDir)
  const roots = rootsFor(engine, work, readRoots)
  return ['(version 1)', '(deny default)', '(deny network*)', '(deny process-fork)',
    `(allow process-exec (literal ${quoted(engine)}))`,
    `(allow file-read* ${filters([...roots, work], 'subpath')})`,
    `(allow file-read-metadata ${filters(ancestors([...roots, work]), 'literal')})`,
    `(allow file-write* (subpath ${quoted(work)}))`,
    `(allow file-map-executable (literal ${quoted(engine)}) ${filters(roots, 'subpath')})`,
    '(allow file-read-data (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write-data (literal "/dev/null"))', '(allow signal (target self))',
    '(allow sysctl-read (sysctl-name "hw.machine") (sysctl-name "hw.ncpu") (sysctl-name "hw.pagesize")',
    '  (sysctl-name "kern.ostype") (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion"))'].join('\n')
}

/** Deliberately does not inherit HOME, PATH, DYLD_*, TeX hooks, credentials or user font config. */
export function macSandboxEnvironment(workDir: string, executable: string): NodeJS.ProcessEnv {
  const work = snapshot(workDir)
  installationRoot(executable)
  return { PATH: `${posix.dirname(executable)}:/usr/bin:/bin`, HOME: work, TMPDIR: work, TMP: work, TEMP: work,
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TEXMFOUTPUT: work, TEXMFVAR: work, TEXMFCONFIG: work,
    TEXMFHOME: work, TEXMFCACHE: work, TEXINPUTS: '.:', BIBINPUTS: '.:', BSTINPUTS: '.:',
    openin_any: 'p', openout_any: 'p', shell_escape: 'f', MKTEXPK: '0', MKTEXTFM: '0', MKTEXFMT: '0' }
}

async function noLinks(path: string, directory: boolean): Promise<string> {
  const selected = absolute(path)
  let current = selected
  while (current !== '/') {
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw fail('路径经过符号链接，不能作为授权根或快照')
    current = posix.dirname(current)
  }
  const info = await lstat(selected)
  if (directory ? !info.isDirectory() : !info.isFile()) throw fail('授权路径类型错误')
  const actual = absolute(await realpath(selected))
  if (actual !== selected) throw fail('授权目录被重定向，必须使用真实路径')
  return actual
}
async function macho(path: string, system = false): Promise<void> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || !(before.mode & 0o111) || before.mode & 0o002 ||
    (system && (before.uid !== 0 || before.mode & 0o022))) throw fail('可执行文件的类型或权限不可信')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw fail('可执行文件在检查期间被替换')
    const magic = Buffer.alloc(4)
    const { bytesRead } = await handle.read(magic, 0, 4, 0)
    if (bytesRead !== 4 || !['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex')))
      throw fail('只运行原生 Mach-O 引擎，不执行脚本或项目启动文件')
  } finally { await handle.close() }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > 32) throw fail('runtime manifest 对象结构无效')
  return value as Record<string, unknown>
}
function sha(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) }
function toolPath(value: unknown, names: readonly string[]): string {
  if (typeof value !== 'string' ||
    !/^install\/bin\/(?:universal-darwin|arm64-darwin|x86_64-darwin)\/[a-z]+$/.test(value) ||
    !names.includes(posix.basename(value))) throw fail('runtime manifest 只允许固定原生工具的 install 相对路径')
  return value
}
function runtimePaths(value: unknown, id: string): string[] {
  const manifest = object(value)
  const fields = ['schema', 'id', 'ready', 'platform', 'distribution', 'version', 'assetSha256', 'engines', 'tools', 'binaryHashes', 'chineseResources']
  if (Object.keys(manifest).some((key) => !fields.includes(key)) || manifest.schema !== 1 || manifest.id !== id ||
    manifest.ready !== true || manifest.platform !== 'darwin' || manifest.distribution !== 'texlive' ||
    manifest.version !== '2026.11' || !sha(manifest.assetSha256) ||
    ('chineseResources' in manifest && typeof manifest.chineseResources !== 'boolean'))
    throw fail('runtime manifest 身份或就绪字段无效')
  const engines = object(manifest.engines)
  const tools = object(manifest.tools)
  const hashes = object(manifest.binaryHashes)
  if (Object.keys(engines).some((key) => !['pdflatex', 'xelatex'].includes(key)) ||
    Object.keys(tools).some((key) => key !== 'xdvipdfmx')) throw fail('runtime manifest 工具名称无效')
  const paths = [toolPath(engines.pdflatex, ['pdflatex', 'pdftex']),
    toolPath(engines.xelatex, ['xelatex', 'xetex']), toolPath(tools.xdvipdfmx, ['xdvipdfmx'])]
  for (const [path, hash] of Object.entries(hashes)) {
    toolPath(path, TOOL_NAMES)
    if (!sha(hash)) throw fail('runtime manifest 二进制摘要结构无效')
  }
  if (paths.some((path) => !sha(hashes[path]))) throw fail('runtime manifest 缺少工具摘要')
  return paths
}
async function readRuntimeManifest(container: string): Promise<unknown> {
  try {
    const path = await noLinks(`${container}/paperstudio-runtime.json`, false)
    const before = await lstat(path)
    if (before.uid !== process.getuid?.() || before.mode & 0o022 || before.size > 64 * 1024)
      throw fail('runtime manifest 权限或大小不符合应用专属合同')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw fail('runtime manifest 已被替换')
      const buffer = Buffer.alloc(64 * 1024 + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 64 * 1024) throw fail('runtime manifest 超过大小限制')
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))) as unknown
    } finally { await handle.close() }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('macOS 原生隔离不可用')) throw error
    throw fail('应用 runtime manifest 不可读或编码/JSON 非法')
  }
}
async function validateRuntime(executable: string, root: string): Promise<void> {
  const id = RUNTIME.exec(root)?.[1]
  if (!id) return
  const container = posix.dirname(root)
  const info = await lstat(container)
  const install = await lstat(root)
  if (process.getuid?.() === undefined || info.uid !== process.getuid() || install.uid !== process.getuid() ||
    (info.mode | install.mode) & 0o022) throw fail('runtime 容器和 install 必须属于当前用户且不可由组/其他用户写入')
  const paths = runtimePaths(await readRuntimeManifest(container), id)
  const actual = await Promise.all(paths.map((path) => realpath(`${container}/${path}`)))
  if (!actual.includes(executable)) throw fail('指定原生工具不属于该 runtime manifest')
}

async function enginePath(executable: string): Promise<string> {
  const selected = absolute(executable)
  const actual = absolute(await realpath(selected))
  const root = installationRoot(actual)
  if (selected !== actual && !ALIAS.test(selected) && (!within(root, selected) || !ENGINE.test(selected)))
    throw fail('不接受项目或任意路径指向引擎的符号链接')
  await noLinks(actual, false)
  await noLinks(root, true)
  await macho(actual)
  await validateRuntime(actual, root)
  return actual
}

/** Checks runtime identity/layout, NOT download provenance or binary digests; installer must verify both. */
export async function macTexReadRoots(executable: string): Promise<string[]> {
  macOnly()
  return [installationRoot(await enginePath(executable))]
}

/** Experimental deprecated system backend. Caller MUST gate readiness on full real-Mac self-tests. */
export async function prepareMacSandbox(executable: string, workDir: string, readRoots: string[]): Promise<MacSandbox> {
  macOnly()
  try {
    const engine = await enginePath(executable)
    const work = await noLinks(snapshot(workDir), true)
    const parent = await lstat(posix.dirname(work))
    if (process.getuid?.() === undefined || parent.uid !== process.getuid() || parent.mode & 0o077)
      throw fail('快照父目录必须属于当前用户且仅当前用户可访问')
    if (!Array.isArray(readRoots) || readRoots.length !== 1) throw fail('必须提供唯一的已准备 TeX 安装根')
    const roots = await Promise.all(readRoots.map((root) => noLinks(root, true)))
    const profile = buildMacSandboxProfile(engine, work, roots)
    await noLinks(RUNNER, false)
    await macho(RUNNER, true)
    return { command: RUNNER, argsPrefix: ['-p', profile, engine], env: macSandboxEnvironment(work, engine) }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('macOS 原生隔离不可用')) throw error
    throw fail('系统 sandbox-exec 或已准备的 TeX 资源缺失/不可读；不会降级为直接运行引擎')
  }
}
