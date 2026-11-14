import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const preload = String.raw`
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (name) => (...args) => ipcRenderer.invoke('editor-fixture', name, ...args)
const names = ['project','openProject','createProject','files','readFile','saveFile','createFile','environment','compile','cancelCompile','repository','connectGitHub','disconnectGitHub','snapshot','sync','history']
const api = Object.fromEntries(names.map((name) => [name, invoke(name)]))
api.setDirty = (dirty) => ipcRenderer.send('editor-dirty', dirty)
api.acknowledgeClose = (requestId, dirty) => ipcRenderer.send('editor-close-ack', requestId, dirty)
api.onEvent = (listener) => { const receive = (_event, value) => listener(value); ipcRenderer.on('editor-event', receive); return () => ipcRenderer.removeListener('editor-event', receive) }
contextBridge.exposeInMainWorld('paperstudio', api)
if (!new URLSearchParams(location.search).has('legacySetup')) contextBridge.exposeInMainWorld('paperstudioSetup', {
  status: () => ipcRenderer.invoke('editor-setup', 'status'), prepare: () => ipcRenderer.invoke('editor-setup', 'prepare'),
  cancel: () => ipcRenderer.invoke('editor-setup', 'cancel'), onState: (listener) => {
    const receive = (_event, state) => listener(state); ipcRenderer.on('editor-setup-state', receive)
    return () => ipcRenderer.removeListener('editor-setup-state', receive)
  }
})
`

const harness = String.raw`
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const assert = require('node:assert/strict')
const root = process.env.EDITOR_FIXTURE
const project = join(root, 'project')
let window, dirty = false, readCalls = 0, setupPrepareCalls = 0
let setupState = { phase: 'prepared', supported: true, compileVerified: false, completed: 1, total: 1, message: 'Synthetic fixture only; not real TeX acceptance' }
app.enableSandbox()
app.setPath('userData', join(root, 'profile'))
const timeout = setTimeout(() => { console.error('Renderer fixture timed out'); app.exit(2) }, 25000)
const revision = (content) => createHash('sha256').update(content).digest('hex')
const read = async (path) => { const content = await fs.readFile(join(project, path), 'utf8'); return { path, content, revision: revision(content) } }
async function info() {
  const files = await Promise.all((await fs.readdir(project)).map(async (path) => ({ path, kind: 'text', size: (await fs.stat(join(project, path))).size })))
  return { id: 'fixture', name: 'Renderer fixture', root: project, files, defaultMain: 'main.tex' }
}
function pdf() {
  const stream = 'BT /F1 12 Tf 20 120 Td (Renderer fixture) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream']
  let body = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n' })
  const start = Buffer.byteLength(body)
  body += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((value) => String(value).padStart(10, '0') + ' 00000 n \n').join('')
  return new Uint8Array(Buffer.from(body + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF'))
}
async function invoke(_event, name, path, content, expected) {
  if (name === 'project' || name === 'openProject') return info()
  if (name === 'files') return (await info()).files
  if (name === 'readFile') { readCalls += 1; return read(path) }
  if (name === 'environment') return { available: true, engines: ['pdflatex'], description: '测试夹具，不代表真实 TeX 安装或编译' }
  if (name === 'createFile') { await fs.writeFile(join(project, path), content, { flag: 'wx' }); return read(path) }
  if (name === 'saveFile') { assert.equal((await read(path)).revision, expected); await fs.writeFile(join(project, path), content); return read(path) }
  if (name === 'compile') return { ok: true, canceled: false, log: 'PDF renderer fixture, not a real compiler', pdf: pdf(), durationMs: 1 }
  if (name === 'repository') return { connection: null, changes: [], conflict: false, message: 'fixture' }
  if (name === 'history') return []
  throw new Error('Unexpected fixture API operation: ' + name)
}
async function until(expression) {
  for (let i = 0; i < 200; i += 1) {
    if (await window.webContents.executeJavaScript(expression)) return
    await new Promise((done) => setTimeout(done, 30))
  }
  throw new Error('Renderer condition failed: ' + expression + '\n' + await window.webContents.executeJavaScript('document.getElementById("status").textContent'))
}
const click = (id) => window.webContents.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').click(); undefined')
async function checkSetup() {
  await until('document.querySelector(".cm-content")?.textContent.includes("original") && document.getElementById("environment").textContent.includes("未接入")')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("compile").disabled'), true)
  await click('setup-open')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("setup-prepare").disabled'), true)
  const url = new URL(window.webContents.getURL()); url.search = ''; await window.loadURL(url.href)
  await until('document.querySelector(".cm-content")?.textContent.includes("original") && document.getElementById("setup-status").textContent.includes("基础资源已准备")')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("compile").disabled'), true)
  await click('cloud-open')
  await until('!document.getElementById("cloud-refresh").disabled')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("developer-sync").open || document.getElementById("github-token").checkVisibility()'), false)
  await click('cloud-close'); await click('setup-open')
  setupState = { ...setupState, phase: 'error' }; window.webContents.send('editor-setup-state', setupState)
  await until('!document.getElementById("setup-prepare").disabled')
  assert.equal(await freeze('fixture-setup-close'), false)
  await click('setup-prepare'); window.webContents.send('editor-setup-state', setupState)
  await new Promise((done) => setTimeout(done, 30)); assert.equal(setupPrepareCalls, 0)
  assert(await window.webContents.executeJavaScript('document.getElementById("setup-dialog").inert && document.getElementById("setup-prepare").disabled'))
  window.webContents.send('editor-event', { kind: 'close-state', closing: false })
  await until('!document.getElementById("setup-dialog").inert && !document.getElementById("setup-prepare").disabled')
  assert.equal(setupPrepareCalls, 0); await click('setup-close')
  setupState = { ...setupState, phase: 'prepared', compileVerified: true }; window.webContents.send('editor-setup-state', setupState)
  await until('!document.getElementById("compile").disabled')
  console.log('PASS renderer setup: legacy fallback, prepared-not-verified gate, hidden developer credentials, closing freeze without auto-prepare')
}
async function check() {
  await until('document.querySelector(".cm-content")?.textContent.includes("original")')
  assert.equal(dirty, false)
  await fs.writeFile(join(project, 'main.tex'), 'external clean version')
  window.webContents.send('editor-event', { kind: 'files-changed', paths: ['main.tex'] })
  await until('document.querySelector(".cm-content").textContent.includes("external clean version")')
  await window.webContents.executeJavaScript('document.querySelector(".cm-content").focus()')
  await window.webContents.insertText(' local draft ')
  await until('document.getElementById("save-state").textContent.includes("未保存")')
  assert.equal(dirty, true)
  await fs.writeFile(join(project, 'main.tex'), 'external changed while dirty')
  window.webContents.send('editor-event', { kind: 'files-changed', paths: ['main.tex'] })
  await until('!document.getElementById("external-warning").hidden')
  assert((await window.webContents.executeJavaScript('document.querySelector(".cm-content").textContent')).includes('local draft'))
  await click('file-copy')
  await until('document.getElementById("input-dialog").open')
  await window.webContents.executeJavaScript('document.getElementById("input-value").value = "draft-copy.tex"; document.querySelector("#input-dialog button[value=accept]").click(); undefined')
  await until('document.getElementById("active-file").textContent === "draft-copy.tex"')
  assert((await read('draft-copy.tex')).content.includes('local draft'))
  assert.equal((await read('main.tex')).content, 'external changed while dirty')
  assert.equal(dirty, false)
  await click('compile')
  await until('Boolean(document.querySelector("#pdf-pages canvas")?.width)')
  assert.match(await window.webContents.executeJavaScript('document.getElementById("pdf-position").textContent'), /1 \/ 1/)
  console.log('PASS real Electron renderer: CodeMirror, clean external reload, dirty preservation/copy, local PDF.js canvas and worker')
}
function freeze(requestId) {
  return new Promise((resolve) => {
    ipcMain.once('editor-close-ack', (_event, id, actualDirty) => { assert.equal(id, requestId); resolve(actualDirty) })
    window.webContents.send('editor-event', { kind: 'close-request', requestId })
  })
}
async function checkClose() {
  assert.equal(await freeze('fixture-clean'), false)
  assert(await window.webContents.executeJavaScript('document.body.inert && [...document.querySelectorAll("dialog")].every(dialog => dialog.inert)'))
  await click('cloud-open')
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("cloud-dialog").open'), false)
  window.webContents.send('editor-event', { kind: 'close-state', closing: false })
  await until('!document.body.inert')
  await window.webContents.executeJavaScript('document.querySelector(".cm-content").focus()')
  await window.webContents.insertText(' unsaved close draft ')
  await until('document.getElementById("save-state").textContent.includes("未保存")')
  await click('cloud-open')
  await until('document.getElementById("cloud-dialog").open && !document.getElementById("cloud-refresh").disabled')
  assert.equal(await freeze('fixture-dirty'), true)
  const before = await window.webContents.executeJavaScript('document.querySelector(".cm-content").textContent')
  await window.webContents.insertText('forbidden while closing')
  await click('cloud-close')
  assert(await window.webContents.executeJavaScript('document.getElementById("cloud-dialog").open && document.getElementById("cloud-dialog").inert'))
  const reads = readCalls
  window.webContents.send('editor-event', { kind: 'files-changed', paths: ['draft-copy.tex'] })
  await new Promise((done) => setTimeout(done, 60)); assert.equal(readCalls, reads)
  window.webContents.send('editor-event', { kind: 'close-state', closing: false })
  await until('!document.body.inert && !document.getElementById("cloud-dialog").inert && !document.getElementById("cloud-refresh").disabled')
  assert(readCalls > reads)
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".cm-content").textContent'), before)
  assert.equal(dirty, true)
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("external-warning").hidden'), true)
  await click('cloud-close')
  console.log('PASS renderer close handshake: clean/dirty ACK, top-layer modal freeze, blocked inputs/actions, cancel thaw and queued self-event')
}
app.whenReady().then(async () => {
  await fs.mkdir(project, { recursive: true }); await fs.writeFile(join(project, 'main.tex'), 'original local document')
  ipcMain.handle('editor-fixture', invoke); ipcMain.on('editor-dirty', (_event, value) => { dirty = value })
  ipcMain.handle('editor-setup', (_event, name) => { if (name === 'prepare') setupPrepareCalls += 1; return setupState })
  window = new BrowserWindow({ width: 1400, height: 900, show: true, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL(pathToFileURL(join(process.env.EDITOR_ROOT, 'out/renderer/index.html')).href + '?legacySetup=1')
  window.show(); window.focus()
  await checkSetup(); await check(); await checkClose(); clearTimeout(timeout); app.exit(0)
}).catch((error) => { console.error(error); clearTimeout(timeout); app.exit(1) })
`

it.skipIf(process.env.PAPERSTUDIO_RENDERER_SMOKE !== '1')('runs the real isolated renderer against local fixture files and PDF bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'paperstudio-editor-'))
  const require = createRequire(import.meta.url)
  const env: NodeJS.ProcessEnv = { ...process.env, EDITOR_FIXTURE: directory, EDITOR_ROOT: resolve('.') }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    await writeFile(join(directory, 'main.cjs'), harness)
    await writeFile(join(directory, 'preload.cjs'), preload)
    const result = await promisify(execFile)(require('electron') as string, [join(directory, 'main.cjs')], { env, timeout: 40000, maxBuffer: 1024 * 1024 })
    expect(result.stdout).toContain('PASS real Electron renderer')
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }) }
}, 50000)
