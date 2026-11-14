// Local Electron UI acceptance with real source Main controllers + built preload/renderer.
// All HTTP is synthetic and fail-closed. Requires a current build; never rebuilds or touches user projects.
const assert = require('node:assert/strict')
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, isAbsolute, join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile), PREFIX = 'paperstudio-cloud-ui-'
const resultPath = resolve(__dirname, '../tests/cloud-ui-smoke-result.json')
const screenshot = resolve(__dirname, '../release/cloud-ui-smoke.png')
async function launch(env) {
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.NODE_OPTIONS
  const child = spawn(require('electron'), [join(__dirname, 'smoke-cloud-electron.cjs')], { env, stdio: 'inherit' })
  let timedOut = false, stopped = Promise.resolve()
  const timer = setTimeout(() => {
    timedOut = true
    stopped = process.platform === 'win32' ? execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined) : Promise.resolve(child.kill('SIGKILL'))
  }, 115000)
  try {
    const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
    await stopped
    if (timedOut) throw new Error('Cloud UI smoke exceeded 115-second deadline')
    assert.equal(code, 0, `Cloud UI Electron exited ${code}`)
  } finally { clearTimeout(timer) }
}
async function removeFixture(work, token) {
  const absolute = await realpath(work), temp = await realpath(tmpdir())
  assert(isAbsolute(absolute) && dirname(absolute) === temp && basename(absolute).startsWith(PREFIX), 'Unsafe fixture cleanup refused')
  assert.equal(await readFile(join(absolute, 'fixture-owner'), 'utf8'), token)
  await rm(absolute, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 })
}
async function main() {
  const work = await mkdtemp(join(tmpdir(), PREFIX)), token = randomUUID(), started = Date.now()
  let report = { ok: false, mode: 'development Electron; TypeScript CommonJS source Main controllers + built preload/renderer', substitutions: ['synthetic fail-closed HTTP fetch', 'native directory and confirmation dialogs', 'test public client ID', 'test-only screenshot watermark'], notValidated: ['real GitHub accounts or network', 'real OAuth approval', 'publisher App installation/configuration', 'built Main bundle entry point', 'original packaged executable', 'code signing', 'real clone/push in this UI smoke', 'two-machine synchronization', 'TeX compilation', 'installer', 'macOS'] }
  const previous = await readFile(resultPath, 'utf8').then(text => JSON.parse(text)).catch(() => null)
  report.priorSuccessfulRuns = [...(previous?.priorSuccessfulRuns || []), ...(previous?.ok === true ?
    [{ elapsedMs: previous.elapsedMs, checks: previous.checks, builtSha256: previous.builtSha256,
      temporaryFixtureRemoved: previous.temporaryFixtureRemoved }] : [])]
  report.priorFailedRuns = [...(previous?.priorFailedRuns || []), ...(previous?.ok === false ?
    [{ elapsedMs: previous.elapsedMs, checks: previous.checks, error: previous.error,
      unexpectedRequests: previous.unexpectedRequests, temporaryFixtureRemoved: previous.temporaryFixtureRemoved }] : [])]
  await writeFile(join(work, 'fixture-owner'), token)
  try {
    const project = join(work, 'project'), profile = join(work, 'profile'), childResult = join(work, 'result.json')
    await mkdir(project); await mkdir(profile); await mkdir(dirname(screenshot), { recursive: true })
    await writeFile(join(project, 'main.tex'), 'Local paper before UI acceptance.\n')
    await writeFile(join(project, 'other.tex'), 'Unchanged second file.\n')
    try { await launch({ ...process.env, SMOKE_WORK: work, SMOKE_TOKEN: token, SMOKE_PROJECT: project, SMOKE_PROFILE: profile, SMOKE_RESULT: childResult, SMOKE_SCREENSHOT: screenshot }) }
    catch (error) {
      const partial = await readFile(childResult, 'utf8').catch(() => null)
      if (partial) report = { ...report, ...JSON.parse(partial) }
      report.launchError = error.message; throw error
    }
    report = { ...report, ...JSON.parse(await readFile(childResult, 'utf8')), ok: true }
  } catch (error) { report.error = report.error || error.stack || error.message; throw error }
  finally {
    try { await removeFixture(work, token); report.temporaryFixtureRemoved = true }
    catch (error) { report.ok = false; report.temporaryFixtureRemoved = false; report.cleanupError = error.message; process.exitCode = 1 }
    report.elapsedMs = Date.now() - started
    await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
    console.log('PAPERSTUDIO_CLOUD_UI=' + JSON.stringify({ ok: report.ok, checks: report.checks, elapsedMs: report.elapsedMs, temporaryFixtureRemoved: report.temporaryFixtureRemoved }))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
