// Read-only Windows release gate. Never signs, installs, launches or changes executables.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const { constants } = require('node:fs')

function sameIdentity(before, after) {
  return after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && before.dev === after.dev &&
    before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}
/** Read-only gate. Expected metadata injection is for pure fixtures; audit/CLI always use the fixed policy. */
async function verifyBundledTex(resources, expected) {
  const policy = require('./prepare-bundled-tex.cjs').loadTexModules()
  const asset = expected ?? policy.TEX_ASSETS.win32
  if (asset.platform !== 'win32' || asset.archive !== 'zip' || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 512 * 1024 * 1024)
    throw new Error('Invalid fixed Windows TeX bundle metadata')
  const directory = path.join(resources, 'tex-runtime'), name = `${asset.sha256}.zip`
  await policy.assertPrivateDirectory(directory)
  if ((await fs.readdir(directory)).some(entry => entry !== name && entry !== 'README.md'))
    throw new Error('Unexpected or duplicate bundled TeX files')
  const file = path.join(directory, name), before = await fs.lstat(file)
  if (!sameIdentity(before, before) || before.size !== asset.bytes) throw new Error('Bundled TeX file identity/size mismatch')
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!sameIdentity(before, await handle.stat())) throw new Error('Bundled TeX changed before verification')
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(128 * 1024)
    let bytes = 0
    for (;;) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, asset.bytes - bytes + 1), bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > asset.bytes) throw new Error('Bundled TeX exceeds fixed size')
      digest.update(buffer.subarray(0, read.bytesRead))
    }
    const sha256 = digest.digest('hex')
    if (bytes !== asset.bytes || sha256 !== asset.sha256 || !sameIdentity(before, await handle.stat()) ||
      !sameIdentity(before, await fs.lstat(file))) throw new Error('Bundled TeX SHA-256/identity mismatch')
    await policy.assertPrivateDirectory(directory)
    return { passed: true, file: `tex-runtime/${name}`, bytes, sha256 }
  } finally { await handle.close() }
}

async function regular(file) {
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular, non-link file')
  return fs.readFile(file)
}
async function tree(root, prefix = '') {
  const result = []
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Links are not accepted in release inputs')
    const name = prefix + entry.name
    if (entry.isDirectory()) result.push(...await tree(root, name + '/'))
    else if (entry.isFile()) result.push(name)
    else throw new Error('Special release input refused')
  }
  return result.sort()
}
function parseManifest(text) {
  const entries = new Map()
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line)
    if (!match || entries.has(match[2])) throw new Error('Invalid or duplicate checksum entry')
    entries.set(match[2], match[1])
  }
  return entries
}
async function compareArchive(client, archive, asar = require('@electron/asar')) {
  const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'))
  const files = await tree(path.join(client, 'out'))
  const expected = files.map(name => '/out/' + name)
  const mismatches = entries.filter(name => name.startsWith('/out/') && !expected.includes(name) && !entries.some(other => other.startsWith(name + '/')))
  for (const file of files) {
    const name = 'out/' + file
    if (!entries.includes('/' + name)) { mismatches.push(name); continue }
    if (!asar.extractFile(archive, path.join(...name.split('/'))).equals(await regular(path.join(client, name)))) mismatches.push(name)
  }
  for (const name of ['THIRD_PARTY_NOTICES.md', 'src/vendor/ayakaleaf/LICENSE.txt']) {
    if (!entries.includes('/' + name) || !asar.extractFile(archive, path.join(...name.split('/'))).equals(await regular(path.join(client, name)))) mismatches.push(name)
  }
  const sourcePackage = JSON.parse(await regular(path.join(client, 'package.json')))
  const builtPackage = JSON.parse(asar.extractFile(archive, 'package.json'))
  for (const field of ['name', 'version', 'main', 'license', 'dependencies'])
    if (JSON.stringify(sourcePackage[field]) !== JSON.stringify(builtPackage[field])) mismatches.push('package.json:' + field)
  return { passed: files.length > 0 && mismatches.length === 0, checked: files.length + 3, mismatches }
}
async function signature(file, runner = execute, platform = process.platform) {
  if (platform !== 'win32') return { valid: false, status: 'unsupported-platform' }
  const quoted = file.replaceAll("'", "''")
  const command = `$s=Get-AuthenticodeSignature -LiteralPath '${quoted}'; [pscustomobject]@{status=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint;timestamped=($null -ne $s.TimeStamperCertificate)} | ConvertTo-Json -Compress`
  try {
    const { stdout } = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 30_000, windowsHide: true, maxBuffer: 65536 })
    const data = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    return { valid: data.status === 'Valid' && /^[a-f0-9]{40}$/i.test(data.thumbprint ?? ''), status: String(data.status), thumbprint: data.thumbprint ?? null, timestamped: data.timestamped === true }
  } catch { return { valid: false, status: 'signature-check-unavailable' } }
}
function signatureApproved(result) { return result?.valid === true && result.timestamped === true }
function formalAcceptance(receipt, installerHash, archiveHash) {
  const cases = ['originalExecutableUnmodified', 'firstRun', 'offlineReopen', 'chineseAndBibtex', 'cancelAndRetry', 'dirtyCloseAndRestart', 'upgradePreservesProject', 'uninstallPreservesProject', 'noLeftoverProcesses']
  return receipt?.kind === 'formal-installed-acceptance-v1' && receipt.installerSha256 === installerHash && receipt.appAsarSha256 === archiveHash &&
    receipt.method === 'manual-original-signed-executable' && cases.every(name => receipt.cases?.[name] === true)
}
async function attempt(action, fallback) { try { return await action() } catch { return fallback } }
async function sourceSnapshot(client) {
  const records = []
  for (const dir of ['src', 'resources', 'scripts']) for (const file of await tree(path.join(client, dir)))
    records.push(dir + '/' + file + ':' + hash(await regular(path.join(client, dir, file))))
  for (const file of ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'tsconfig.node.json', 'tsconfig.web.json', 'THIRD_PARTY_NOTICES.md'])
    records.push(file + ':' + hash(await regular(path.join(client, file))))
  return hash(records.sort().join('\n'))
}
async function audit(options = {}) {
  const client = options.client ?? path.resolve(__dirname, '..')
  const pkg = JSON.parse(await regular(path.join(client, 'package.json')))
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Unsupported release version')
  const release = path.join(client, 'release'), archive = path.join(release, 'win-unpacked/resources/app.asar')
  const names = ['setup', 'portable'].map(kind => `PaperStudio-${pkg.version}-win-x64-${kind}.exe`)
  const manifest = await attempt(async () => parseManifest((await regular(path.join(release, 'SHA256SUMS.txt'))).toString('utf8')), new Map())
  const artifacts = []
  for (const name of names) {
    const bytes = await attempt(() => regular(path.join(release, name)), null)
    const digest = bytes ? hash(bytes) : null
    artifacts.push({ file: name, bytes: bytes?.length ?? null, sha256: digest, checksumMatches: digest !== null && manifest.get(name) === digest,
      signature: bytes ? await (options.signature ?? signature)(path.join(release, name)) : { valid: false, status: 'missing' } })
  }
  const archiveHash = await attempt(async () => hash(await regular(archive)), null)
  const sourceTreeSha256 = await attempt(() => sourceSnapshot(client), null)
  const packaged = await attempt(() => compareArchive(client, archive), { passed: false, reason: 'archive-or-build-unavailable' })
  const bundledTex = await attempt(() => verifyBundledTex(path.join(release, 'win-unpacked/resources')),
    { passed: false, reason: 'bundled-tex-unavailable-or-invalid' })
  const appSignature = await (options.signature ?? signature)(path.join(release, 'win-unpacked/PaperStudio.exe'))
  let installed = { passed: false, reason: 'installed-dir-not-supplied' }
  if (options.installedDir) installed = await attempt(async () => {
    const installedArchive = path.join(options.installedDir, 'resources/app.asar')
    const checked = await compareArchive(client, installedArchive)
    return { ...checked, sameAsPackaged: archiveHash !== null && hash(await regular(installedArchive)) === archiveHash,
      bundledTex: await verifyBundledTex(path.join(options.installedDir, 'resources')),
      signature: await (options.signature ?? signature)(path.join(options.installedDir, 'PaperStudio.exe')) }
  }, { passed: false, reason: 'installed-input-unavailable' })
  const receipt = options.receipt ? await attempt(async () => JSON.parse(await regular(options.receipt)), null) : null
  const gates = { checksums: artifacts.every(item => item.checksumMatches), signatures: artifacts.every(item => signatureApproved(item.signature)) && signatureApproved(appSignature),
    buildPackage: packaged.passed, bundledTex: bundledTex.passed,
    sourceBuildAttestation: sourceTreeSha256 !== null && receipt?.sourceTreeSha256 === sourceTreeSha256 && receipt?.buildVerified === true,
    installedPackage: installed.passed && installed.sameAsPackaged === true && installed.bundledTex?.passed === true && signatureApproved(installed.signature),
    formalInstallation: archiveHash !== null && formalAcceptance(receipt, artifacts[0].sha256, archiveHash) }
  return { kind: 'windows-release-audit-v1', version: pkg.version, scope: 'Windows package only; not macOS or two-machine NAS acceptance',
    ready: Object.values(gates).every(Boolean), gates, blockers: Object.keys(gates).filter(name => !gates[name]), artifacts, appSignature,
    appAsarSha256: archiveHash, sourceTreeSha256, packaged, bundledTex, installed, acceptanceEvidence: 'Manual receipt is an operator assertion, not independent or cryptographic proof' }
}
function argumentsOf(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--client': 'client', '--installed-dir': 'installedDir', '--acceptance': 'receipt' }[argv[i]]
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --client DIR --installed-dir DIR --acceptance FILE (all optional)')
    result[key] = path.resolve(argv[i + 1])
  }
  return result
}
module.exports = { audit, hash, parseManifest, compareArchive, signature, signatureApproved, formalAcceptance, sourceSnapshot, argumentsOf, verifyBundledTex }
if (require.main === module) audit(argumentsOf(process.argv.slice(2))).then(report => {
  console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ready ? 0 : 2
}).catch(() => { console.error('Release audit failed: inputs unavailable or invalid; no release approval issued.'); process.exitCode = 1 })
