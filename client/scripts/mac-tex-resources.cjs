'use strict'
// Packaging facts for the macOS compile resources. Read-only: decides what a Mac build may include, changes nothing.
const fs = require('node:fs')
const path = require('node:path')

const CLIENT = path.resolve(__dirname, '..')
/** Where prepare-bundled-tex-darwin.cjs stages the pinned tree; build.sh copies it into the helper bundle. */
const STAGED_TREE = 'resources/tex-darwin'
const HELPER = 'resources/darwin/LatexStudioCompiler.app'
const HELPER_BINARY = `${HELPER}/Contents/MacOS/latexstudio-compiler`
/** The helper's App Sandbox reads its own bundle and nothing in the user's home, so TeX ships inside the helper. */
const TREE = `${HELPER}/Contents/Resources/tex-darwin`
const PACKAGES = `${HELPER}/Contents/Resources/tex-packages`

function isDirectory(file) {
  try { const info = fs.lstatSync(file); return info.isDirectory() && !info.isSymbolicLink() } catch { return false }
}
function isFile(file) {
  try { const info = fs.lstatSync(file); return info.isFile() && !info.isSymbolicLink() } catch { return false }
}
/** A helper built WITH the TeX tree and the package tree inside it; a bare or half-built helper packages nothing. */
function staged(clientRoot = CLIENT) {
  return isFile(path.join(clientRoot, HELPER_BINARY)) && isDirectory(path.join(clientRoot, TREE, 'install')) &&
    isFile(path.join(clientRoot, PACKAGES, 'manifest.json'))
}
/** The two release pins in darwin-runtime.ts, or null unless both are 64-hex values. */
function pins(clientRoot = CLIENT) {
  const source = fs.readFileSync(path.join(clientRoot, 'src/main/tex/darwin-runtime.ts'), 'utf8')
  // A declaration this cannot read is an error, never "no pin": that would quietly build an app without compilation.
  const read = name => {
    const found = new RegExp(`^export const ${name}: string \\| null = (null|'[a-f0-9]{64}')$`, 'm').exec(source)
    if (!found) throw new Error(`Cannot read ${name} in src/main/tex/darwin-runtime.ts`)
    return found[1] === 'null' ? null : found[1].slice(1, -1)
  }
  const tree = read('DARWIN_INSTALL_TREE_SHA256'), helper = read('MAC_HELPER_SHA256')
  if (Boolean(tree) !== Boolean(helper)) throw new Error('Only one of the two macOS release pins is set in src/main/tex/darwin-runtime.ts')
  return tree && helper ? { tree, helper } : null
}
/** True only when the app itself will offer compilation. */
function pinned(clientRoot = CLIENT) { return pins(clientRoot) !== null }
/**
 * Extra bundle inputs for electron-builder: the helper bundle as a whole, TeX included. It keeps the bytes that were
 * pinned and its own signature seal, so it is excluded from re-signing, which would rewrite every Mach-O file inside
 * and replace the helper's App Sandbox entitlement with the app's own entitlements.
 */
function macTexResources(clientRoot = CLIENT) {
  if (!staged(clientRoot)) return { extraResources: [], signIgnore: [] }
  return {
    extraResources: [{ from: 'resources/darwin', to: 'darwin', filter: ['LatexStudioCompiler.app/**'] }],
    // Both the files inside the helper bundle and the bundle folder itself: the signer signs a nested .app by its
    // folder path, and a pattern that ends in '/' let that through (seen on the first real DMG build).
    signIgnore: ['/Contents/Resources/darwin/LatexStudioCompiler\\.app(/|$)']
  }
}
module.exports = { macTexResources, staged, pins, pinned, STAGED_TREE, TREE, PACKAGES, HELPER, HELPER_BINARY }
