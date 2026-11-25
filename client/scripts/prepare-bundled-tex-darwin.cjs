'use strict'
// Publisher/developer step on a real Mac. Stages the pinned TinyTeX tree for the app bundle and reports the values
// the release pins need. It never edits source files, never runs TeX and never touches an app profile.
//
//   node scripts/prepare-bundled-tex-darwin.cjs
//
// Result: resources/tex-darwin/install (TinyTeX v2026.11 with every symbolic link removed; the app only ever starts
// the real pdftex/xetex/xdvipdfmx/bibtex files) and a JSON report on stdout.
const fs = require('node:fs')
const { lstat, mkdir, mkdtemp, readdir, rename, rm, unlink } = require('node:fs/promises')
const { spawnSync } = require('node:child_process')
const { join, resolve, sep } = require('node:path')

const CLIENT = resolve(__dirname, '..')
const TEX_SOURCE = join(CLIENT, 'src/main/tex')
const TOOLS = ['pdftex', 'xetex', 'xdvipdfmx', 'bibtex']
const FORMATS = ['texmf-var/web2c/pdftex/pdflatex.fmt', 'texmf-var/web2c/xetex/xelatex.fmt']
const MACHO = new Set(['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])

/** The app's own TypeScript (digest, hashing, download policy), so the staged value is computed exactly as the app checks it. */
function loadTexModules() {
  const ts = require('typescript')
  const previous = require.extensions['.ts']
  require.extensions['.ts'] = (module, filename) => {
    if (!filename.startsWith(TEX_SOURCE + sep)) throw new Error('Unexpected TypeScript input in TeX bundle build')
    const source = fs.readFileSync(filename, 'utf8')
    if (source.includes('import.meta')) throw new Error('Unsupported module syntax in TeX bundle build')
    module._compile(ts.transpileModule(source, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
    } }).outputText, filename)
  }
  try {
    return { ...require(join(TEX_SOURCE, 'manifest.ts')), ...require(join(TEX_SOURCE, 'download.ts')),
      ...require(join(TEX_SOURCE, 'catalog.ts')) }
  } finally {
    if (previous) require.extensions['.ts'] = previous
    else delete require.extensions['.ts']
  }
}

/** Removes every symbolic link below `directory` (bin/universal-darwin aliases and script links); returns the count. */
async function removeLinks(directory) {
  let removed = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isSymbolicLink()) { await unlink(file); removed++ }
    else if (entry.isDirectory()) removed += await removeLinks(file)
    else if (!entry.isFile()) throw new Error(`Special file in the TeX archive: ${entry.name}`)
  }
  return removed
}

function machO(file) {
  const descriptor = fs.openSync(file, 'r')
  try {
    const magic = Buffer.alloc(4)
    return fs.readSync(descriptor, magic, 0, 4, 0) === 4 && MACHO.has(magic.toString('hex'))
  } finally { fs.closeSync(descriptor) }
}

async function inspect(installation, hashFile) {
  const tools = {}, formats = {}, missing = []
  for (const name of TOOLS) {
    const file = join(installation, 'bin', 'universal-darwin', name)
    try {
      const info = await lstat(file)
      if (!info.isFile() || !(info.mode & 0o111) || !machO(file)) throw new Error('not a native executable')
      tools[name] = await hashFile(file)
    } catch { missing.push(`bin/universal-darwin/${name}`) }
  }
  for (const path of FORMATS) {
    try { formats[path] = await hashFile(join(installation, ...path.split('/'))) } catch { missing.push(path) }
  }
  return { tools, formats, missing }
}

async function stage(options = {}, dependencies) {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') throw new Error('The macOS TeX tree can only be staged on macOS')
  const { TEX_ASSETS, downloadTexAsset, hashFile, installationDigest } = dependencies ?? loadTexModules()
  const asset = TEX_ASSETS.darwin
  if (asset.platform !== 'darwin' || asset.archive !== 'tar.xz') throw new Error('Expected the fixed macOS tar.xz asset')
  const root = resolve(options.clientRoot ?? CLIENT), target = join(root, 'resources', 'tex-darwin')
  if (fs.existsSync(target)) throw new Error('resources/tex-darwin already exists; remove it first (no silent replacement)')
  const cache = join(root, 'resources', 'tex-darwin-cache')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  // Host allowlist, fixed size and SHA-256 are enforced by the app's own download policy.
  const archive = await downloadTexAsset(asset, cache, { signal: options.signal, fetcher: options.fetcher, onProgress: options.onProgress })
  const scratch = await mkdtemp(join(root, 'resources', 'tex-darwin-staging-'))
  try {
    const extract = (options.extract ?? ((file, directory) => spawnSync('/usr/bin/tar', ['-xJf', file, '-C', directory], { stdio: 'inherit', shell: false })))(archive, scratch)
    if (extract.error || extract.status !== 0) throw new Error('tar could not extract the TeX archive')
    const top = await readdir(scratch)
    // Tolerates the leading dot directory some TinyTeX archives use; anything else is unexpected.
    const name = top.length === 1 && ['TinyTeX', '.TinyTeX'].includes(top[0]) ? top[0] : null
    if (!name) throw new Error(`Unexpected archive layout: ${top.join(', ')}`)
    const symbolicLinksRemoved = await removeLinks(join(scratch, name))
    await mkdir(target, { mode: 0o755 })
    await rename(join(scratch, name), join(target, 'install'))
    const installation = join(target, 'install')
    const report = await inspect(installation, hashFile)
    return { platform, source: asset.url, archiveSha256: asset.sha256, archiveBytes: asset.bytes, installation: 'resources/tex-darwin/install',
      symbolicLinksRemoved, ...report, treeSha256: await installationDigest(installation),
      next: report.missing.length ? 'INCOMPLETE: the listed files are missing; do not pin this tree' :
        'Set DARWIN_INSTALL_TREE_SHA256 in src/main/tex/darwin-runtime.ts to treeSha256 only after real-Mac acceptance' }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

async function main(argv) {
  if (argv.length) throw new Error('Usage: node scripts/prepare-bundled-tex-darwin.cjs (fixed macOS resource only)')
  let previous = -1
  const result = await stage({ onProgress: ({ received, total }) => {
    const percent = Math.floor(100 * received / total)
    if (percent >= previous + 10 || (percent === 100 && previous !== 100)) { previous = percent; console.error(`macOS TeX: ${percent}% (${received}/${total} bytes)`) }
  } })
  console.log(JSON.stringify(result, null, 2))
  if (result.missing.length) process.exitCode = 2
}
module.exports = { stage, removeLinks, inspect, main }
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
