// Lead-only run: node scripts/smoke-projects.cjs --run D:/Cache/Temp/paperstudio-offline-sUwf5w
// Real built Main/preload/renderer, two launches, NO compile/network/build; never deletes or hard-kills.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, resolve, isAbsolute } = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const git = require('isomorphic-git')
const root = resolve(__dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
function json(path) { return JSON.parse(fs.readFileSync(path, 'utf8')) }
function plain(path, directory) { const s = fs.lstatSync(path); assert(!s.isSymbolicLink()); assert(directory ? s.isDirectory() : s.isFile() && s.nlink === 1); return s }
async function fixture(warm) {
  assert(isAbsolute(warm)); plain(warm, true); plain(join(warm, 'fixture-owner'), false)
  const previous = json(join(warm, 'result.json')), launch = json(join(warm, 'launch.json'))
  assert.equal(previous.passed, true); assert.equal(previous.safeCloseConfirmed, true)
  assert.equal(resolve(launch.work), warm); assert.equal(resolve(launch.profile), join(warm, 'profile')); plain(launch.profile, true)
  const work = fs.mkdtempSync(join(warm, 'projects-')), owner = randomUUID(), profile = launch.profile
  fs.writeFileSync(join(work, 'fixture-owner'), owner, { flag: 'wx' })
  const f = { work, profile, owner, warmOwnerHash: hash(fs.readFileSync(join(warm, 'fixture-owner'))), projects: {}, build: {} }
  for (const key of ['a', 'b']) {
    const dir = join(work, key === 'a' ? 'Project-A' : 'Project-B'), label = key.toUpperCase()
    fs.mkdirSync(dir); fs.writeFileSync(join(dir, 'main.tex'), `% PROJECT_${label}_ONLY\n\\documentclass{article}\n\\begin{document}Paper ${label}\\end{document}\n`, { flag: 'wx' })
    fs.writeFileSync(join(dir, `${key}-only.tex`), `% Only project ${label}\n`, { flag: 'wx' })
    await git.init({ fs, dir, defaultBranch: 'main' })
    await git.add({ fs, dir, filepath: ['main.tex', `${key}-only.tex`] })
    await git.commit({ fs, dir, message: 'Owned local GUI fixture', author: { name: 'Fixture Writer', email: 'fixture@example.invalid' } })
    const binding = { projectId: key === 'a' ? 101 : 202, owner: `fixture-lab-${key}`, name: `paper-${key}`, branch: 'main', accountId: 1 }
    await git.setConfig({ fs, dir, path: 'remote.origin.url', value: `https://github.com/${binding.owner}/${binding.name}.git` })
    fs.writeFileSync(join(dir, '.git', 'paperstudio-app.json'), JSON.stringify(binding) + '\n', { flag: 'wx' })
    f.projects[key] = { dir, name: `Project-${label}`, binding }
  }
  for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) f.build[name] = hash(fs.readFileSync(join(root, 'out', name)))
  fs.writeFileSync(join(work, 'fixture.json'), JSON.stringify(f, null, 2), { flag: 'wx' }); return f
}
async function launch(f, phase) {
  const state = { phase, parentPid: process.pid, childPid: null, events: [] }, path = join(f.work, `parent-${phase}.json`)
  const event = (stage, detail = {}) => { state.events.push({ stage, at: new Date().toISOString(), ...detail }); fs.writeFileSync(path, JSON.stringify(state, null, 2)) }
  const env = { ...process.env, SMOKE_WORK: f.work, SMOKE_TOKEN: f.owner, SMOKE_PHASE: String(phase) }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[key]
  event('before-spawn'); const child = spawn(require('electron'), [join(__dirname, 'smoke-projects-electron.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  state.childPid = child.pid ?? null; event('spawn-returned')
  const log = fs.createWriteStream(join(f.work, `electron-${phase}.log`), { flags: 'wx' }); let bytes = 0, logging = true
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (logging && bytes < 1024 * 1024) { bytes += chunk.length; log.write(chunk) } })
  await new Promise((done, fail) => {
    let settled = false
    const stop = setTimeout(() => { event('90s-cooperative-stop'); if (child.connected) child.send({ kind: 'projects-stop' }) }, 90000)
    const bound = setTimeout(() => {
      settled = true; event('120s-cleanup-unknown-live-process-retained'); clearTimeout(stop)
      logging = false; child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); if (child.connected) child.disconnect(); log.end()
      fail(new Error('Project smoke close unconfirmed; live process retained, do not delete or kill the warm profile'))
    }, 120000)
    child.once('error', error => { event('spawn-error', { error: String(error) }); clearTimeout(stop); clearTimeout(bound); logging = false; log.end(); if (!settled) { settled = true; fail(error) } })
    child.once('exit', (code, signal) => {
      event('child-exit', { code, signal }); clearTimeout(stop); clearTimeout(bound); logging = false; log.end()
      if (!settled) { settled = true; code === 0 ? done() : fail(new Error(`Phase ${phase} exited ${code}/${signal}`)) }
    })
  })
  const report = json(join(f.work, `phase-${phase}.json`)); assert.equal(report.passed, true); assert.equal(report.safeCloseConfirmed, true)
  assert.equal(report.forbiddenCalls, 0); assert.equal(report.networkAttempts, 0)
  assert.deepEqual(report.pendingTrackedChannels, []); assert.equal(report.closeReadiness?.idle, true); assert.equal(report.closeReadiness?.dirty, false)
  assert(Number.isSafeInteger(report.allowedDriveQueries) && report.allowedDriveQueries > 0, 'Real local net use query must be observed separately'); return report
}
async function main() {
  assert.equal(process.argv[2], '--run', 'Explicit --run and owned warm-root path required'); assert(process.argv[3])
  const f = await fixture(resolve(process.argv[3])); console.log('PROJECTS_SMOKE_TEMP=' + f.work)
  const report = { work: f.work, profile: f.profile, passed: false, phases: [] }
  try { for (const phase of [1, 2]) report.phases.push(await launch(f, phase)); report.passed = true }
  finally { fs.writeFileSync(join(f.work, 'result.json'), JSON.stringify(report, null, 2)); console.log('PROJECTS_SMOKE_RESULT=' + join(f.work, 'result.json')) }
  console.log('PASS_PROJECTS_GUI=' + join(f.work, 'current.png'))
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
