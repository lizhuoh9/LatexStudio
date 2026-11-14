// Electron entry is UNCONDITIONAL. Only native folder selection is replaced; project APIs/IPC/CM stay real.
const assert = require('node:assert/strict'), fs = require('node:fs')
const { join, resolve, dirname, basename, isAbsolute } = require('node:path'), { createHash } = require('node:crypto')
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const work = process.env.SMOKE_WORK, phase = Number(process.env.SMOKE_PHASE), started = Date.now()
assert(work && isAbsolute(work) && [1, 2].includes(phase))
const f = JSON.parse(fs.readFileSync(join(work, 'fixture.json'), 'utf8')), root = resolve(__dirname, '..')
assert.equal(f.work, work); assert.equal(f.owner, process.env.SMOKE_TOKEN)
assert.equal(fs.readFileSync(join(work, 'fixture-owner'), 'utf8'), f.owner)
assert.equal(f.profile, join(dirname(work), 'profile')); assert.equal(dirname(f.projects.a.dir), work); assert.equal(dirname(f.projects.b.dir), work)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(hash(fs.readFileSync(join(dirname(work), 'fixture-owner'))), f.warmOwnerHash)
const report = { phase, pid: process.pid, startedAt: new Date().toISOString(), passed: false, safeCloseConfirmed: false,
  builtMain: true, build: f.build, checkpoints: [], checks: {}, networkAttempts: 0, forbiddenCalls: 0, allowedDriveQueries: 0, closeAcks: 0, directories: [], nativeDialogs: [], pendingChannels: [], pendingTrackedChannels: [] }
function persist() { fs.writeFileSync(join(work, `phase-${phase}.json`), JSON.stringify(report, null, 2)) }
function mark(stage) { report.checkpoints.push({ stage, ms: Date.now() - started }); persist() }
let stopping = false, selection = 0
mark('child-entry')
for (const [name, value] of Object.entries(f.build)) assert.equal(hash(fs.readFileSync(join(root, 'out', name))), value, 'Build changed between phases')
globalThis.fetch = async () => { report.networkAttempts++; persist(); throw new Error('Projects smoke forbids all Main network') }
const cp = require('node:child_process'), actualExecFile = cp.execFile
const localNet = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe')
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[key] = (...args) => {
  const [file, argv, options, callback] = args
  if (key === 'execFile' && args.length === 4 && file === localNet && Array.isArray(argv) && argv.length === 1 && argv[0] === 'use'
    && options && Object.keys(options).sort().join(',') === 'maxBuffer,timeout,windowsHide'
    && options.timeout === 3000 && options.maxBuffer === 65536 && options.windowsHide === true && typeof callback === 'function') {
    report.allowedDriveQueries++; mark('readonly-local-mapped-drive-query'); return actualExecFile.apply(cp, args)
  }
  report.forbiddenCalls++; mark('forbidden-child-process'); throw new Error('No native/helper processes allowed in project GUI acceptance')
}
app.setPath('userData', f.profile)
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { report.networkAttempts++; persist(); callback({ cancel: true }) })
})
dialog.showOpenDialog = async (_window, options) => {
  assert.equal(phase, 1); assert.match(options.title, /打开本地论文项目/); assert(selection < 2)
  const path = f.projects[selection++ === 0 ? 'a' : 'b'].dir
  report.directories.push(path); mark('native-owned-directory-selected'); return { canceled: false, filePaths: [path] }
}
const actualMessageBox = dialog.showMessageBox.bind(dialog)
dialog.showMessageBox = (...args) => {
  const options = args.find(arg => arg && typeof arg === 'object' && 'message' in arg) ?? {}
  const entry = { message: options.message, detail: options.detail, type: options.type, buttons: options.buttons, ms: Date.now() - started, closed: false }
  report.nativeDialogs.push(entry); mark('native-message-box-open')
  return actualMessageBox(...args).then(result => { entry.closed = true; entry.response = result.response; mark('native-message-box-closed'); return result })
}
const handle = ipcMain.handle.bind(ipcMain), pendingIpc = new Map(); let nextIpc = 0
// Match Main's non-activeRequests background operations; still observe their begin/finally transparently.
const untracked = new Set(['workspace:environment', 'workspace:repository-transfer', 'workspace:cancel-repository-transfer'])
const trackedChannels = () => [...pendingIpc.values()].filter(channel => !untracked.has(channel))
const ipcState = () => { report.pendingChannels = [...pendingIpc.values()]; report.pendingTrackedChannels = trackedChannels() }
ipcMain.handle = (channel, action) => handle(channel, async (...args) => {
  const id = ++nextIpc; let completed = false
  pendingIpc.set(id, channel); ipcState(); mark(channel + ':begin')
  try {
    if (['workspace:compile', 'tex-setup:prepare'].includes(channel)) { report.forbiddenCalls++; persist(); throw new Error('Compile/preparation forbidden in projects smoke') }
    const result = await action(...args); completed = true; return result
  } finally {
    pendingIpc.delete(id); ipcState(); mark(channel + (completed ? ':complete' : ':failed'))
  }
})
ipcMain.on('workspace:close-ack', () => { report.closeAcks++; persist() })
const win = () => BrowserWindow.getAllWindows()[0], js = code => win().webContents.executeJavaScript(code)
const quote = JSON.stringify, pause = () => new Promise(done => setTimeout(done, 80))
async function diagnose(label, error) {
  report.failedStage = label; report.failure = String(error)
  try { report.rendererStatus = await js(`({status:document.getElementById('status')?.textContent, rootTitle:document.getElementById('project-root')?.title, name:document.getElementById('project-name')?.textContent, activeFile:document.getElementById('active-file')?.textContent, files:[...document.querySelectorAll('#file-tree .file-entry')].map(n=>n.title), cloud:document.getElementById('cp-status')?.textContent, body:document.querySelector('#source-editor .cm-content')?.textContent?.slice(0,1500)})`) }
  catch (failure) { report.rendererStatus = { unavailable: String(failure) } }
  persist()
}
async function until(predicate, label) {
  const end = Math.min(started + 85000, Date.now() + 15000)
  try {
    while (!stopping && Date.now() < end) {
      if (report.forbiddenCalls || report.networkAttempts) throw new Error('Forbidden process/network attempt; inspect counters')
      if (await predicate()) return
      if (win() && !win().webContents.isLoading()) {
        const status = await js('document.getElementById("status")?.textContent ?? ""')
        if (/失败|无法读取|无法安全|操作未完成|保存未完成|目录.*不可用/.test(status)) throw new Error('Renderer error: ' + status)
      }
      await pause()
    }
    throw new Error('Timed out/canceled after at most 15s: ' + label)
  } catch (error) { await diagnose(label, error); throw error }
}
async function click(selector) {
  await js(`(() => { const n=document.querySelector(${quote(selector)}); if(!n || n.disabled || n.closest('[inert]')) throw new Error('Unavailable UI control'); n.click() })(); undefined`)
}
const idle = () => until(() => js('!document.getElementById("project-open").disabled'), 'workspace idle')
const row = key => `.pl-open[title=${quote(f.projects[key].dir)}]`
async function state() { return js('window.paperstudioProjects.list()') }
async function rootMatches(key) {
  const p = f.projects[key], expected = key.toUpperCase(), forbidden = key === 'a' ? 'B' : 'A'
  await until(async () => {
    const info = await js('window.paperstudio.project()')
    report.observedMainRoot = info?.root ?? null
    return info?.root === p.dir && await js(`document.getElementById('project-root').title===${quote(p.dir)} && document.getElementById('project-name').textContent===${quote(basename(p.dir))} && document.getElementById('active-file').textContent==='main.tex' && document.querySelector('#source-editor .cm-content').textContent.includes(${quote('PROJECT_' + expected)})`)
  }, 'Main/renderer/current file converge: ' + key)
  await idle()
  const view = await js(`({ files:[...document.querySelectorAll('#file-tree .file-entry')].map(n=>n.title), body:document.querySelector('#source-editor .cm-content').textContent, active:document.querySelector(${quote(row(key))})?.getAttribute('aria-current') })`)
  assert.deepEqual(view.files.sort(), [`${key}-only.tex`, 'main.tex'].sort()); assert(!view.body.includes('PROJECT_' + forbidden)); assert.equal(view.active, 'true')
  const publicState = await js('window.paperstudioCloud.status()')
  assert.equal(publicState.signedIn, false); assert.equal(publicState.connection.owner, p.binding.owner); assert.equal(publicState.connection.name, p.binding.name)
  await until(() => js(`document.getElementById('cp-status').textContent.includes(${quote(p.binding.owner + '/' + p.binding.name)})`), 'cloud public status follows root')
  const badge = await js(`({ text:document.querySelector(${quote(row(key) + ' .pl-badge')})?.textContent, title:document.querySelector(${quote(row(key) + ' .pl-badge')})?.title })`)
  assert.equal(badge.text, 'GitHub'); assert.equal(badge.title, `${p.binding.owner}/${p.binding.name}`)
  report.checks['root-' + key] = true; mark('root-verified-' + key)
}
async function choose(key) { await idle(); await until(() => js(`!!document.querySelector(${quote(row(key))}) && !document.querySelector(${quote(row(key))}).disabled`), 'project entrance ready'); await click(row(key)); await rootMatches(key) }
function protectedA() {
  const hashes = {}, dir = f.projects.a.dir
  const walk = relative => {
    const path = join(dir, relative), stat = fs.lstatSync(path); assert(!stat.isSymbolicLink())
    if (stat.isDirectory()) for (const name of fs.readdirSync(path).sort()) walk(join(relative, name))
    else { assert(stat.isFile() && stat.nlink === 1); hashes[relative] = hash(fs.readFileSync(path)) }
  }
  for (const path of ['main.tex', 'a-only.tex', '.git']) walk(path)
  return hashes
}
async function first() {
  await click('#project-open'); await rootMatches('a'); await click('#project-open'); await rootMatches('b'); await choose('a')
  win().show(); win().focus(); await js('document.querySelector("#source-editor .cm-content").focus(); undefined')
  assert(await js('document.activeElement===document.querySelector("#source-editor .cm-content")'))
  win().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home', modifiers: ['control'] })
  win().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home', modifiers: ['control'] })
  await win().webContents.insertText('% PROJECT_A_DIRTY_SAVED\n')
  await until(() => js('document.getElementById("save-state").classList.contains("dirty")'), 'real CodeMirror dirty input')
  const eventStart = report.checkpoints.length
  await choose('b') // No save click: ProjectLibraryPanel must save A before activating B.
  const stages = report.checkpoints.slice(eventStart).map(event => event.stage)
  assert(stages.indexOf('workspace:save:complete') >= 0 && stages.indexOf('workspace:save:complete') < stages.indexOf('projects:activate:begin'))
  assert(fs.readFileSync(join(f.projects.a.dir, 'main.tex'), 'utf8').includes('PROJECT_A_DIRTY_SAVED')); report.checks.dirtySavedBeforeSwitch = true
  await choose('a'); assert(await js('document.querySelector("#source-editor .cm-content").textContent.includes("PROJECT_A_DIRTY_SAVED")'))
  await choose('b'); const before = protectedA()
  const selector = row('a') + ' + .pl-forget'; await click(selector)
  await until(() => js('document.getElementById("confirm-dialog").open'), 'real HTML forget confirmation')
  assert.match(await js('document.getElementById("confirm-detail").textContent'), /不会删除/)
  await click('#confirm-dialog button[value="accept"]'); await idle()
  await until(async () => !(await state()).projects.some(p => p.root === f.projects.a.dir), 'A entry removed')
  assert.deepEqual(protectedA(), before); assert.equal((await js('window.paperstudio.project()')).root, f.projects.b.dir)
  report.checks.forgetDoesNotChangePapersGitOrBinding = true; assert.equal(selection, 2)
}
async function second() {
  const list = await state(); assert(list.projects.some(p => p.root === f.projects.b.dir)); assert(!list.projects.some(p => p.root === f.projects.a.dir))
  assert.equal(list.activeId, null); assert.equal(await js('window.paperstudio.project()'), null)
  assert.equal(await js('document.getElementById("project-root").title'), '')
  assert.notEqual(await js('document.getElementById("project-name").textContent'), basename(f.projects.b.dir))
  report.checks.restartPersistentEntrancesWithoutAutoOpen = true
  await choose('b'); assert.equal(selection, 0)
}
async function drainForClose() {
  const end = Date.now() + 30000; let quietSince = 0
  mark('waiting-for-ipc-ui-clean-drain')
  while (Date.now() < end) {
    const ui = await js('({idle:!document.getElementById("project-open").disabled,dirty:document.getElementById("save-state").classList.contains("dirty")})')
    const tracked = trackedChannels()
    report.closeReadiness = { ...ui, pendingChannels: [...pendingIpc.values()], pendingTrackedChannels: tracked, ms: Date.now() - started }
    if (ui.idle && !ui.dirty && tracked.length === 0) {
      quietSince ||= Date.now()
      if (Date.now() - quietSince >= 250) { mark('ipc-ui-clean-drained'); return true }
    } else quietSince = 0
    persist(); await pause()
  }
  report.passed = false; report.cleanupUnknown = true
  await diagnose('close-drain', new Error('Tracked IPC/UI/dirty state did not drain within 30s; no quit forced')); return false
}
async function stop(error) {
  if (stopping) return
  stopping = true
  if (error) { report.passed = false; report.failure = String(error); if (!report.failedStage) await diagnose('assertion-or-stop', error) }
  mark('cooperative-close-requested')
  try {
    if (win() && !win().isDestroyed()) {
      await js('window.paperstudioSetup.cancel()') // Normal public cancellation; no trust/preparation wait is required here.
      if (await js('document.getElementById("save-state").classList.contains("dirty") && !document.getElementById("file-save").disabled')) await click('#file-save')
      if (!await drainForClose()) return
    }
    mark('app-quit-after-drain'); app.quit() // Actual production close acknowledgement/dirty/cleanup handshake. Never app.exit or helper kill.
  } catch (failure) { report.cleanupUnknown = true; report.shutdownError = String(failure); persist() }
}
process.once('uncaughtException', error => { console.error(error); void stop(error) })
process.once('unhandledRejection', error => { console.error(error); void stop(error) })
process.on('message', message => { if (message?.kind === 'projects-stop') void stop(new Error('90-second cooperative budget reached')) })
app.once('will-quit', () => { report.safeCloseConfirmed = report.closeAcks > 0; report.finishedAt = new Date().toISOString(); persist() })
process.once('exit', code => { report.exitCode = code; persist() })
mark('before-built-main'); require('../out/main/index.js'); mark('after-built-main')
app.whenReady().then(async () => {
  try {
    await until(() => win() && !win().webContents.isLoading(), 'built window')
    await until(() => js('Boolean(window.paperstudioProjects?.activate && window.paperstudioCloud?.status && window.paperstudioSetup?.cancel)'), 'real built preload bridges')
    win().setTitle('PaperStudio · 自动验收临时项目（请勿操作）'); win().show(); win().focus()
    await js(`(() => { const n=document.createElement('div'); n.textContent='自动验收临时项目 · 非用户论文 · 请勿操作'; n.style.cssText='position:fixed;right:8px;bottom:4px;z-index:9999;background:white;color:#555;border:1px solid #ccc;padding:4px;font:11px sans-serif;pointer-events:none'; document.body.append(n) })(); undefined`)
    await js('window.paperstudioSetup.cancel()'); await idle(); mark('built-workspace-ready')
    assert.equal(await js('window.paperstudio.project()'), null)
    await until(() => js('document.getElementById("project-library-refresh").disabled===false'), 'library initialized')
    if (phase === 1) await first(); else await second()
    await idle(); assert.equal(report.networkAttempts, 0); assert.equal(report.forbiddenCalls, 0)
    await click('#cloud-open'); await until(() => js('document.getElementById("cloud-dialog").open'), 'right-side sync opens current project')
    assert.equal((await js('window.paperstudioCloud.status()')).connection.name, 'paper-b'); await click('#cloud-close')
    await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    fs.writeFileSync(join(work, 'current.png'), (await win().webContents.capturePage()).toPNG()) // One current preview, overwritten on phase 2.
    report.passed = true; mark('phase-passed'); await stop()
  } catch (error) { console.error(error); await stop(error) }
})
