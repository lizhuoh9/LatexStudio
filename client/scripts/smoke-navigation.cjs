// Lead-only after BUILDREADY: node scripts/smoke-navigation.cjs --run
// Real built Main/preload/renderer; fresh owned profile, no native compile/network/build/deletion/hard kill.
const assert = require('node:assert/strict'), fs = require('node:fs'), { join, resolve } = require('node:path')
const { tmpdir } = require('node:os'), { randomUUID, createHash } = require('node:crypto')
const { spawn } = require('node:child_process'), git = require('isomorphic-git')
const root = resolve(__dirname, '..'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function main() {
  assert.equal(process.platform, 'win32'); assert.deepEqual(process.argv.slice(2), ['--run'])
  const work = fs.mkdtempSync(join(tmpdir(), 'paperstudio-navigation-')), owner = randomUUID(), profile = join(work, 'profile')
  fs.writeFileSync(join(work, 'fixture-owner'), owner, { flag: 'wx' }); fs.mkdirSync(profile)
  const parent = { pid: process.pid, work, childPid: null, checkpoints: [] }
  const mark = (stage, extra = {}) => { parent.checkpoints.push({ stage, time: new Date().toISOString(), ...extra }); fs.writeFileSync(join(work, 'parent.json'), JSON.stringify(parent, null, 2)) }
  mark('fixture-created'); console.log('NAVIGATION_SMOKE_TEMP=' + work)
  const f = { work, owner, profile, projects: {}, build: {} }
  for (const key of ['a', 'b']) {
    const name = 'Navigation-' + key.toUpperCase(), dir = join(work, name)
    fs.mkdirSync(dir); fs.mkdirSync(join(dir, 'chapters/sections'), { recursive: true }); fs.mkdirSync(join(dir, 'emptydir'))
    for (const [path, content] of Object.entries({ 'main.tex': `% PROJECT_${key.toUpperCase()}_ONLY\n\\documentclass{article}\n\\begin{document}Paper ${key}\\end{document}\n`, 'chapters/intro.tex': `% NESTED_${key.toUpperCase()}\n`, 'chapters/sections/detail.tex': `% DETAIL_${key.toUpperCase()}\n` })) fs.writeFileSync(join(dir, path), content, { flag: 'wx' })
    await git.init({ fs, dir, defaultBranch: 'main' }); await git.add({ fs, dir, filepath: ['main.tex', 'chapters/intro.tex', 'chapters/sections/detail.tex'] })
    await git.commit({ fs, dir, message: 'Owned navigation fixture', author: { name: 'Fixture Writer', email: 'fixture@example.invalid' } })
    f.projects[key] = { dir, name }
  }
  for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html']) f.build[name] = hash(fs.readFileSync(join(root, 'out', name)))
  fs.writeFileSync(join(work, 'fixture.json'), JSON.stringify(f, null, 2), { flag: 'wx' })
  for (const name of ['stdout.log', 'stderr.log']) fs.writeFileSync(join(work, name), '', { flag: 'wx' })
  const env = { ...process.env, NAV_WORK: work, NAV_TOKEN: owner }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[name]
  mark('before-spawn'); const child = spawn(require('electron'), [join(__dirname, 'smoke-navigation-electron.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  parent.childPid = child.pid ?? null; mark('spawn-returned')
  for (const [stream, name] of [[child.stdout, 'stdout.log'], [child.stderr, 'stderr.log']]) { let size = 0; stream.on('data', chunk => { if ((size += chunk.length) <= 1024 * 1024) fs.appendFileSync(join(work, name), chunk) }) }
  try {
    await new Promise((done, fail) => {
      const requestStop = () => { mark('cooperative-stop'); if (child.connected) child.send({ kind: 'navigation-stop' }) }
      const stop = setTimeout(requestStop, 90000)
      const retain = reason => { clearTimeout(stop); clearTimeout(bound); clearTimeout(bootstrap); requestStop(); mark('owner-retained-cleanup-unknown', { reason }); child.unref(); child.stdout.unref?.(); child.stderr.unref?.(); if (child.connected) child.disconnect(); fail(new Error(reason)) }
      const bound = setTimeout(() => retain('120s deadline: owner retained, no kill/deletion/retry'), 120000)
      const bootstrap = setTimeout(() => { if (!fs.existsSync(join(work, 'result.json'))) retain('No earliest child-entry report after 15s; inspect stderr, owner retained') }, 15000)
      child.once('error', error => { clearTimeout(stop); clearTimeout(bound); clearTimeout(bootstrap); mark('spawn-error', { error: String(error) }); fail(error) })
      child.once('exit', (code, signal) => { clearTimeout(stop); clearTimeout(bound); clearTimeout(bootstrap); mark('child-exit', { code, signal }); code === 0 ? done() : fail(new Error(`Electron exited ${code}/${signal}`)) })
    })
    const report = JSON.parse(fs.readFileSync(join(work, 'result.json')))
    assert(report.passed && report.safeCloseConfirmed && report.closeAcks > 0 && !report.cleanupUnknown)
    assert.equal(report.forbiddenCalls, 0); assert.equal(report.networkAttempts, 0); assert(report.allowedDriveQueries > 0)
    assert.deepEqual(report.pendingTrackedChannels, []); assert(report.closeReadiness.idle && !report.closeReadiness.dirty)
    fs.mkdirSync(join(root, 'release'), { recursive: true })
    const auth = process.env.PAPERSTUDIO_NAV_AUTH_FIXTURE === '1', modes = auth ? ['authorizing'] : ['startup', 'home', 'editor', 'logs', 'history', 'account-menu', 'account-authenticated']
    for (const mode of modes) fs.copyFileSync(join(work, mode + '.png'), join(root, 'release/navigation-' + mode + '.png'))
    const result = join(root, auth ? 'release/navigation-login-result.json' : 'release/navigation-result.json')
    fs.writeFileSync(result, JSON.stringify({ passed: true, work, build: f.build, checks: report.checks, closeAcks: report.closeAcks, safeCloseConfirmed: report.safeCloseConfirmed, networkAttempts: report.networkAttempts, forbiddenCalls: report.forbiddenCalls, allowedDriveQueries: report.allowedDriveQueries, finishedAt: report.finishedAt }, null, 2))
    console.log('PASS_NAVIGATION_GUI=' + result)
  } catch (error) { mark('failed', { error: String(error) }); throw error }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
