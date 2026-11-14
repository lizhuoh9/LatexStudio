// Driven only by smoke-versions.cjs: real built main, sandboxed preload/IPC, renderer, CodeMirror and VersionPanel.
// Native directory selection/restore confirmation are stubbed; no production service or IPC handler is mocked.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { readFile, writeFile } = require('node:fs/promises')
const { isAbsolute, join, resolve } = require('node:path')
const { app, BrowserWindow, dialog } = require('electron')
const work = process.env.SMOKE_WORK, project = process.env.SMOKE_PROJECT, profile = process.env.SMOKE_PROFILE
assert(work && isAbsolute(work) && project === join(work, 'project') && profile === join(work, 'profile'), 'Isolated fixture paths required')
assert.equal(readFileSync(join(work, 'fixture-owner'), 'utf8'), process.env.SMOKE_TOKEN)
assert.equal(process.env.SMOKE_RESULT, join(work, 'result.json'))
assert.equal(process.env.SMOKE_SCREENSHOT, resolve(__dirname, '../release/versions-ui-smoke.png'))
const fixture = JSON.parse(readFileSync(join(work, 'fixture.json'), 'utf8'))
const report = { nativeDirectorySelections: 0, nativeRestoreConfirmations: 0, checks: {}, electron: process.versions.electron, chromium: process.versions.chrome }
dialog.showOpenDialog = async (_window, options) => {
  assert.match(options.title, /打开本地论文项目/)
  report.nativeDirectorySelections++
  return { canceled: false, filePaths: [project] }
}
dialog.showMessageBox = async (_window, options) => {
  assert.match(options.message, /回退文件 main\.tex 到所选版本/)
  assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
  report.nativeRestoreConfirmations++
  return { response: 1, checkboxChecked: false }
}
app.setPath('userData', profile)
require('../out/main/index.js')

const win = () => BrowserWindow.getAllWindows()[0]
const js = expression => win().webContents.executeJavaScript(expression)
const click = id => js(`document.getElementById(${JSON.stringify(id)}).click(); undefined`)
const text = id => js(`document.getElementById(${JSON.stringify(id)}).textContent`)
async function until(predicate, label, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise(done => setTimeout(done, 80))
  }
  throw new Error('Timed out: ' + label)
}
async function idle() { await until(() => js('!document.getElementById("project-open").disabled'), 'UI operation settled') }
async function selectVersion(id, expectedAfter) {
  await idle()
  await js(`(() => { const row = [...document.querySelectorAll('#revision-list [data-revision-id]')].find(n => n.dataset.revisionId === ${JSON.stringify(id)}); if (!row) throw new Error('Missing timeline revision'); row.click() })(); undefined`)
  await until(async () => (await text('revision-after')).includes(expectedAfter), 'VersionPanel target content')
  await idle()
  assert.equal(await js('document.getElementById("revision-restore").disabled'), false)
}
async function openAndSave() {
  await idle(); await click('project-open')
  await until(() => js('document.getElementById("active-file").textContent === "main.tex"'), 'real project adopted')
  await idle()
  assert.equal(await readFile(join(project, 'main.tex'), 'utf8'), fixture.contents.second)
  win().show(); win().focus()
  await js('document.querySelector("#source-editor .cm-content").focus(); undefined')
  const modifier = process.platform === 'darwin' ? 'meta' : 'control'
  win().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: [modifier] })
  win().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: [modifier] })
  await win().webContents.insertText(fixture.contents.edited)
  await until(() => js('document.getElementById("save-state").classList.contains("dirty")'), 'CodeMirror input becomes dirty')
  report.checks.realCodeMirrorInput = true
  await click('file-save')
  await until(async () => (await readFile(join(project, 'main.tex'), 'utf8')) === fixture.contents.edited, 'real file-save persisted editor content')
  await until(() => js('!document.getElementById("save-state").classList.contains("dirty")'), 'save acknowledgement clears dirty')
  await idle(); report.checks.realSaveButton = true
}
async function viewAndRestore() {
  await click('cloud-open')
  await until(() => js('!document.getElementById("revision-panel").hidden && !document.getElementById("cloud-dialog").open && document.querySelectorAll("#revision-list [data-revision-id]").length >= 4'), 'combined journal and Git version list')
  await idle()
  const entries = await js('window.paperstudio.revisions()')
  report.initialVersionCount = entries.length
  report.gitAuthors = [...new Set(entries.filter(entry => entry.id.startsWith('git:')).map(entry => entry.author))].sort()
  assert.deepEqual(report.gitAuthors, ['Smoke Alice', 'Smoke Bob'])
  report.checks.twoRealGitAuthorsListed = true
  const saved = entries.find(entry => entry.kind === 'save' && !entry.id.startsWith('git:'))
  assert(saved, 'UI save must produce a shared-journal entry')
  await selectVersion(saved.id, 'Version three:')
  assert.match(await text('revision-before'), /Version two:/)
  assert.match(await text('revision-diff'), /Version two:[\s\S]*Version three:/)
  report.checks.sharedJournalBeforeAfterAndDiff = true
  const target = entries.find(entry => entry.id.startsWith('git:' + fixture.commits.first + ':') && entry.path === 'main.tex')
  assert(target, 'Alice main.tex Git target must be shown')
  await selectVersion(target.id, 'Version one:')
  assert.match(await text('revision-description'), /提交作者：Smoke Alice/)
  await click('revision-restore')
  await until(() => js('document.getElementById("confirm-dialog").open'), 'real HTML restore confirmation')
  assert.match(await text('confirm-title'), /仅回退此文件/)
  await js('document.querySelector("#confirm-dialog button[value=accept]").click(); undefined')
  await until(async () => (await readFile(join(project, 'main.tex'), 'utf8')) === fixture.contents.first, 'restore changed only selected file')
  await until(() => js(`!document.getElementById('confirm-dialog').open && !document.getElementById('project-open').disabled && document.querySelectorAll('#revision-list [data-revision-id]').length === ${entries.length + 1}`), 'renderer idle and refreshed list includes restored version')
  report.restoreCompletionStatus = await text('status')
  await idle()
  assert.equal(await readFile(join(project, 'other.tex'), 'utf8'), fixture.contents.other)
  assert.equal(report.nativeRestoreConfirmations, 1)
  const after = await js('window.paperstudio.revisions()'), restore = after.find(entry => entry.kind === 'restore')
  assert(restore, 'restore must append a new shared history entry')
  assert.equal(after.length, entries.length + 1)
  const detail = await js(`window.paperstudio.revisionDetail(${JSON.stringify(restore.id)})`)
  assert.equal(detail.before, fixture.contents.edited); assert.equal(detail.after, fixture.contents.first)
  await selectVersion(restore.id, 'Version one:')
  report.checks.htmlAndNativeRestoreConfirmation = true
  report.checks.mainRestoredToOldContent = true
  report.checks.otherFileUnchanged = true
  report.checks.restoreAppendedHistoryWithBeforePreserved = true
  report.finalVersionCount = after.length
  report.restore = { path: restore.path, kind: restore.kind, beforeRevision: restore.beforeRevision, afterRevision: restore.afterRevision }
}
async function evidence() {
  report.profileIsTemporary = app.getPath('userData') === profile
  report.rendererUrl = win().webContents.getURL().replaceAll('\\', '/')
  report.buildSha256 = {}
  for (const name of ['main/index.js', 'preload/index.js', 'renderer/index.html'])
    report.buildSha256[name] = createHash('sha256').update(await readFile(join(__dirname, '../out', name))).digest('hex')
  await js('(() => { document.querySelector(".revision-panel").scrollIntoView({ block: "start" }); document.querySelector(".revision-panel details").open = true })(); undefined')
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  await writeFile(process.env.SMOKE_SCREENSHOT, (await win().webContents.capturePage()).toPNG())
  report.screenshot = 'release/versions-ui-smoke.png'
  await writeFile(process.env.SMOKE_RESULT, JSON.stringify(report, null, 2))
}
app.whenReady().then(async () => {
  await until(() => win() && !win().webContents.isLoading(), 'built application window')
  win().webContents.setBackgroundThrottling(false)
  await until(() => js('Boolean(window.paperstudio?.restoreRevision)'), 'real preload version API')
  assert.equal(app.isPackaged, false)
  await until(() => js('document.getElementById("startup-dialog").open'), 'startup choice')
  await click('startup-offline')
  await openAndSave(); await viewAndRestore(); await evidence()
  app.quit()
}).catch(async error => {
  console.error(error)
  try { report.error = error.stack; report.uiStatus = await text('status'); report.log = (await text('log')).slice(-2500); await writeFile(process.env.SMOKE_RESULT, JSON.stringify(report, null, 2)) } catch {}
  app.exit(1)
})
