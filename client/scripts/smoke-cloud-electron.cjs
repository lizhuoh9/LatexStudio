// Real source Main controllers/services with synthetic HTTP; real built preload and renderer.
// Not the built Main entry point, packaged binary, OAuth provider or a real GitHub account.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { readFile, writeFile, access } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { isAbsolute, join, resolve, relative } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow, dialog, session } = require('electron')
const ts = require('typescript')
const work = process.env.SMOKE_WORK, project = process.env.SMOKE_PROJECT, profile = process.env.SMOKE_PROFILE
assert(work && isAbsolute(work) && project === join(work, 'project') && profile === join(work, 'profile'))
assert.equal(fs.readFileSync(join(work, 'fixture-owner'), 'utf8'), process.env.SMOKE_TOKEN)
assert.equal(process.env.SMOKE_RESULT, join(work, 'result.json'))
assert.equal(process.env.SMOKE_SCREENSHOT, resolve(__dirname, '../release/cloud-ui-smoke.png'))
const root = resolve(__dirname, '..'), sources = {}, token = 'ghu_synthetic-cloud-ui-never-real'
const edited = 'Local paper saved by the real CodeMirror before private project creation.\n'
const who = { id: 123, login: 'fixture-author', name: 'Fixture Login (synthetic HTTP)' }
const repository = { id: 42, owner: { login: who.login }, name: 'paper-fixture', private: true }
const incoming = { id: 77, owner: { login: 'fixture-team' }, name: 'invited-paper', private: true }
const invitation = { id: 88, repository: incoming, invitee: { id: who.id, login: who.login }, inviter: { login: 'fixture-owner' } }
const state = { created: false, accepted: false }
const report = { checks: {}, requests: [], unexpectedRequests: [], nativeDialogs: [], sourceMainSha256: sources, closeCanceled: 0, fixtureAccount: who.login, electron: process.versions.electron, chromium: process.versions.chrome }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
require.extensions['.ts'] = (module, filename) => {
  const text = fs.readFileSync(filename, 'utf8')
  assert(!text.includes('import.meta'), 'Source loader does not rewrite import.meta; ask Lead if incompatible')
  sources[relative(root, filename).replaceAll('\\', '/')] = hash(text)
  module._compile(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText, filename)
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
async function syntheticFetch(input, init = {}) {
  const url = new URL(String(input)), method = init.method || 'GET', endpoint = method + ' ' + url.origin + url.pathname
  assert(init.signal instanceof AbortSignal, 'Real transport must pass an AbortSignal')
  if (init.signal.aborted) throw new Error('Synthetic fetch canceled')
  report.requests.push({ method, url: url.href, ...(init.body && url.origin === 'https://api.github.com' ? { body: JSON.parse(init.body) } : {}) })
  if (endpoint === 'POST https://github.com/login/device/code') return json({ device_code: 'a'.repeat(40), user_code: 'TEST-FIXT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
  if (endpoint === 'POST https://github.com/login/oauth/access_token') return json({ access_token: token, token_type: 'bearer', expires_in: 3600 })
  if (url.origin === 'https://api.github.com') {
    const paged = ['/user/installations', '/user/installations/17/repositories', '/user/repository_invitations'].includes(url.pathname)
    assert.equal(url.search, paged ? '?per_page=50&page=1' : '', 'Unknown query refused before synthetic API dispatch')
    return syntheticApi(url, method, init)
  }
  report.unexpectedRequests.push(endpoint); throw new Error('Unexpected HTTP endpoint; no real network allowed')
}
async function syntheticApi(url, method, init) {
  const endpoint = method + ' ' + url.pathname
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + token)
  if (endpoint === 'GET /user') return json(who)
  if (endpoint === 'GET /user/installations') return json({ total_count: 1, installations: [{ id: 17 }] })
  if (endpoint === 'GET /user/installations/17/repositories') {
    const repositories = [...(state.created ? [repository] : []), ...(state.accepted ? [incoming] : [])]
    return json({ total_count: repositories.length, repositories })
  }
  if (endpoint === 'POST /user/repos') {
    assert.deepEqual(JSON.parse(init.body), { name: repository.name, private: true, auto_init: false })
    assert.equal(state.created, false, 'Only one explicit creation request')
    report.createObservedDisk = await readFile(join(project, 'main.tex'), 'utf8')
    assert.equal(report.createObservedDisk, edited, 'Dirty editor must save before remote creation')
    state.created = true; return json(repository, 201)
  }
  if (endpoint === 'GET /repos/fixture-author/paper-fixture' && state.created) return json({ ...repository, default_branch: 'main', permissions: { push: true, admin: true } })
  if (endpoint === 'PUT /repos/fixture-author/paper-fixture/collaborators/fixture-student') {
    assert.deepEqual(JSON.parse(init.body), { permission: 'push' })
    return json({ id: 501, repository, invitee: { login: 'fixture-student' } }, 201)
  }
  if (endpoint === 'GET /user/repository_invitations') return json(state.accepted ? [] : [invitation])
  if (endpoint === 'PATCH /user/repository_invitations/88') { assert.equal(state.accepted, false); state.accepted = true; return new Response(null, { status: 204 }) }
  report.unexpectedRequests.push(endpoint); throw new Error('Unexpected API endpoint; no real network allowed')
}
globalThis.fetch = syntheticFetch
app.setPath('userData', profile); app.enableSandbox()
dialog.showOpenDialog = async (_window, options) => {
  assert.match(options.title, /打开本地论文项目/)
  report.nativeDialogs.push('directory selection'); return { canceled: false, filePaths: [project] }
}
dialog.showMessageBox = async (_window, options) => {
  report.nativeDialogs.push(options.message)
  if (options.message === '当前文档有尚未保存的编辑。') return { response: 0 }
  assert(options.message.includes('请求一次性授权码') || options.message === '邀请 fixture-student 编辑私有项目？' || options.message === '接受此 GitHub 仓库邀请？', 'Unexpected native confirmation')
  assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
  return { response: 1 }
}
const { CollaborationController } = require('../src/main/collaboration/controller.ts')
const { WorkspaceController } = require('../src/main/workspace/controller.ts')
const { TexSetupController } = require('../src/main/tex/controller.ts')
const { SETTINGS_WEB_PREFERENCES } = require('../src/main/session-policy.ts')
const { restrictSession } = require('../src/main/session.ts')
let window, collaboration, setup, controller, quitting = false
const js = expression => window.webContents.executeJavaScript(expression)
const click = id => js(`(() => { const node = document.getElementById(${JSON.stringify(id)}); if (!node || node.disabled) throw new Error('UI button unavailable: ' + ${JSON.stringify(id)}); for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; node.scrollIntoView({ block: 'nearest' }); node.focus(); node.click() })(); undefined`)
const text = id => js(`document.getElementById(${JSON.stringify(id)}).textContent`)
async function until(predicate, label, timeout = 14000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await new Promise(done => setTimeout(done, 80)) }
  throw new Error('Timed out: ' + label)
}
async function idle() { await until(() => js('!document.getElementById("project-open").disabled'), 'workspace idle') }
async function input(id, value) { await js(`(() => { const node = document.getElementById(${JSON.stringify(id)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('input', { bubbles: true })) })(); undefined`) }
async function confirm(title) {
  await until(() => js('document.getElementById("confirm-dialog").open'), 'HTML confirmation')
  assert.match(await text('confirm-title'), title)
  await js('document.querySelector("#confirm-dialog button[value=accept]").click(); undefined')
}
async function edit(content) {
  await idle(); window.show(); window.focus()
  await js('document.querySelector("#source-editor .cm-content").focus(); undefined')
  assert.equal(await js('document.activeElement === document.querySelector("#source-editor .cm-content")'), true, 'CodeMirror must own renderer focus')
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers })
  await js('new Promise(done => requestAnimationFrame(done))')
  await window.webContents.insertText(content)
  await until(() => js('document.getElementById("save-state").classList.contains("dirty")'), 'CodeMirror dirty state')
  const observed = await js("[...document.querySelectorAll('#source-editor .cm-line')].map(line => line.textContent).join('\\n')")
  report.editorInputWitnesses ??= []; report.editorInputWitnesses.push(observed)
  assert.equal(observed, content, 'Trusted input must replace exactly the selected CodeMirror document before any cloud action')
}
async function start() {
  const target = session.fromPartition(SETTINGS_WEB_PREFERENCES.partition)
  restrictSession(target)
  target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  window = new BrowserWindow({ width: 1500, height: 960, webPreferences: { ...SETTINGS_WEB_PREFERENCES, preload: join(root, 'out/preload/index.js') } })
  window.webContents.setBackgroundThrottling(false)
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const url = pathToFileURL(join(root, 'out/renderer/index.html')).href
  collaboration = new CollaborationController(window, url, 'Iv1.cloud-ui-fixture')
  setup = new TexSetupController(window, url, profile)
  controller = new WorkspaceController(window, url, profile, async () => { await Promise.all([setup.cancelAndWait(), collaboration.cancelAndWait()]) }, collaboration.service)
  collaboration.register(); setup.register()
  window.on('close', event => {
    if (quitting) return
    event.preventDefault(); void safeClose()
  })
  await controller.initialize()
  await until(() => js('Boolean(window.paperstudioCloud?.createPrivateProject && window.paperstudioCollaboration?.startLogin)'), 'built trusted preload APIs')
}
async function safeClose() {
  collaboration.blockNewActions(); setup.blockNewActions()
  if (await controller.requestClose()) { quitting = true; window.close() }
  else { collaboration.resumeActions(); setup.resumeActions(); report.closeCanceled++ }
}
async function loginAndCreate() {
  await idle(); await click('project-open')
  await until(() => js('document.getElementById("active-file").textContent === "main.tex"'), 'local paper opened')
  await idle(); await edit(edited)
  await click('cloud-open')
  await until(() => js('!document.getElementById("collaboration-login").disabled'), 'fixture login available')
  await click('collaboration-login')
  await until(() => collaboration.service.status().phase === 'signed-in', 'actual device-flow service signs in using synthetic HTTP')
  await until(() => js('!document.getElementById("cp-create").disabled'), 'CloudPanel receives signed-in state')
  report.checks.realUiDeviceLogin = true
  await input('cp-name', repository.name)
  await click('cp-create'); await confirm(/创建私有合作项目/)
  await until(() => js('!document.getElementById("cp-connected").hidden'), 'create binds current local paper')
  await idle()
  assert.equal(await readFile(join(project, 'main.tex'), 'utf8'), edited)
  const binding = JSON.parse(await readFile(join(project, '.git', 'paperstudio-app.json'), 'utf8'))
  assert.deepEqual(binding, { projectId: 42, owner: who.login, name: repository.name, branch: 'main', accountId: who.id })
  report.checks.dirtySavedBeforeRemoteCreate = true
  report.checks.createPrivateTrueAndNoUpload = true
  report.checks.correctSecretFreeLocalBinding = true
}
async function shareAndInvitations() {
  await click('cp-share')
  const link = 'https://github.com/' + who.login + '/' + repository.name
  await until(() => js(`document.getElementById('cp-share-link').value === ${JSON.stringify(link)}`), 'canonical sharing link shown')
  report.shareLink = link; report.checks.uiShareLink = true
  await idle(); await input('cp-login', 'fixture-student'); await click('cp-invite')
  await until(() => report.requests.some(request => request.method === 'PUT'), 'explicit target user invitation')
  await idle(); report.checks.explicitInviteUserAndPushPermission = true
  await click('cp-invitations')
  await until(() => js('document.querySelectorAll("#cp-invitation-list button").length === 1'), 'opaque invitation handle rendered')
  await idle()
  await js('document.querySelector("#cp-invitation-list button").click(); undefined')
  await confirm(/接受合作邀请/)
  await until(() => state.accepted, 'real service processes synthetic 204 acceptance')
  await idle(); report.checks.invitationListAnd204Accept = true
  assert.equal(report.requests.filter(request => request.method === 'POST' && request.url === 'https://api.github.com/user/repos').length, 1)
  assert(!report.requests.some(request => request.url.includes('.git/') || request.url.includes('git-receive-pack')))
  assert.deepEqual(report.unexpectedRequests, [])
  for (const file of ['paperstudio-app.json', 'paperstudio.json', 'config']) assert(!(await readFile(join(project, '.git', file), 'utf8')).includes(token))
  assert.equal(await access(join(profile, 'github-credentials.json')).then(() => true, () => false), false)
  assert.equal(await readFile(join(project, 'other.tex'), 'utf8'), 'Unchanged second file.\n')
  report.checks.noNetworkGitPushVaultOrOtherFileChanges = true
}
async function verifyScientificPalette() {
  report.computedColors = await js(`(() => { const selectors = ['#cp-create', '#cp-sync', 'body', '.app-shell', '.topbar', '.toolbar', '.editor-panel', '.files-panel', '.preview-panel', '#cloud-dialog']; return Object.fromEntries(selectors.map(selector => [selector, getComputedStyle(document.querySelector(selector)).backgroundColor])) })()`)
  assert.equal(report.computedColors['#cp-create'], 'rgb(0, 101, 159)')
  assert.equal(report.computedColors['#cp-sync'], 'rgb(0, 101, 159)')
  for (const [selector, color] of Object.entries(report.computedColors)) {
    if (selector.startsWith('#cp-')) continue
    const parts = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color)
    assert(parts, 'Expected browser-normalized RGB background: ' + selector)
    assert.equal(parts[1], parts[2], 'Non-neutral workspace background: ' + selector)
    assert.equal(parts[2], parts[3], 'Non-neutral workspace background: ' + selector)
  }
  report.savePlacement = await js(`(() => { const save=document.querySelector('#file-save'), state=document.querySelector('#save-state'); const a=save.getBoundingClientRect(), b=state.getBoundingClientRect(); return { inEditor:!!save.closest('#editor-panel > .panel-heading'), inToolbar:!!save.closest('.toolbar'), gap:a.left-b.right, centered:Math.abs(a.top+a.height/2-b.top-b.height/2)<1, shortcut:save.getAttribute('aria-keyshortcuts') } })()`)
  assert.equal(report.savePlacement.inEditor, true); assert.equal(report.savePlacement.inToolbar, false)
  assert(report.savePlacement.gap >= 8 && report.savePlacement.centered)
  assert.equal(report.savePlacement.shortcut, 'Control+s Meta+s')
  report.checks.scientificPaletteAndSaveInEditorHeader = true
}
async function screenshot() {
  await js(`(() => { const panel = document.getElementById('cloud-project-workspace'); const note = document.createElement('p'); note.textContent = '仅本机合成 HTTP 验收 · fixture-author（非真实 GitHub 登录）· Source Main + built UI'; note.style.cssText = 'font-weight:bold;color:#333'; panel.prepend(note); for (const group of panel.querySelectorAll('details')) group.open = group.contains(document.getElementById('cp-share')); panel.scrollIntoView({ block: 'start' }) })(); undefined`)
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  await writeFile(process.env.SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
  report.screenshot = 'release/cloud-ui-smoke.png'
  report.builtSha256 = {}
  for (const file of ['preload/index.js', 'renderer/index.html']) report.builtSha256[file] = hash(await readFile(join(root, 'out', file)))
  const html = await readFile(join(root, 'out/renderer/index.html'), 'utf8')
  for (const match of html.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g)) {
    const file = resolve(root, 'out/renderer', match[1]); assert(file.startsWith(resolve(root, 'out/renderer') + require('node:path').sep))
    report.builtSha256[relative(join(root, 'out'), file).replaceAll('\\', '/')] = hash(await readFile(file))
  }
}
async function workbenchScreenshot() {
  await js(`(() => { const note = document.createElement('div'); note.textContent = '合成 HTTP GUI 验收 · fixture-author（非真实 GitHub）· Source Main + built UI · 未编译 TeX'; note.style.cssText = 'position:fixed;bottom:4px;right:8px;z-index:10000;background:#f5f5f5;color:#333;padding:4px 8px;border:1px solid #bbb;font-size:12px'; document.body.append(note) })(); undefined`)
  await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  await writeFile(join(root, 'release/cloud-ui-workbench.png'), (await window.webContents.capturePage()).toPNG())
  report.workbenchScreenshot = 'release/cloud-ui-workbench.png'
}
async function dirtyClose() {
  await click('cloud-close'); await idle(); await workbenchScreenshot(); await edit(edited + 'Unsaved close-protection input.\n')
  window.close()
  await until(() => report.closeCanceled === 1, 'normal close request canceled with dirty draft')
  assert(!window.isDestroyed() && window.isEnabled())
  assert.equal(await readFile(join(project, 'main.tex'), 'utf8'), edited)
  assert.match(await js('document.querySelector("#source-editor .cm-content").textContent'), /Unsaved close-protection input/)
  report.checks.normalCloseCanceledAndDraftRetained = true
  await js('document.querySelector("#source-editor .cm-content").focus(); undefined')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] })
  await until(() => js('!document.getElementById("save-state").classList.contains("dirty")'), 'Ctrl+S explicitly saves dirty draft')
  assert.equal(await readFile(join(project, 'main.tex'), 'utf8'), edited + 'Unsaved close-protection input.\n')
  report.checks.realControlSSavesDirtyDraft = true
  await idle()
  const closed = new Promise(done => window.once('closed', done))
  window.close(); await closed
  report.checks.normalCleanCloseHandshake = true
}
app.whenReady().then(async () => {
  await start(); await loginAndCreate(); await verifyScientificPalette(); await shareAndInvitations(); await screenshot(); await dirtyClose()
  report.profileIsTemporary = app.getPath('userData') === profile
  await writeFile(process.env.SMOKE_RESULT, JSON.stringify(report, null, 2))
  app.quit()
}).catch(async error => {
  console.error(error)
  report.error = error.stack
  try { report.uiStatus = await text('status'); report.cloudMessage = await text('cp-message'); report.log = (await text('log')).slice(-2500) } catch {}
  try {
    const { lstat } = require('node:fs/promises')
    report.bindingDiagnostic = { raw: await readFile(join(project, '.git/paperstudio-app.json'), 'utf8'), stats: {} }
    for (const name of ['', '.git', '.git/paperstudio-app.json']) {
      const stat = await lstat(join(project, name))
      report.bindingDiagnostic.stats[name || 'root'] = { dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() }
    }
    report.bindingDiagnostic.reread = await require('../src/main/github/cloud-binding.ts').readCloudBinding(project).catch(error => ({ error: error.message }))
  } catch (diagnostic) { report.bindingDiagnosticError = diagnostic.message }
  try { controller?.dispose(); await collaboration?.cancelAndWait(); await writeFile(process.env.SMOKE_RESULT, JSON.stringify(report, null, 2)) } catch {}
  app.exit(1)
})
