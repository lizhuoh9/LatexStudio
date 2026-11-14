// Isolated development-Electron acceptance. No TeX, network, install, NAS or user project.
// Requires a current `npm run build`; do not infer installed-app or signed-release acceptance.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, isAbsolute, join, resolve } = require('node:path')
const { randomUUID } = require('node:crypto')
const { execFile, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const git = require('isomorphic-git')
const execute = promisify(execFile)
const resultPath = resolve(__dirname, '../tests/versions-ui-smoke-result.json')
const screenshot = resolve(__dirname, '../release/versions-ui-smoke.png')
const PREFIX = 'paperstudio-versions-ui-'
const contents = {
  first: '\\documentclass{article}\n\\begin{document}\nVersion one: Alice original paragraph.\n\\end{document}\n',
  second: '\\documentclass{article}\n\\begin{document}\nVersion two: Bob revised paragraph.\n\\end{document}\n',
  edited: '\\documentclass{article}\n\\begin{document}\nVersion three: edited through the real CodeMirror UI.\n\\end{document}\n',
  other: 'This second file must remain unchanged throughout the single-file restore.\n'
}
async function seed(project) {
  await mkdir(project)
  await git.init({ fs, dir: project, defaultBranch: 'main' })
  await writeFile(join(project, 'main.tex'), contents.first)
  await writeFile(join(project, 'other.tex'), contents.other)
  for (const filepath of ['main.tex', 'other.tex']) await git.add({ fs, dir: project, filepath })
  const first = await git.commit({ fs, dir: project, author: { name: 'Smoke Alice', email: 'alice@example.invalid', timestamp: 1700000000, timezoneOffset: 0 }, message: 'Smoke initial file version' })
  await writeFile(join(project, 'main.tex'), contents.second)
  await git.add({ fs, dir: project, filepath: 'main.tex' })
  const second = await git.commit({ fs, dir: project, author: { name: 'Smoke Bob', email: 'bob@example.invalid', timestamp: 1700000060, timezoneOffset: 0 }, message: 'Smoke second file version' })
  return { first, second }
}
async function launch(env) {
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.NODE_OPTIONS
  const child = spawn(require('electron'), [join(__dirname, 'smoke-versions-electron.cjs')], { env, stdio: 'inherit' })
  let timedOut = false, terminating = Promise.resolve()
  const timer = setTimeout(() => {
    timedOut = true
    terminating = process.platform === 'win32'
      ? execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined)
      : Promise.resolve(child.kill('SIGKILL'))
  }, 110000)
  try {
    const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
    await terminating
    if (timedOut) throw new Error('Development versions smoke exceeded 110-second deadline')
    assert.equal(code, 0, `Development Electron exited ${code}`)
  } finally { clearTimeout(timer) }
}
async function removeOwnFixture(work, token) {
  const absolute = await realpath(work), temp = await realpath(tmpdir())
  assert(isAbsolute(absolute) && dirname(absolute) === temp && basename(absolute).startsWith(PREFIX), 'Refuse unsafe fixture cleanup target')
  assert.equal(await readFile(join(absolute, 'fixture-owner'), 'utf8'), token)
  await rm(absolute, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 })
}
async function main() {
  const work = await mkdtemp(join(tmpdir(), PREFIX)), token = randomUUID(), started = Date.now()
  let report = { ok: false, mode: 'development Electron; built out/main + preload + renderer', nativeDialogs: 'directory selection and restore confirmation stubbed', notValidated: ['original packaged executable', 'code signing', 'two-machine collaboration', 'real NAS', 'network disconnect', 'TeX compilation'] }
  await writeFile(join(work, 'fixture-owner'), token)
  try {
    const project = join(work, 'project'), profile = join(work, 'profile'), childResult = join(work, 'result.json')
    await mkdir(profile); await mkdir(dirname(screenshot), { recursive: true })
    const commits = await seed(project)
    await writeFile(join(work, 'fixture.json'), JSON.stringify({ contents, commits }))
    try {
      await launch({ ...process.env, SMOKE_WORK: work, SMOKE_TOKEN: token, SMOKE_PROJECT: project, SMOKE_PROFILE: profile, SMOKE_RESULT: childResult, SMOKE_SCREENSHOT: screenshot })
    } catch (error) {
      const partial = await readFile(childResult, 'utf8').catch(() => null)
      if (partial) report = { ...report, ...JSON.parse(partial) }
      report.launchError = error.message
      throw error
    }
    report = { ...report, ...JSON.parse(await readFile(childResult, 'utf8')), ok: true }
  } catch (error) { report.error = report.error || error.stack || error.message; throw error }
  finally {
    try { await removeOwnFixture(work, token); report.temporaryFixtureRemoved = true }
    catch (error) { report.temporaryFixtureRemoved = false; report.cleanupError = error.message; report.ok = false; process.exitCode = 1 }
    report.elapsedMs = Date.now() - started
    await writeFile(resultPath, JSON.stringify(report, null, 2) + '\n')
    console.log(`PAPERSTUDIO_VERSIONS_UI=${JSON.stringify(report)}`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
