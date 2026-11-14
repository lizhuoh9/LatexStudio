const assert = require('node:assert/strict')
const { readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { app, BrowserWindow, dialog } = require('electron')
const project = process.env.SMOKE_PROJECT
const prompts = []
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] })
dialog.showMessageBox = async (_window, options) => { prompts.push(options); return { response: 0 } }
app.setPath('userData', process.env.SMOKE_PROFILE)
require('../out/main/index.js')

async function until(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out: ${label}`)
}
function window() { return BrowserWindow.getAllWindows()[0] }
function js(expression) { return window().webContents.executeJavaScript(expression) }
function api(expression) { return js(`window.paperstudio.${expression}`) }
function click(id) { return js(`document.getElementById(${JSON.stringify(id)}).click(); undefined`) }
function content() { return js('document.querySelector(".cm-content")?.textContent ?? ""') }
async function insert(value) {
  await js('document.querySelector(".cm-content").focus(); undefined')
  window().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End', modifiers: ['control'] })
  window().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End', modifiers: ['control'] })
  await window().webContents.insertText(value)
}

async function openProject() {
  await until(() => js('!document.getElementById("project-open").disabled'), 'workspace interactive')
  await click('project-open')
  await until(async () => (await api('project()'))?.root === project, 'selected project attached')
  await until(() => js('document.getElementById("active-file").textContent === "main.tex"'), 'real file editor')
  assert((await content()).includes('PaperStudio'))
}

async function isolation() {
  const preferences = window().webContents.getLastWebPreferences()
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.deepEqual(await js('[typeof require, typeof process, typeof paperstudio.openProject, typeof paperstudio.compile]'),
    ['undefined', 'undefined', 'function', 'function'])
  assert.equal(await js('Notification.permission'), 'denied')
  let blocked = false
  window().webContents.emit('will-navigate', { preventDefault() { blocked = true } }, 'https://example.invalid/')
  assert(blocked)
  await js('void window.open("https://example.invalid/")')
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await assert.rejects(api('readFile("../outside.txt")'))
  console.log('PASS sandboxed local renderer, minimal IPC, traversal and navigation denial')
}

async function filesAndExternalEdits() {
  await insert('\n% saved through real CodeMirror UI\n')
  await until(() => js('document.getElementById("save-state").textContent.includes("未保存")'), 'editor dirty')
  await click('file-save')
  await until(() => js('document.getElementById("save-state").textContent.includes("已保存")'), 'save UI acknowledgement')
  const file = join(project, 'main.tex')
  assert((await readFile(file, 'utf8')).includes('saved through real CodeMirror UI'))
  const old = await api('readFile("main.tex")')
  const external = old.content + '\n% external AI update\n'
  await writeFile(file, external)
  await until(async () => (await content()).includes('external AI update'), 'clean external edit reloaded')
  await assert.rejects(api(`saveFile("main.tex", "obsolete", ${JSON.stringify(old.revision)})`))
  assert.equal(await readFile(file, 'utf8'), external)
  await insert('\n% preserved unsaved draft\n')
  await writeFile(file, external + '\n% another external update\n')
  await until(() => js('!document.getElementById("external-warning").hidden'), 'dirty external warning')
  assert((await content()).includes('preserved unsaved draft'))
  await click('file-copy')
  await until(() => js('document.getElementById("input-dialog").open'), 'copy path dialog')
  await js('document.getElementById("input-value").value="main.local-copy.tex"; document.querySelector("#input-dialog button[value=accept]").click(); undefined')
  await until(() => js('document.getElementById("active-file").textContent === "main.local-copy.tex"'), 'saved safe copy')
  assert((await readFile(join(project, 'main.local-copy.tex'), 'utf8')).includes('preserved unsaved draft'))
  assert(!(await readFile(file, 'utf8')).includes('preserved unsaved draft'))
  console.log('PASS real editor save/CAS, external AI edits and safe draft copy without overwriting originals')
}

async function localHistory() {
  const snapshot = await api('snapshot("Workspace runtime snapshot")')
  assert(snapshot && snapshot.id)
  const history = await api('history()')
  assert(history.some(item => item.summary === 'Workspace runtime snapshot'))
  const status = await api('repository()')
  assert.equal(status.connection, null)
  assert.equal(status.changes.length, 0)
  console.log('PASS actual offline local snapshot and history without any GitHub account/network')
}

async function compiler() {
  const environment = await api('environment()')
  await until(() => js('!document.getElementById("environment").textContent.includes("正在检查")'), 'engine status', 180000)
  if (!environment.available) {
    assert.equal(await js('document.getElementById("compile").disabled'), true)
    console.log('NOT VERIFIED actual TeX/PDF: engine refused because isolation self-test did not pass')
    assert.notEqual(process.env.PAPERSTUDIO_REQUIRE_COMPILE, '1', environment.description)
    return
  }
  await js(`document.getElementById("engine").value=${JSON.stringify(environment.engines[0])}; document.getElementById("main-file").value="main.tex"; undefined`)
  await click('compile')
  await until(() => js('/本机编译完成|本次编译未成功|本机编译失败/.test(document.getElementById("status").textContent)'), 'real TeX compilation', 150000)
  assert.match(await js('document.getElementById("status").textContent'), /本机编译完成/)
  await until(() => js('Boolean(document.querySelector("#pdf-pages canvas")?.width)'), 'real compiled PDF canvas')
  console.log('PASS actual local TeX compile -> typed IPC -> local PDF.js worker -> rendered PDF canvas')
}

async function closeCancellation() {
  await api('setDirty(true)')
  const count = prompts.length
  window().close()
  await until(() => prompts.length > count, 'native unsaved close confirmation')
  assert(!window().isDestroyed())
  await api('setDirty(false)')
  console.log('PASS native unsaved-close cancellation preserves working window')
}

async function screenshot() {
  window().show(); window().focus()
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window().webContents.capturePage()
  await writeFile(join(__dirname, '../release/workspace-smoke.png'), image.toPNG())
}

async function restart() {
  assert((await readFile(join(project, 'main.tex'), 'utf8')).includes('external AI update'))
  assert((await readFile(join(project, 'main.local-copy.tex'), 'utf8')).includes('preserved unsaved draft'))
  const history = await api('history()')
  assert(history.some(item => item.summary === 'Workspace runtime snapshot'))
  console.log('PASS process restart reopens real files and persistent local history')
}

app.whenReady().then(async () => {
  await until(() => window() && !window().webContents.isLoading(), 'application window')
  await until(() => js('Boolean(window.paperstudio?.openProject)'), 'trusted workspace preload')
  await openProject()
  if (process.env.SMOKE_PHASE === 'first') {
    await isolation(); await filesAndExternalEdits(); await localHistory()
    await compiler(); await closeCancellation(); await screenshot()
  } else await restart()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
