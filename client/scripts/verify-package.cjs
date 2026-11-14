const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const asar = require('@electron/asar')
const { verifyBundledTex } = require('./release-audit.cjs')
const root = join(__dirname, '..')

async function verifyArchive() {
  const archive = join(root, 'release/win-unpacked/resources/app.asar')
  const entries = asar.listPackage(archive).map((path) => path.replaceAll('\\', '/'))
  const assets = entries.filter((path) => path.startsWith('/out/renderer/assets/') && /\.(js|css)$/.test(path))
  for (const path of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', ...assets.map((path) => path.slice(1))]) {
    assert(entries.includes('/' + path), `Missing packaged resource ${path}`)
    assert(asar.extractFile(archive, join(...path.split('/'))).equals(await readFile(join(root, path))), `Stale packaged ${path}`)
  }
  assert(entries.some((path) => /\/out\/renderer\/assets\/.+\.js$/.test(path)))
  assert(entries.some((path) => /\/out\/renderer\/assets\/.+\.css$/.test(path)))
  // Main externalizes runtime dependencies, so node_modules is expected; development tools must never be packed.
  const { devDependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys(devDependencies))
    assert(!entries.some((path) => path.startsWith(`/node_modules/${name}/`)), `runtime archive must not include dev tool ${name}`)
  console.log('PASS app.asar contains current main/preload/renderer/assets and no development dependencies')
}

// Read-only only: never launches the app, creates a profile, or interrupts automatic preparation.
async function main() {
  await verifyArchive()
  await verifyBundledTex(join(root, 'release/win-unpacked/resources'))
  console.log('PASS fixed bundled Windows TeX ZIP: exact size and SHA-256')
}
module.exports = { verifyArchive, verifyBundledTex }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
