// Owned-fixture Electron entry: built Main/IPC/CodeMirror/close stay real; directory selection is replaced.
// Optional auth uses local JSON + mocked browser; synthetic avatar is Renderer-only, never real authorization.
const assert = require('node:assert/strict'), fs = require('node:fs')
const { join, resolve, isAbsolute, dirname } = require('node:path'), { createHash } = require('node:crypto')
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const authFixture = process.env.PAPERSTUDIO_NAV_AUTH_FIXTURE === '1'
const work = process.env.NAV_WORK, started = Date.now(), root = resolve(__dirname, '..')
assert(work && isAbsolute(work)); fs.writeFileSync(join(work, 'child-entry.json'), JSON.stringify({ stage: 'module-entry', pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' })
const f = JSON.parse(fs.readFileSync(join(work, 'fixture.json')))
assert.equal(f.work, work); assert.equal(f.owner, process.env.NAV_TOKEN); assert.equal(fs.readFileSync(join(work, 'fixture-owner'), 'utf8'), f.owner)
assert.equal(f.profile, join(work, 'profile')); for (const p of Object.values(f.projects)) assert.equal(dirname(p.dir), work)
const report = { passed: false, builtMain: true, pid: process.pid, build: f.build, checkpoints: [], checks: {}, safeCloseConfirmed: false, cleanupUnknown: false,
  closeAcks: 0, allowedDriveQueries: 0, forbiddenCalls: 0, networkAttempts: 0, pendingTrackedChannels: [], nativeDialogs: [] }
const persist = () => fs.writeFileSync(join(work, 'result.json'), JSON.stringify(report, null, 2))
const mark = stage => { report.checkpoints.push({ stage, ms: Date.now() - started }); persist() }
let stopping = false, selection = 0; mark('child-entry')
for (const [name, hash] of Object.entries(f.build)) assert.equal(createHash('sha256').update(fs.readFileSync(join(root, 'out', name))).digest('hex'), hash)
const denyNetwork = () => { report.networkAttempts++; mark('network-denied'); throw new Error('Navigation acceptance forbids HTTP') }
report.fixtureDeviceRequests = 0; report.fixturePollRequests = 0; report.fixtureBrowserOpens = 0
shell.openExternal = async url => {
  if (!authFixture) { report.forbiddenCalls++; throw new Error('No external browser in offline acceptance') }
  assert.equal(url, 'https://github.com/login/device'); report.fixtureBrowserOpens++; persist()
}
global.fetch = async (url, init) => {
  if (!authFixture) return denyNetwork()
  assert.equal(init.method, 'POST')
  const body = new URLSearchParams(init.body)
  if (url === 'https://github.com/login/device/code') {
    assert.deepEqual([...body.keys()], ['client_id']); report.fixtureDeviceRequests++
    return new Response(JSON.stringify({ device_code: 'a'.repeat(40), user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }), { headers: { 'content-type': 'application/json' } })
  }
  if (url === 'https://github.com/login/oauth/access_token') {
    assert.equal(body.get('device_code'), 'a'.repeat(40)); report.fixturePollRequests++
    return new Response(JSON.stringify({ error: 'authorization_pending' }), { headers: { 'content-type': 'application/json' } })
  }
  return denyNetwork()
}; for (const protocol of ['node:http', 'node:https']) for (const method of ['request', 'get']) require(protocol)[method] = denyNetwork
const cp = require('node:child_process'), actualExecFile = cp.execFile, net = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/net.exe')
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = (...args) => {
  const [file, argv, options, callback] = args
  if (name === 'execFile' && args.length === 4 && file === net && Array.isArray(argv) && argv.length === 1 && argv[0] === 'use'
    && options && Object.keys(options).sort().join(',') === 'maxBuffer,timeout,windowsHide'
    && options.timeout === 3000 && options.maxBuffer === 65536 && options.windowsHide === true && typeof callback === 'function') {
    report.allowedDriveQueries++; mark('readonly-system32-net-use'); return actualExecFile.apply(cp, args)
  }
  report.forbiddenCalls++; mark('forbidden-process'); throw new Error('No native/helper/other process is allowed in navigation acceptance')
}
app.setPath('userData', f.profile); app.setPath('sessionData', f.profile)
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false)
  contents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, done) => { report.networkAttempts++; persist(); done({ cancel: true }) })
})
dialog.showOpenDialog = async (_window, options) => {
  assert.match(options.title, /打开本地论文项目/); assert(selection < 2)
  return { canceled: false, filePaths: [f.projects[selection++ === 0 ? 'a' : 'b'].dir] }
}
const actualMessage = dialog.showMessageBox.bind(dialog)
dialog.showMessageBox = (...args) => { report.nativeDialogs.push(args.find(arg => arg?.message)?.message ?? 'unknown'); mark('native-message-box'); return actualMessage(...args) }
const handle = ipcMain.handle.bind(ipcMain), pending = new Map(); let sequence = 0
const untracked = new Set(['workspace:environment', 'workspace:repository-transfer', 'workspace:cancel-repository-transfer'])
const tracked = () => [...pending.values()].filter(channel => !untracked.has(channel))
ipcMain.handle = (channel, action) => handle(channel, async (...args) => {
  const id = ++sequence; pending.set(id, channel); report.pendingTrackedChannels = tracked(); mark(channel + ':begin'); let completed = false
  try {
    if (['workspace:compile', 'tex-setup:prepare'].includes(channel)) { report.forbiddenCalls++; throw new Error('No compile/manual prepare IPC in navigation acceptance') }
    const value = await action(...args); completed = true; return value
  } finally { pending.delete(id); report.pendingTrackedChannels = tracked(); mark(channel + (completed ? ':complete' : ':failed')) }
})
ipcMain.on('workspace:close-ack', (_event, _id, dirty) => { report.closeAcks++; report.closeAckDirty = dirty; persist() })
const win = () => BrowserWindow.getAllWindows()[0], js = code => win().webContents.executeJavaScript(code), q = JSON.stringify
const pause = () => new Promise(done => setTimeout(done, 80))
async function until(predicate, label) {
  const end = Math.min(started + 85000, Date.now() + 15000)
  while (!stopping && Date.now() < end) {
    if (report.forbiddenCalls || report.networkAttempts) throw new Error('Unexpected process/network: ' + label)
    if (await predicate()) return
    await pause()
  }
  throw new Error('Timed out/canceled: ' + label)
}
async function click(selector) { await js(`(() => { const n=document.querySelector(${q(selector)}); const modal=document.querySelector('dialog[open]'); if(!n || n.disabled || n.closest('[inert],[hidden]') || !n.getClientRects().length || modal && !modal.contains(n)) throw new Error('Unavailable visible control: '+${q(selector)}); n.click() })(); undefined`) }
const idle = () => until(() => js('!document.getElementById("project-open").disabled'), 'workspace idle')
const row = key => `.pl-open[title=${q(f.projects[key].dir)}]`
const directory = path => `#file-tree .directory-entry[title=${q(path)}]`, file = path => `#file-tree .file-entry[title=${q(path)}]`
async function rootMatches(key) {
  await until(async () => (await js('window.paperstudio.project()'))?.root === f.projects[key].dir && await js(`document.getElementById('project-root').title===${q(f.projects[key].dir)} && document.getElementById('project-name').textContent===${q(f.projects[key].name)} && document.getElementById('active-file').textContent==='main.tex' && document.querySelector('#source-editor .cm-content').textContent.includes(${q('PROJECT_' + key.toUpperCase())})`), 'Main/renderer root-' + key)
  await idle(); await until(() => js(`document.querySelector(${q(row(key))})?.getAttribute('aria-current')==='true'`), 'library current row-' + key)
  assert.equal(await js(`document.querySelector(${q(row(key))}).getAttribute('aria-current')`), 'true')
  await pageIs('editor')
  report.checks['root-' + key] = true; mark('root-verified-' + key)
}
async function choose(key) {
  await idle()
  if (await js('document.body.dataset.page === "editor"')) await click('#home-open')
  await pageIs('home')
  await until(() => js(`Boolean(document.querySelector(${q(row(key))}) && !document.querySelector(${q(row(key))}).disabled)`), 'dashboard entrance ready')
  await click(row(key)); await rootMatches(key)
}
async function pageIs(page) {
  await until(() => js(`(() => { const home=document.getElementById('project-home'), editor=document.getElementById('editor-workspace'); return document.body.dataset.page===${q(page)} && home.hidden===${page !== 'home'} && editor.hidden===${page !== 'editor'} && ${page === 'home' ? 'home' : 'editor'}.getClientRects().length>0 && ${page === 'home' ? 'editor' : 'home'}.getClientRects().length===0 })()`), 'exclusive ' + page + ' page')
  assert(await js("['project-open','project-create','project-library'].every(id=>document.getElementById('project-home').contains(document.getElementById(id)))"), 'Open/create/library belong only to dashboard')
  assert.equal(await js('Boolean(document.querySelector("#editor-workspace #project-open,#editor-workspace #project-create,#editor-workspace #project-library"))'), false)
}
async function dashboardSearch() {
  const input = value => js(`(() => { const n=document.getElementById('project-library-search'); n.value=${q(value)}; n.dispatchEvent(new Event('input',{bubbles:true})) })(); undefined`)
  await input(f.projects.b.name)
  await until(() => js(`Boolean(document.querySelector(${q(row('b'))})) && !document.querySelector(${q(row('a'))})`), 'dashboard search filters names')
  await input('')
  await until(() => js(`Boolean(document.querySelector(${q(row('a'))}) && document.querySelector(${q(row('b'))}))`), 'dashboard search cleared')
  report.checks.dashboardSearchCanBeCleared = true
}
async function homeResumePreservesDraft() {
  const before = report.checkpoints.length, disk = fs.readFileSync(join(f.projects.b.dir, 'main.tex'), 'utf8')
  const buffer = await js('document.querySelector("#source-editor .cm-content").textContent')
  assert(await js('document.getElementById("save-state").classList.contains("dirty")'))
  await click('#home-open'); await pageIs('home')
  await until(() => js(`document.querySelector(${q(row('b'))})?.getAttribute('aria-current')==='true' && !document.querySelector(${q(row('b'))}).disabled`), 'active dashboard row can resume')
  assert.equal(await js('document.querySelector("#source-editor .cm-content").textContent'), buffer)
  assert(await js('document.getElementById("save-state").classList.contains("dirty")'))
  await dashboardSearch(); await capture('home')
  await click(row('b')); await rootMatches('b')
  assert.equal(await js('document.querySelector("#source-editor .cm-content").textContent'), buffer)
  assert(await js('document.getElementById("save-state").classList.contains("dirty")'))
  assert.equal(fs.readFileSync(join(f.projects.b.dir, 'main.tex'), 'utf8'), disk)
  const stages = report.checkpoints.slice(before).map(item => item.stage)
  assert(!stages.some(stage => /^(?:workspace:(?:save|read)|projects:activate):begin$/.test(stage)), 'Home/resume must not save, re-read or reactivate the active paper')
  report.checks.homeResumePreservesUnsavedBufferWithoutSaveOrActivation = true
}
async function directoryToggle(path) {
  const selector = directory(path), active = await js('document.getElementById("active-file").textContent')
  for (const expanded of [false, true]) {
    await click(selector)
    assert.equal(await js(`document.querySelector(${q(selector)}).getAttribute('aria-expanded')`), String(expanded))
    assert.equal(await js(`document.getElementById(document.querySelector(${q(selector)}).getAttribute('aria-controls')).hidden`), !expanded)
    assert.equal(await js('document.getElementById("active-file").textContent'), active, 'Directory toggle must not open a file')
  }
}
const layoutReady = () => js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
async function navigationGeometry(label) {
  await pageIs('editor'); await layoutReady()
  const geometry = await js(`(() => {
    const rect = selector => { const n=document.querySelector(selector); if(!n) throw new Error('Missing geometry target: '+selector); const r=n.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } }
    const files=document.querySelector('#editor-workspace .files-panel'), contents=document.getElementById('paper-contents'), sync=document.getElementById('project-sync')
    return { files:rect('#editor-workspace .files-panel'), contents:rect('#paper-contents'), outline:rect('#editor-workspace .outline-panel'), editor:rect('#editor-panel'), pdf:rect('.preview-panel'), sync:rect('#project-sync'),
      syncInsideFiles:files.contains(sync)&&contents.contains(sync), syncInGlobalHeader:Boolean(document.querySelector('.topbar #project-sync')),
      compileInsidePdf:Boolean(document.querySelector('.preview-panel #compile')), editorToolbar:Boolean(document.querySelector('#editor-panel .editor-toolbar')),
      editorColor:getComputedStyle(document.getElementById('editor-panel')).backgroundColor,
      viewport:{width:innerWidth,height:innerHeight}, documentWidth:document.documentElement.scrollWidth }
  })()`)
  const { files, contents, outline, editor, pdf, sync } = geometry
  const near = (actual, expected, message) => assert(Math.abs(actual - expected) <= 1, `${label}: ${message}: ${actual} vs ${expected}`)
  near(files.width, geometry.viewport.width <= 1200 ? 240 : 280, 'single editor sidebar width')
  near(files.right, editor.left, 'single file column immediately left of editor'); near(editor.right, pdf.left, 'editor immediately left of PDF')
  for (const [name, panel] of Object.entries({ contents, outline, sync })) {
    assert(panel.width > 0 && panel.height > 0, `${label}: ${name} stays visible`)
    assert(panel.left >= files.left - 1 && panel.right <= files.right + 1, `${label}: ${name} stays within file column`)
  }
  assert(contents.top >= files.top - 1 && contents.bottom <= outline.top + 1 && outline.bottom <= files.bottom + 1, `${label}: outline stays below file tree`)
  assert(sync.top >= contents.top - 1 && sync.bottom <= contents.bottom + 1 && geometry.syncInsideFiles && !geometry.syncInGlobalHeader, `${label}: sync is inside current file-tree column`)
  assert(geometry.compileInsidePdf && geometry.editorToolbar, `${label}: compile and editor tools belong to their own panels`)
  assert.equal(geometry.editorColor, 'rgb(255, 255, 255)'); assert(editor.width >= 140 && pdf.width >= 140)
  assert(geometry.documentWidth <= geometry.viewport.width + 1, `${label}: no horizontal page overflow`)
  report.checks[label] = geometry; mark('geometry-' + label)
}
async function logGeometry() {
  assert(await js('document.getElementById("log-panel").hidden'), 'Logs start closed')
  await click('#log-open'); await layoutReady()
  const geometry = await js(`(() => {
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
    return {files:rect('.files-panel'),outline:rect('.outline-panel'),log:rect('#log-panel'),pdf:rect('.preview-panel')}
  })()`)
  assert(geometry.log.height > 100 && geometry.log.left >= geometry.files.right - 1, 'Logs never cross underneath file tree/outline')
  assert(Math.abs(geometry.log.bottom - geometry.files.bottom) <= 1 && Math.abs(geometry.outline.bottom - geometry.files.bottom) <= 1, 'Outline keeps full sidebar height beside logs')
  assert(Math.abs(geometry.log.right - geometry.pdf.right) <= 1, 'Logs belong only to source/PDF area')
  await capture('logs'); await click('#log-close')
  assert(await js('document.getElementById("log-panel").hidden'), 'Visible close button closes logs')
  await click('#log-open'); await click('#log-open')
  assert(await js('document.getElementById("log-panel").hidden'), 'Toolbar button toggles both ways')
  report.checks.logsIndependentOfSidebar = geometry
}
async function shortViewportLongTitle() {
  const bounds = win().getBounds(), minimum = win().getMinimumSize(), selectors = ['#project-name', '#file-tree-context', '#project-settings-name', '#revision-context']
  const originals = await js(`Object.fromEntries(${q(selectors)}.map(selector=>[selector,document.querySelector(selector).textContent]))`)
  const title = '用于检验窄栏的超长论文标题_Long_Paper_Title_'.repeat(8)
  const rename = values => js(`(() => { for(const [selector,value] of Object.entries(${q(values)})) document.querySelector(selector).textContent=value })(); undefined`)
  try {
    win().setMinimumSize(0, 0); win().setContentSize(1100, 650)
    await until(() => js('innerWidth===1100 && innerHeight===650'), 'short content viewport')
    await rename(Object.fromEntries(selectors.map(selector => [selector, title])))
    await navigationGeometry('shortEditorLongTitle')
    if (await js('!document.getElementById("revision-panel").hidden')) await inlineHistoryGeometry('shortHistoryLongTitle')
  } finally {
    await rename(originals); win().setMinimumSize(...minimum); win().setBounds(bounds)
    await until(() => { const current=win().getBounds(); return ['x','y','width','height'].every(key=>current[key]===bounds[key]) }, 'restore default window bounds')
    await layoutReady()
  }
}
async function capture(mode) {
  await layoutReady()
  fs.writeFileSync(join(work, mode + '.png'), (await win().webContents.capturePage()).toPNG()); mark('screenshot-' + mode)
}
function protectedFiles(dir) {
  const result = {}, walk = path => {
    const full = join(dir, path), info = fs.lstatSync(full); assert(!info.isSymbolicLink())
    if (info.isDirectory()) { result[path + '/'] = 'directory'; for (const name of fs.readdirSync(full).sort()) walk(join(path, name)) }
    else { assert(info.isFile() && info.nlink === 1); result[path] = createHash('sha256').update(fs.readFileSync(full)).digest('hex') }
  }; walk(''); return result
}
async function startupChoice() {
  await until(() => js('document.getElementById("startup-dialog").open'), 'startup choice shown')
  if (process.env.PAPERSTUDIO_NAV_CONFIGURED === '1') await until(() => js('!document.getElementById("startup-login").disabled'), 'startup configured login ready')
  await layoutReady()
  const geometry = await js(`(() => {
    const dialog=document.getElementById('startup-dialog'), r=dialog.getBoundingClientRect()
    const controls=['startup-login','startup-offline'].map(id=>{const n=document.getElementById(id),b=n.getBoundingClientRect();return {id,width:b.width,height:b.height,left:b.left,right:b.right,top:b.top,bottom:b.bottom}})
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,controls,focus:document.activeElement.id}
  })()`)
  assert(geometry.left >= 0 && geometry.right <= geometry.width && geometry.top >= 0 && geometry.bottom <= geometry.height)
  for (const control of geometry.controls) assert(control.width > 0 && control.height > 0 && control.left >= geometry.left && control.right <= geometry.right && control.top >= geometry.top && control.bottom <= geometry.bottom)
  assert.equal(geometry.focus, 'startup-offline'); report.checks.startupChoice = geometry
  await capture('startup'); await click('#startup-offline')
  assert.equal(await js('document.getElementById("startup-dialog").open'), false)
  assert.equal(await js('document.getElementById("cloud-dialog").open'), false)
  assert.equal((await js('window.paperstudioCollaboration.status()')).account, null)
  assert(!report.checkpoints.some(item => /collaboration:(login|open-verification|projects):begin/.test(item.stage)))
  report.checks.startupOfflineWithoutAuthentication = true
}
async function automaticBrowserFixture() {
  assert.equal(report.fixtureBrowserOpens, 0); assert.equal(report.fixtureDeviceRequests, 0)
  await click('#account-toggle'); await click('#account-settings'); await click('#collaboration-login')
  await until(() => report.fixtureBrowserOpens === 1, 'automatic official browser invocation')
  assert.equal(report.fixtureDeviceRequests, 1); assert.deepEqual(report.nativeDialogs, [])
  const state = await js('window.paperstudioCollaboration.status()')
  assert.equal(state.phase, 'authorizing'); assert.equal(state.authorization.userCode, 'ABCD-EFGH')
  await until(() => js('document.getElementById("collaboration-code").textContent === "ABCD-EFGH" && document.getElementById("collaboration-code").getClientRects().length > 0'), 'required code visible')
  await capture('authorizing')
  await js('window.paperstudioCollaboration.status()'); await layoutReady()
  assert.equal(report.fixtureBrowserOpens, 1)
  await click('#collaboration-cancel')
  await until(async () => (await js('window.paperstudioCollaboration.status()')).phase === 'signed-out', 'cancel automatic login fixture')
  assert.equal(await js('document.getElementById("collaboration-code").textContent'), '')
  await click('#cloud-close')
  report.checks.automaticAuthorizationBrowserFixture = { browserOpens: report.fixtureBrowserOpens, deviceRequests: report.fixtureDeviceRequests,
    realBrowserOpened: false, realGitHubAuthorized: false, nativeConsentDialogs: report.nativeDialogs.length }
}
async function inlineHistoryGeometry(label) {
  await layoutReady()
  const geometry = await js(`(() => {
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}}
    return {pdf:rect('.preview-panel'), history:rect('#revision-panel'), editor:rect('#editor-panel'), viewport:innerWidth,
      documentWidth:document.documentElement.scrollWidth, modal:document.getElementById('cloud-dialog').open,
      detached:Boolean(document.getElementById('revision-panel').closest('dialog')),
      colors:['#editor-workspace .files-panel','#editor-panel','.preview-panel','#revision-panel'].map(s=>getComputedStyle(document.querySelector(s)).backgroundColor)}
  })()`)
  assert(!geometry.modal && !geometry.detached); assert(Math.abs(geometry.pdf.right-geometry.history.left)<=1)
  assert(Math.abs(geometry.pdf.top-geometry.history.top)<=1 && Math.abs(geometry.pdf.bottom-geometry.history.bottom)<=1)
  assert(geometry.editor.width>=140 && geometry.pdf.width>=140 && geometry.history.width>=240)
  assert(geometry.history.right<=geometry.viewport+1 && geometry.documentWidth<=geometry.viewport+1)
  assert.equal(geometry.colors[1], 'rgb(255, 255, 255)'); report.checks[label]=geometry
}
async function accountAvatarFixture() {
  // Renderer identity presentation only. Main remains signed out; no token or real authorization exists.
  const checkpoint=report.checkpoints.length
  win().webContents.send('collaboration:state', { phase:'signed-in',account:{id:7,login:'fixture-writer',name:'示例作者'},authorization:null,expiresAt:Date.now()+3600000,sessionOnly:true,message:'' })
  await until(()=>js('document.getElementById("account-label").textContent==="fixture-writer"'), 'fixture account avatar')
  await click('#account-toggle'); assert.equal(await js('document.getElementById("account-name").textContent'), '示例作者')
  assert.equal(await js('document.getElementById("account-avatar").textContent'), '示')
  await capture('account-authenticated'); await click('#account-toggle')
  win().webContents.send('collaboration:state', {phase:'signed-out',account:null,authorization:null,expiresAt:null,sessionOnly:true,message:''})
  await until(()=>js('document.getElementById("account-label").textContent==="未登录"'), 'clear fixture identity')
  assert.equal((await js('window.paperstudioCollaboration.status()')).account,null)
  assert(!report.checkpoints.slice(checkpoint).some(item=>/collaboration:(login|open-verification|projects):begin/.test(item.stage)))
  report.checks.avatarPresentationFixture={rendererOnly:true,realAccountAuthorized:false}
}
async function workbenchZones() {
  assert.equal(await js('document.querySelector("footer,.statusbar")'), null)
  assert.equal(await js('document.getElementById("project-actions").hidden'), false)
  assert(await js(`document.getElementById('project-sync').disabled && document.getElementById('project-sync').title.includes(${q(f.projects.a.name)})`))
  await click('#account-toggle'); await capture('account-menu'); await click('#account-settings')
  assert(await js('document.getElementById("cloud-dialog").open && !document.querySelector("#cloud-dialog #revision-list,#cloud-dialog #cloud-project-workspace")'))
  await click('#cloud-close'); await click('#project-settings')
  assert(await js(`document.getElementById('project-dialog').open && document.getElementById('project-settings-name').textContent===${q(f.projects.a.name)}`))
  await click('#project-close'); await click('#cloud-open')
  await until(()=>js('document.querySelectorAll("#revision-list .revision-entry").length>0'), 'inline history entries')
  await idle(); const id=await js('[...document.querySelectorAll("#revision-list .revision-entry")].find(n=>n.textContent.includes("main.tex"))?.dataset.revisionId')
  assert(id); await click('#revision-list .revision-entry[data-revision-id='+q(id)+']')
  await until(()=>js('document.getElementById("revision-after").textContent.includes("PROJECT_A")'), 'real current-project revision detail')
  await idle(); assert(await js('document.getElementById("revision-after").textContent.includes("PROJECT_A")'))
  await inlineHistoryGeometry('historyRightOfPdf'); await capture('history')
  if (!authFixture) await accountAvatarFixture()
  report.checks.projectSyncIsCurrentPaperOnly=true; report.checks.noBottomStatusStrip=true
}
async function exercise() {
  await startupChoice()
  if (process.env.PAPERSTUDIO_NAV_CONFIGURED === '1') {
    const account = await js('window.paperstudioCollaboration.status()')
    assert.equal(account.phase, 'signed-out'); assert.equal(account.account, null); assert.equal(account.sessionOnly, true)
    await until(() => js('!document.getElementById("collaboration-login").disabled'), 'configured login button enabled')
    assert(!await js('document.getElementById("collaboration-state").textContent.includes("未配置")'))
    report.checks.publisherConfiguredWithoutLoginOrNetwork = true
  }
  if (authFixture) await automaticBrowserFixture()
  assert.equal(await js('window.paperstudio.project()'), null)
  await pageIs('home')
  await click('#project-open'); await rootMatches('a')
  await click('#home-open'); await pageIs('home'); await click('#project-open'); await rootMatches('b')
  for (const path of ['chapters', 'chapters/sections', 'emptydir']) assert(await js(`Boolean(document.querySelector(${q(directory(path))}))`), 'Real directory missing: ' + path)
  assert.equal(await js(`document.querySelector(${q(file('chapters/intro.tex') + ' span')}).textContent`), 'intro.tex')
  await directoryToggle('chapters'); await directoryToggle('emptydir')
  await click(file('chapters/intro.tex')); await until(() => js('document.getElementById("active-file").textContent==="chapters/intro.tex"'), 'real nested-file open'); await idle()
  assert(await js('document.querySelector("#source-editor .cm-content").textContent.includes("NESTED_B")'))
  await click(file('main.tex')); await rootMatches('b'); report.checks.nestedFileEmptyDirectoryAndToggle = true
  await navigationGeometry('editorSingleSidebar'); await capture('editor'); await logGeometry()
  await js('document.querySelector("#source-editor .cm-content").focus(); undefined'); assert(await js('document.activeElement===document.querySelector("#source-editor .cm-content")'))
  win().webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Home', modifiers: ['control'] }); win().webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Home', modifiers: ['control'] })
  await win().webContents.insertText('% NAVIGATION_B_DIRTY_SAVED\n'); await until(() => js('document.getElementById("save-state").classList.contains("dirty")'), 'real CM dirty B')
  await homeResumePreservesDraft()
  const before = report.checkpoints.length; await choose('a')
  const stages = report.checkpoints.slice(before).map(item => item.stage)
  assert(stages.indexOf('workspace:save:complete') >= 0 && stages.indexOf('workspace:save:complete') < stages.indexOf('projects:activate:begin'))
  assert(fs.readFileSync(join(f.projects.b.dir, 'main.tex'), 'utf8').startsWith('% NAVIGATION_B_DIRTY_SAVED\n')); report.checks.savedBBeforeActivateA = true
  await workbenchZones(); await shortViewportLongTitle(); await inlineHistoryGeometry('historyAfterViewportRestore'); await navigationGeometry('editorWithHistory')
  await click('#home-open'); await pageIs('home'); await click('#project-library-refresh'); await idle()
  await until(() => js(`Boolean(document.querySelector(${q(row('a'))}) && document.querySelector(${q(row('b'))}))`), 'dashboard refreshed entrances')
  report.checks.dashboardAndEditorAreIndependent = true
  const protectedB = protectedFiles(f.projects.b.dir); await click(row('b') + ' + .pl-forget')
  await until(() => js('document.getElementById("confirm-dialog").open'), 'real forget confirmation'); assert.match(await js('document.getElementById("confirm-detail").textContent'), /不会删除/)
  await click('#confirm-dialog button[value="accept"]'); await idle()
  await until(async () => !(await js('window.paperstudioProjects.list()')).projects.some(p => p.root === f.projects.b.dir), 'forget only removes entrance')
  assert.deepEqual(protectedFiles(f.projects.b.dir), protectedB); assert.equal((await js('window.paperstudio.project()')).root, f.projects.a.dir)
  report.checks.forgetPreservesPapersGitHistoryAndEmptyDirs = true; assert.equal(selection, 2)
  await choose('a')
  assert.equal(await js('document.getElementById("startup-dialog").open'), false, 'Offline choice must not reopen during home/editor/project changes')
}
async function drain() {
  const end = Date.now() + 30000; let quiet = 0; mark('close-drain-begin')
  while (Date.now() < end) {
    report.closeReadiness = await js('({idle:!document.getElementById("project-open").disabled,dirty:document.getElementById("save-state").classList.contains("dirty")})')
    report.pendingTrackedChannels = tracked()
    if (report.closeReadiness.idle && !report.closeReadiness.dirty && !tracked().length) { quiet ||= Date.now(); if (Date.now() - quiet >= 250) { mark('close-drained'); return true } } else quiet = 0
    persist(); await pause()
  }
  report.cleanupUnknown = true; report.passed = false; mark('close-drain-unknown-owner-retained'); return false
}
async function stop(error) {
  if (stopping) return; stopping = true
  if (error) { report.passed = false; report.failure = String(error) }
  mark('cooperative-close')
  try {
    if (win() && !win().isDestroyed()) {
      await js('window.paperstudioSetup.cancel()')
      if (await js('document.getElementById("save-state").classList.contains("dirty") && !document.getElementById("file-save").disabled')) await click('#file-save')
      if (!await drain()) return
    }
    mark('app-quit-after-real-drain'); app.quit()
  } catch (failure) { report.cleanupUnknown = true; report.shutdownError = String(failure); persist() }
}
process.once('uncaughtException', error => { console.error(error); void stop(error) }); process.once('unhandledRejection', error => { console.error(error); void stop(error) })
process.on('message', message => { if (message?.kind === 'navigation-stop') void stop(new Error('90s cooperative budget reached')) })
app.once('will-quit', () => { report.safeCloseConfirmed = report.closeAcks > 0 && report.closeAckDirty === false && report.closeReadiness?.idle && !report.closeReadiness?.dirty && !tracked().length && !report.cleanupUnknown; report.finishedAt = new Date().toISOString(); persist() })
process.once('exit', code => { report.exitCode = code; persist() })
mark('before-built-main'); require('../out/main/index.js'); mark('after-built-main')
app.whenReady().then(async () => {
  try {
    await until(() => win() && !win().webContents.isLoading(), 'built window'); await until(() => js('Boolean(window.paperstudioProjects?.activate && window.paperstudioSetup?.cancel)'), 'built preload')
    win().setTitle('PaperStudio · 自动验收临时项目（请勿操作）'); win().setSize(1500, 960); win().show(); win().focus()
    await js('window.paperstudioSetup.cancel()'); await idle(); mark('real-automatic-setup-canceled')
    await until(() => js('!document.getElementById("project-library-refresh").disabled'), 'library initialized')
    await exercise(); await idle(); assert.equal(report.networkAttempts, 0); assert.equal(report.forbiddenCalls, 0); assert(report.allowedDriveQueries > 0); assert.deepEqual(report.nativeDialogs, [])
    report.passed = true; mark('navigation-passed'); await stop()
  } catch (error) { console.error(error); try { report.lastStatus = await js('document.getElementById("status")?.textContent') } catch {} await stop(error) }
})
