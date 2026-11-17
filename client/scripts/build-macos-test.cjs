// Build on a real Mac; never uploads, installs, opens personal projects or enables TeX.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const root = path.resolve(__dirname, '..')
/** Must stay in step with `artifactName` in electron-builder.mac-test.cjs and the link in docs/RELEASE-NOTES.md. */
function artifactName(version, arch) { return `LatexStudio-${version}-mac-${arch}-test.dmg` }
/** One DMG for the CPU of the Mac that runs the build. The release runner is Apple Silicon, so releases carry arm64 only. */
function plan(platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin') throw new Error('Mac test applications must be built on macOS; this Windows source kit is not an app/DMG.')
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Only native arm64 or x64 Mac builds are supported.')
  return { arch, builder: ['--mac', 'dmg', '--' + arch, '--config', 'electron-builder.mac-test.cjs', '--publish', 'never'] }
}
function run(executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status ?? result.signal}); no successful artifact receipt written.`)
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
  run(process.execPath, [path.join(__dirname, 'audit-source.cjs')], env)
  for (const config of ['tsconfig.node.json', 'tsconfig.web.json']) run(process.execPath, [bin('typescript', 'tsc'), '--noEmit', '-p', config], env)
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => /^editor-.*\.test\.ts$/.test(name)).map(name => 'tests/' + name)
  run(process.execPath, [bin('vitest'), 'run', 'tests/mac-desktop.test.ts', 'tests/macos-build.test.ts', 'tests/app-icon.test.ts', 'tests/workspace-window.test.ts', ...tests], env)
  run(process.execPath, [bin('electron-vite'), 'build'], env)
  run(process.execPath, [bin('electron-builder'), ...build.builder], env)
  const { version } = require('../package.json'), output = path.join(root, 'release/macos-test')
  const artifact = artifactName(version, build.arch)
  const app = path.join(output, build.arch === 'arm64' ? 'mac-arm64' : 'mac', 'LatexStudio.app')
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], env)
  const receipt = { kind: 'macos-editing-test-build-v2', version, platform: process.platform, arch: build.arch, format: 'dmg',
    artifact, sha256: await sha256(path.join(output, artifact)), bytes: fs.statSync(path.join(output, artifact)).size,
    signing: 'ad-hoc; not Developer ID', notarized: false, guiTested: false, texCompilationEnabled: false,
    checks: ['source-audit', 'typecheck', 'editing-contract-tests', 'production-build', 'codesign-verify'], finishedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(output, 'TEST-BUILD.json'), JSON.stringify(receipt, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), `${receipt.sha256}  ${artifact}\n`)
  console.log('Mac editing-test artifact: ' + path.join(output, artifact))
  console.log('Ad-hoc build only. GUI/first launch remain untested; TeX compilation is not enabled.')
}
module.exports = { plan, artifactName }
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
