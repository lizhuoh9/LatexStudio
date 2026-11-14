'use strict'
// Publisher build step only. Never extracts/executes TeX or touches an app profile.
const fs = require('node:fs')
const { lstat, mkdir, readdir } = require('node:fs/promises')
const { basename, join, relative, resolve } = require('node:path')

const CLIENT = resolve(__dirname, '..')
function loadTexModules() {
  const ts = require('typescript'), directory = join(CLIENT, 'src/main/tex')
  const allowed = new Set(['resource-policy.ts', 'manifest.ts', 'download.ts'].map(name => join(directory, name)))
  const previous = require.extensions['.ts']
  require.extensions['.ts'] = (module, filename) => {
    if (!allowed.has(filename)) throw new Error('Unexpected TypeScript input in TeX bundle build')
    const source = fs.readFileSync(filename, 'utf8')
    if (source.includes('import.meta')) throw new Error('Unsupported module syntax in TeX bundle build')
    module._compile(ts.transpileModule(source, { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
    } }).outputText, filename)
  }
  try {
    return { ...require(join(directory, 'manifest.ts')), ...require(join(directory, 'download.ts')) }
  } finally {
    if (previous) require.extensions['.ts'] = previous
    else delete require.extensions['.ts']
  }
}
async function outputDirectory(clientRoot, assertPrivateDirectory) {
  await assertPrivateDirectory(clientRoot)
  const resources = join(clientRoot, 'resources'), output = join(resources, 'tex-runtime')
  await assertPrivateDirectory(resources)
  try { await mkdir(output, { mode: 0o700 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  await assertPrivateDirectory(output)
  return output
}
async function assertStagedFile(path, asset) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== asset.bytes ||
    basename(path) !== `${asset.sha256}.zip`) throw new Error('Bundled TeX archive identity is invalid')
}
function assertBundleMapping(pkg, asset) {
  const inputs = pkg?.build?.win?.extraResources
  const matches = Array.isArray(inputs) ? inputs.filter(item => item.to === 'tex-runtime') : []
  const wanted = [`${asset.sha256}.zip`, 'README.md']
  if (matches.length !== 1 || matches[0].from !== 'resources/tex-runtime' ||
    JSON.stringify(matches[0].filter) !== JSON.stringify(wanted))
    throw new Error('Windows bundle mapping does not match the fixed TeX asset; update the exact ZIP filter')
}
/** Tests inject small fixed metadata and fetch fixtures; the CLI never accepts URLs/assets/paths. */
async function stageBundledTex(options = {}, dependencies) {
  const production = dependencies === undefined
  const { TEX_ASSETS, downloadTexAsset, assertPrivateDirectory } = dependencies ?? loadTexModules()
  if (production) assertBundleMapping(JSON.parse(fs.readFileSync(join(CLIENT, 'package.json'), 'utf8')), TEX_ASSETS.win32)
  const platform = options.platform ?? 'win32'
  if (platform !== 'win32') throw new Error('Bundled TeX is accepted for Windows only; macOS is unverified')
  const asset = TEX_ASSETS.win32
  if (asset.platform !== 'win32' || asset.archive !== 'zip') throw new Error('Expected the fixed Windows ZIP asset')
  const root = resolve(options.clientRoot ?? CLIENT), directory = await outputDirectory(root, assertPrivateDirectory)
  const expected = `${asset.sha256}.zip`
  const entries = await readdir(directory)
  if (entries.some(name => name !== expected && name !== 'README.md'))
    throw new Error('Unexpected/stale files in bundled TeX resources; refusing duplicate archives or automatic deletion')
  const path = await downloadTexAsset(asset, directory, { signal: options.signal,
    fetcher: options.fetcher, onProgress: options.onProgress })
  if (resolve(path) !== join(directory, expected)) throw new Error('Unexpected bundled TeX archive path')
  await assertPrivateDirectory(directory)
  await assertStagedFile(path, asset)
  return { platform, file: relative(root, path).replaceAll('\\', '/'), bytes: asset.bytes,
    sha256: asset.sha256, source: asset.url, archive: asset.archive }
}
async function main(argv) {
  if (argv.length) throw new Error('Usage: node scripts/prepare-bundled-tex.cjs (fixed Windows resource only)')
  let previous = -1
  const result = await stageBundledTex({ onProgress: ({ received, total }) => {
    const percent = Math.floor(100 * received / total)
    if (percent >= previous + 10 || percent === 100 && previous !== 100) {
      previous = percent; console.error(`Bundled TeX: ${percent}% (${received}/${total} bytes)`)
    }
  } })
  console.log(JSON.stringify(result, null, 2))
}
module.exports = { stageBundledTex, loadTexModules, assertBundleMapping, main }
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1
})
