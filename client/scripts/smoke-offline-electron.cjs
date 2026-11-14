// Built production Main/preload/renderer. Real local preparation, real compiler, real helper; no source loader.
// ONLY native directory selection is stubbed; a test-only title/watermark identifies the temporary project.
// Other wrappers only observe production behavior or deny network.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { readdir, readFile, writeFile } = require('node:fs/promises')
const { join, resolve, isAbsolute } = require('node:path')
const { createHash } = require('node:crypto')
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const work = process.env.SMOKE_WORK, profile = process.env.SMOKE_PROFILE, project = process.env.SMOKE_PROJECT
assert(work && isAbsolute(work) && profile === join(work, 'profile') && project === join(work, 'project'))
assert.equal(fs.readFileSync(join(work, 'fixture-owner'), 'utf8'), process.env.SMOKE_TOKEN)
assert.equal(fs.readdirSync(profile).length, 0, 'UserData must start completely empty, with no TeX runtime')
const root = resolve(__dirname, '..'), started = Date.now(), deadline = started + 540000
const report = { startedAt: new Date().toISOString(), builtMain: true, freshUserData: true, passed: false,
  safeCloseConfirmed: false, cleanupUnknown: false, prepareIpcCalls: 0, fetchDenied: [], chromiumDenied: [], nativeDialogs: [],
  setupPhases: [], checkpoints: [], compileReturns: [], checks: {}, pid: process.pid,
  electron: process.versions.electron, chromium: process.versions.chrome }
const hash = value => createHash('sha256').update(value).digest('hex')
report.builtMainSha256 = hash(fs.readFileSync(join(root, 'out/main/index.js')))
report.builtPreloadSha256 = hash(fs.readFileSync(join(root, 'out/preload/index.js')))
let setupState = null, activeCompiles = 0, stopping = false, lastProgressPersist = 0
function persist() { fs.writeFileSync(join(work, 'result.json'), JSON.stringify(report, null, 2)) }
function checkpoint(stage, extra = {}) {
  report.checkpoints.push({ stage, ms: Date.now() - started, ...extra }); persist()
}
function fatal(error, origin) {
  report.passed = false; report.failure = String(error); report.fatal = { origin, stack: error?.stack ?? String(error) }
  checkpoint('fatal'); console.error(error); void stop(error)
}
process.once('uncaughtException', error => fatal(error, 'uncaughtException'))
process.once('unhandledRejection', error => fatal(error, 'unhandledRejection'))
process.once('exit', code => { report.processExit = { code, at: new Date().toISOString() }; persist() })
checkpoint('child-entry')
globalThis.fetch = async input => {
  report.fetchDenied.push(String(input)); persist()
  throw new Error('Offline smoke: all Main fetch requests are forbidden')
}
app.setPath('userData', profile)
app.on('web-contents-created', (_event, contents) => {
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    report.chromiumDenied.push(details.url); persist(); callback({ cancel: true })
  })
  contents.setBackgroundThrottling(false)
  const send = contents.send.bind(contents)
  contents.send = (channel, ...args) => {
    if (channel === 'tex-setup:state') {
      setupState = args[0]
      const changed = report.setupPhases.at(-1)?.phase !== setupState.phase
      report.setupCurrent = { ...setupState, ms: Date.now() - started }
      if (changed) report.setupPhases.push({ phase: setupState.phase, ms: Date.now() - started })
      if (changed || Date.now() - lastProgressPersist > 2000) { lastProgressPersist = Date.now(); persist() }
    }
    return send(channel, ...args)
  }
})
dialog.showOpenDialog = async (_window, options) => {
  assert.match(options.title, /打开本地论文项目/)
  report.nativeDialogs.push({ kind: 'directory', title: options.title }); checkpoint('native-directory-selected')
  return { canceled: false, filePaths: [project] }
}
for (const name of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox']) {
  const actual = dialog[name].bind(dialog)
  dialog[name] = (...args) => {
    const options = args.find(value => value && typeof value === 'object' && 'message' in value)
    report.nativeDialogs.push({ kind: name, message: options?.message ?? String(args[0]) }); persist()
    return actual(...args)
  }
}
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, action) => handle(channel, async (...args) => {
  if (channel === 'tex-setup:prepare') report.prepareIpcCalls++
  if (channel !== 'workspace:compile') return action(...args)
  const begin = Date.now(); activeCompiles++
  checkpoint('compile-start', { main: args[1]?.mainFile, engine: args[1]?.engine })
  try {
    const result = await action(...args), request = args[1]
    const entry = { main: request.mainFile, engine: request.engine, ok: result.ok, canceled: result.canceled,
      ms: Date.now() - begin, pdfBytes: result.pdf?.length ?? 0, pdfSha256: result.pdf ? hash(result.pdf) : null,
      cleanupLatched: /未确认完整清理|隔离会话清理未确认|无法清理编译缓存/.test(result.log) }
    report.compileReturns.push(entry)
    if (entry.cleanupLatched) report.cleanupUnknown = true
    await writeFile(join(work, request.mainFile + '.log'), result.log)
    if (result.pdf) await writeFile(join(work, request.mainFile + '.pdf'), Buffer.from(result.pdf))
    persist(); return result
  } catch (error) {
    report.cleanupUnknown = true; report.compileReturns.push({ rejected: true, message: String(error) }); persist(); throw error
  } finally { activeCompiles-- }
})
checkpoint('before-built-main-require')
require('../out/main/index.js')
checkpoint('after-built-main-require')
const window = () => BrowserWindow.getAllWindows()[0]
const js = expression => window().webContents.executeJavaScript(expression)
const text = id => js(`document.getElementById(${JSON.stringify(id)}).textContent`)
async function until(predicate, label, timeout = 30000) {
  checkpoint('waiting', { label, timeout })
  const end = Math.min(deadline, Date.now() + timeout)
  while (!stopping && Date.now() < end) {
    if (await predicate()) { checkpoint('reached', { label }); return }
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error('Timed out or canceled: ' + label)
}
async function click(id) {
  await js(`(() => { const n = document.getElementById(${JSON.stringify(id)}); if (!n || n.disabled) throw new Error('Unavailable UI control'); n.click() })(); undefined`)
}
const idle = () => until(() => js('!document.getElementById("project-open").disabled'), 'workspace idle')
async function select(id, value) {
  await js(`(() => { const n = document.getElementById(${JSON.stringify(id)}); if (![...n.options].some(o => o.value === ${JSON.stringify(value)} && !o.disabled)) throw new Error('Unavailable option'); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('change')) })(); undefined`)
}
async function initialEditing() {
  await until(() => window() && !window().webContents.isLoading(), 'built application window')
  await until(() => js('Boolean(window.paperstudio?.openProject)'), 'built trusted preload')
  assert.equal(await js('Boolean(document.querySelector(".advanced-compile .advanced-fields"))'), true, 'Real compile options targets must exist before native preparation acceptance')
  window().setTitle('PaperStudio · 自动验收临时项目（请勿操作）')
  await js(`(() => { const note=document.createElement('div'); note.textContent='自动验收临时项目 · 非用户论文 · 请勿操作'; note.style.cssText='position:fixed;right:8px;bottom:4px;z-index:1000;background:#fff;color:#555;padding:3px 8px;border:1px solid #ccc;font:11px sans-serif;pointer-events:none'; document.body.append(note) })(); undefined`)
  report.testOnlyWindowLabel = true
  window().show(); window().focus(); await idle(); await click('project-open')
  await until(() => js('document.getElementById("active-file").textContent === "main.tex"'), 'fixture main.tex open')
  await idle()
  report.phaseDuringEdit = setupState?.phase
  assert(setupState && ['checking', 'downloading', 'extracting', 'verifying'].includes(setupState.phase), 'Must witness real editing DURING automatic preparation, not only afterward')
  assert.equal(await js('document.getElementById("setup-dialog").open'), false)
  assert.equal(await js('document.getElementById("editor-panel").inert'), false)
  const witness = '% Offline preparation typing witness\n'
  await js('document.querySelector("#source-editor .cm-content").focus(); undefined')
  assert.equal(await js('document.activeElement === document.querySelector("#source-editor .cm-content")'), true)
  window().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home', modifiers: ['control'] })
  window().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home', modifiers: ['control'] })
  await js('new Promise(done => requestAnimationFrame(done))')
  await window().webContents.insertText(witness)
  await until(() => js('document.getElementById("save-state").classList.contains("dirty")'), 'real CodeMirror edits during preparation')
  await click('file-save'); await idle()
  assert((await readFile(join(project, 'main.tex'), 'utf8')).startsWith(witness))
  report.checks.editAndSaveDuringAutomaticPreparation = true
  checkpoint('real-editor-saved-during-preparation', { phase: setupState?.phase })
  await until(async () => {
    if (setupState?.phase === 'error') throw new Error('Automatic setup failed: ' + setupState.message)
    return js('!document.getElementById("compile").disabled')
  }, 'automatic offline preparation opens real compile gate', 300000)
  assert.equal(setupState?.phase, 'prepared'); assert.equal(setupState?.compileVerified, true)
  assert.equal(report.prepareIpcCalls, 0, 'No script/UI prepare IPC is allowed: startup must prepare automatically')
  assert.equal(await js('document.getElementById("setup-dialog").open'), false)
  assert.equal(report.nativeDialogs.filter(item => item.kind !== 'directory').length, 0, 'No preparation/native confirmation dialog may interrupt editing')
  report.enabledAfterMs = Date.now() - started
  report.checks.automaticOfflineReady = true
  checkpoint('automatic-offline-compile-ready')
}
async function canvasEvidence(previousPdf) {
  await until(() => js('document.querySelector("#pdf-pages canvas")?.width > 0 && document.getElementById("pdf-empty").hidden'), 'PDF.js canvas painted')
  const canvas = await js(`(() => {
    const n = document.querySelector('#pdf-pages canvas'), data = n.getContext('2d').getImageData(0, 0, n.width, n.height).data;
    let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && Math.min(data[i], data[i + 1], data[i + 2]) < 220) ink++;
    return { width: n.width, height: n.height, ink, pixels: n.toDataURL() };
  })()`)
  const evidence = { width: canvas.width, height: canvas.height, inkPixels: canvas.ink, paintedSha256: hash(canvas.pixels) }
  assert(evidence.width > 100 && evidence.height > 100); assert(evidence.inkPixels > 100, 'Real PDF canvas must contain painted text/graphics, not a blank page')
  if (previousPdf) assert.notEqual(evidence.paintedSha256, previousPdf, 'New compiled PDF must replace the previous canvas')
  return evidence
}
async function compile(file, engine, previousCanvas) {
  await idle(); await select('engine', engine); await select('main-file', file)
  assert.equal(await js('document.getElementById("compile").disabled'), false)
  const before = report.compileReturns.length
  await click('compile')
  await until(() => report.compileReturns.length > before && activeCompiles === 0, 'real compile IPC completes: ' + file, 150000)
  await until(async () => /本机编译完成|本次编译未成功|已取消本次编译/.test(await text('status')), 'compile UI result: ' + file)
  const result = report.compileReturns.at(-1), log = await readFile(join(work, file + '.log'), 'utf8')
  assert.equal(result.ok, true, file + ' failed; inspect the actual retained log, never skip missing packages')
  assert.equal(result.canceled, false); assert.equal(result.cleanupLatched, false)
  assert(result.pdfBytes > 1000); assert.equal((await readFile(join(work, file + '.pdf'))).subarray(0, 5).toString(), '%PDF-')
  assert.match(await text('status'), /本机编译完成/)
  // PDF display is intentionally asynchronous; witness its actual replacement rather than reusing an old canvas.
  await until(async () => {
    const value = await js('document.querySelector("#pdf-pages canvas")?.toDataURL() ?? ""')
    return value && (!previousCanvas || hash(value) !== previousCanvas)
  }, 'new PDF canvas replaces previous output: ' + file)
  result.canvas = await canvasEvidence(previousCanvas)
  // TeX hard-wraps file paths at max_print_line; require the actual .sty filename after joining those wraps.
  const fileEvidence = log.replace(/\r?\n/g, '').replaceAll('\\', '/')
  if (file === 'main.tex') for (const name of ['geometry', 'amsmath', 'amssymb', 'graphicx', 'booktabs', 'tikz', 'enumitem', 'hyperref']) assert(fileEvidence.includes('/' + name + '.sty'), 'Actual package evidence missing: ' + name)
  if (file === 'bib.tex') {
    assert.match(log, /BibTeX：处理参考文献/); assert.match(log, /第 3\/3 遍/)
    assert(!log.includes('BibTeX 报告错误'), 'BibTeX must actually succeed, not merely permit a PDF afterward')
    assert(!/Citation .* undefined|There were undefined references/.test(log.slice(log.lastIndexOf('第 3/3 遍'))), 'Final bibliography pass must resolve its real citation')
  }
  if (file === 'zh.tex') { assert.match(fileEvidence, /ctex-fontset-windows/); assert.match(log, /xdvipdfmx：生成 PDF/) }
  report.checks[file] = true
  return result.canvas.paintedSha256
}
async function geometry() {
  report.geometry = await js(`(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right, width: r.width } };
    const visible = n => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width && r.height && s.visibility !== 'hidden' && !n.closest('dialog:not([open])') };
    return { topbar: rect('.topbar'), toolbar: rect('.toolbar'), workspace: rect('.workspace'), editorHeading: rect('#editor-panel .panel-heading'),
      viewport:innerWidth,compile:rect('#compile'),sync:rect('#cloud-open'),sidebar:rect('.files-panel'),
      mainText: [...document.querySelectorAll('body *')].filter(n => n.children.length === 0 && visible(n)).map(n => n.textContent.trim()).filter(Boolean),
      saveInHeading: document.getElementById('file-save').parentElement.closest('#editor-panel .panel-heading') !== null };
  })()`)
  assert(report.geometry.toolbar.bottom <= 77, 'Combined header must fit the 76px target (1px tolerance)')
  assert(report.geometry.workspace.top <= 77 && report.geometry.editorHeading.bottom <= 111, 'Body/editor start must fit 76/110px targets')
  assert.equal(report.geometry.saveInHeading, true)
  const forbidden = ['外部工具直接编辑', '本机安全编译尚未核验', '不会扫描 PATH', '不会运行现有用户 TeX', 'GitHub 或 VSCode', '本地项目、编辑和历史仍可使用']
  for (const phrase of forbidden) assert(!report.geometry.mainText.some(line => line.includes(phrase)), 'Developer sentence leaked into primary UI: ' + phrase)
  assert(report.geometry.compile.left > report.geometry.viewport / 2 && report.geometry.sync.left > report.geometry.compile.left, 'Compile and sync controls must be right aligned')
  const options = await js(`(() => { const panel=document.querySelector('.advanced-compile'); panel.open=true; const popup=panel.querySelector('.advanced-fields'), r=popup.getBoundingClientRect(), fields=[...popup.querySelectorAll('select')]; const disabled=fields.map(n=>n.disabled); fields.forEach(n=>n.focus()); const result={left:r.left,right:r.right,top:r.top,viewport:innerWidth,count:fields.length,focus:document.activeElement===fields.at(-1),disabled}; panel.open=false; return result })()`)
  assert(options.left >= report.geometry.sidebar.right && options.right <= options.viewport && options.top >= report.geometry.toolbar.bottom)
  assert.equal(options.count, 2); assert.equal(options.focus, true)
  assert.deepEqual(options.disabled, [false, false]); report.optionsPopup = options
  report.checks.compactGeometryAndNoLongDeveloperSentences = true
  report.checks.rightAlignedControlsAndUsableOptions = true
}
async function buildLeftovers() {
  const id = await js('window.paperstudio.project().then(info => info.id)')
  return readdir(join(profile, 'builds', id)).catch(error => { if (error.code === 'ENOENT') return []; throw error })
}
async function snapshot() {
  const entries = await buildLeftovers(); report.buildLeftovers = entries
  if (entries.length) report.cleanupUnknown = true
  assert.equal(entries.length, 0, 'No leftover build folders; this is not a claim about arbitrary OS profiles')
  assert.equal(report.fetchDenied.length, 0, 'No Main network attempt was needed')
  assert.equal(report.chromiumDenied.length, 0, 'No Chromium HTTP(S) attempt was needed')
  assert.equal(report.prepareIpcCalls, 0)
  window().show(); window().focus()
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  await writeFile(join(work, 'offline-current.png'), (await window().webContents.capturePage()).toPNG())
  report.passed = true; persist()
}
async function stop(reason) {
  if (stopping) return
  stopping = true
  if (reason) { report.failure = String(reason); report.passed = false }
  checkpoint('cooperative-stop-requested', { reason: reason ? String(reason) : null, activeCompiles })
  try {
    if (window() && !window().isDestroyed()) {
      await js('window.paperstudio.cancelCompile()')
      await js('window.paperstudioSetup.cancel()')
    }
    const end = Date.now() + 50000
    while (activeCompiles && Date.now() < end) await new Promise(done => setTimeout(done, 100))
    if (activeCompiles) { report.cleanupUnknown = true; persist(); return }
    persist(); app.quit() // Production close/dirty/owned-cleanup handshake, not app.exit/helper kill.
  } catch (error) { report.cleanupUnknown = true; report.shutdownError = String(error); persist() }
}
app.once('will-quit', () => { report.safeCloseConfirmed = true; report.finishedAt = new Date().toISOString(); persist() })
process.on('message', message => { if (message?.kind === 'offline-smoke-stop') void stop('Nine-minute native-work budget reached') })
app.whenReady().then(async () => {
  checkpoint('electron-ready')
  try {
    await initialEditing(); await geometry()
    let previous = await compile('main.tex', 'pdflatex')
    previous = await compile('bib.tex', 'pdflatex', previous)
    await compile('zh.tex', 'xelatex', previous)
    await snapshot(); await stop()
  } catch (error) {
    report.failure = String(error)
    try { report.lastStatus = await text('status'); report.lastLog = (await text('log')).slice(-6000) } catch {}
    persist(); console.error(error); await stop(error)
  }
})
