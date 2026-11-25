// Build on a real Mac; never uploads, installs or opens personal projects. Whether the app offers TeX compilation is
// decided by the release pins in the source, never by this script.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const macTex = require('./mac-tex-resources.cjs')
const root = path.resolve(__dirname, '..')
/** Must stay in step with `artifactName` in electron-builder.mac-test.cjs and the link in docs/RELEASE-NOTES.md. */
function artifactName(version, arch) { return `LatexStudio-${version}-mac-${arch}-test.dmg` }
/** One DMG for the CPU of the Mac that runs the build. The release runner is Apple Silicon, so releases carry arm64 only. */
function plan(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') throw new Error('Mac test applications must be built on macOS; this Windows source kit is not an app/DMG.')
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Only native arm64 or x64 Mac builds are supported.')
  return { arch, builder: ['--mac', 'dmg', '--' + arch, '--config', 'electron-builder.mac-test.cjs', '--publish', 'never'] }
}
function run(executable, args, env = process.env, label = path.basename(executable)) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed (${result.status ?? result.signal}); no successful artifact receipt written.`)
}
function bin(name, command) {
  const file = require.resolve(name + '/package.json'), pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  return path.resolve(path.dirname(file), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[command || name])
}
async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
/**
 * The packaged helper must be byte-identical to the one that was built and pinned, and must still carry the App
 * Sandbox entitlement: a re-signed helper would lose it and the feature would be silently dead (or worse, trusted).
 */
async function assertPackagedHelper(app) {
  const packaged = path.join(app, 'Contents/Resources', macTex.HELPER_BINARY.replace(/^resources\//, ''))
  if (await sha256(packaged) !== await sha256(path.join(root, macTex.HELPER_BINARY))) throw new Error('The packaged compile helper differs from the built one (was it re-signed?).')
  const shown = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', '-', path.join(app, 'Contents/Resources', macTex.HELPER.replace(/^resources\//, ''))], { encoding: 'utf8', shell: false })
  // The entitlement must be present AND true (codesign prints either a [Key]/[Bool] listing or a property list).
  const sandboxed = /com\.apple\.security\.app-sandbox(<\/key>\s*<true\/>|\s*\[Value\]\s*\[Bool\] true)/.test(`${shown.stdout}${shown.stderr}`)
  if (shown.status !== 0 || !sandboxed) throw new Error('The packaged compile helper does not carry the App Sandbox entitlement.')
  // The helper's seal lists every TeX file inside it: a file the packager dropped or changed fails here.
  const sealed = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path.join(app, 'Contents/Resources', macTex.HELPER.replace(/^resources\//, ''))], { encoding: 'utf8', shell: false })
  if (sealed.status !== 0) throw new Error('The packaged compile helper no longer matches its signature seal: ' + `${sealed.stderr}`.trim())
}
/**
 * With release pins in the source the build must ship the pinned helper, on any build machine: stage the pinned
 * TinyTeX archive when it is not there yet and put the helper together from the committed signed pieces (nothing is
 * compiled or signed here). A helper that is present but is not the pinned one stops the build.
 */
async function ensurePinnedHelper(env) {
  const pins = macTex.pins(root)
  if (!pins) return
  // Cheap and first: the committed pieces must agree with both pins (executable hash; TeX tree digest and package tree
  // recomputed from the signature list). After that a bundle that matches its seal also matches the tree pin, so the
  // tree is not digested again here.
  run(process.execPath, [bin('vitest'), 'run', 'tests/mac-helper-seal.test.ts'], env, 'the committed helper check (tests/mac-helper-seal.test.ts)')
  if (!fs.existsSync(path.join(root, macTex.HELPER))) {
    if (!fs.existsSync(path.join(root, macTex.STAGED_TREE, 'install'))) run(process.execPath, [path.join(__dirname, 'prepare-bundled-tex-darwin.cjs')], env, 'staging TinyTeX (prepare-bundled-tex-darwin.cjs)')
    run('/bin/sh', [path.join(root, 'resources/darwin/compiler/assemble.sh')], env, 'putting the compile helper together (assemble.sh)')
  }
  if (!macTex.staged(root)) throw new Error('The compile helper bundle is incomplete; remove resources/darwin/LatexStudioCompiler.app and build again.')
  if (await sha256(path.join(root, macTex.HELPER_BINARY)) !== pins.helper) throw new Error('The compile helper is not the one pinned in darwin-runtime.ts; remove resources/darwin/LatexStudioCompiler.app and build again.')
  const sealed = spawnSync('/usr/bin/codesign', ['--verify', '--strict', path.join(root, macTex.HELPER)], { encoding: 'utf8', shell: false })
  if (sealed.status !== 0) throw new Error('The compile helper bundle does not match its signature seal: ' + `${sealed.stderr}`.trim())
}
async function main() {
  const build = plan()
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 LTS before building this test kit.')
  if (build.arch === 'x64') {
    const translated = spawnSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8', shell: false })
    if (translated.error) throw translated.error
    if (translated.status === 0 && translated.stdout.trim() === '1') throw new Error('Use native arm64 Node on Apple Silicon, not Rosetta x64 Node.')
  }
  const env = { ...process.env }
  // Do not consume publisher certificates, notarization credentials, CI publishing or Node/Electron override hooks.
  for (const key of Object.keys(env)) if (/^(CSC_|WIN_CSC_|APPLE_|PAPERSTUDIO_|GH_TOKEN$|GITHUB_TOKEN$|ELECTRON_RUN_AS_NODE$|ELECTRON_RENDERER_URL$|NODE_OPTIONS$)/.test(key)) delete env[key]
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  await ensurePinnedHelper(env)
  run(process.execPath, [path.join(__dirname, 'audit-source.cjs')], env)
  for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) run(process.execPath, [bin('typescript', 'tsc'), '--noEmit', '-p', config], env)
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => /^editor-.*\.test\.ts$/.test(name)).map(name => 'tests/' + name)
  const compile = ['sandbox-macos-protocol', 'sandbox-macos-session', 'tex-darwin-runtime', 'tex-compiler-darwin', 'mac-helper-seal'].map(name => `tests/${name}.test.ts`)
  run(process.execPath, [bin('vitest'), 'run', 'tests/mac-desktop.test.ts', 'tests/macos-build.test.ts', 'tests/app-icon.test.ts', 'tests/workspace-window.test.ts', ...compile, ...tests], env)
  run(process.execPath, [bin('electron-vite'), 'build'], env)
  run(process.execPath, [bin('electron-builder'), ...build.builder], env)
  const { version } = require('../package.json'), output = path.join(root, 'release/macos-test')
  const artifact = artifactName(version, build.arch)
  const app = path.join(output, build.arch === 'arm64' ? 'mac-arm64' : 'mac', 'LatexStudio.app')
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], env)
  if (macTex.staged(root)) await assertPackagedHelper(app)
  // Compilation is offered only when the TeX tree and helper were packaged AND the app carries both release pins;
  // even then each Mac must pass the app's own isolation self-test before the Compile button works.
  const texPackaged = macTex.staged(root), texCompilationEnabled = texPackaged && macTex.pinned(root)
  const receipt = { kind: 'macos-editing-test-build-v2', version, platform: process.platform, arch: build.arch, format: 'dmg',
    artifact, sha256: await sha256(path.join(output, artifact)), bytes: fs.statSync(path.join(output, artifact)).size,
    signing: 'ad-hoc; not Developer ID', notarized: false, guiTested: false, texPackaged, texCompilationEnabled,
    checks: ['source-audit', 'typecheck', 'editing-contract-tests', 'production-build', 'codesign-verify'], finishedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(output, 'TEST-BUILD.json'), JSON.stringify(receipt, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${receipt.sha256}  ${artifact}\n`)
  console.log('Mac editing-test artifact: ' + path.join(output, artifact))
  console.log('Ad-hoc build only. GUI/first launch remain untested; TeX compilation is ' +
    (texCompilationEnabled ? 'packaged and pinned (each Mac still runs the isolation self-test).' : 'not enabled.'))
}
module.exports = { plan, artifactName }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
