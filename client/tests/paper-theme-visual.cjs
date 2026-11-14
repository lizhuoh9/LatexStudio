// Opt-in static renderer visual acceptance: no preload, production JS, network or user project.
// Run with `node tests/paper-theme-visual.cjs`. Screenshots are layout evidence, not account/compile proof.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { spawn } = require('node:child_process')
const root = resolve(__dirname, '..')
const output = join(root, 'release')
const resultPath = join(__dirname, 'paper-theme-visual-result.json')
const settle = () => new Promise(resolve => setTimeout(resolve, 80))

async function staticPage(report) {
  let html = await fs.readFile(join(root, 'src/renderer/index.html'), 'utf8')
  report.hashes['index.html'] = createHash('sha256').update(html).digest('hex')
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  let styles = ''
  for (const file of ['style.css', 'setup-style.css', 'collaboration-style.css', 'repository-transfer-style.css']) {
    const source = await fs.readFile(join(root, 'src/renderer', file), 'utf8')
    report.hashes[file] = createHash('sha256').update(source).digest('hex'); styles += source + '\n'
  }
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</head>', `<style>${styles}</style></head>`))
}
async function captureSizes(window, report) {
  for (const [name, width, height] of [['desktop', 1440, 950], ['compact', 1000, 680], ['narrow', 740, 1000]]) {
    window.setContentSize(width, height)
    // rAF can stop when a test window is covered; native timer + geometry reads do not wait on its visibility.
    await settle()
    const metrics = await window.webContents.executeJavaScript(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height } };
      return { width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
        editor:rect('#source-editor'), preview:rect('.preview-panel'), sidebar:rect('.files-panel'),
        topbar:rect('.topbar'), toolbar:rect('.toolbar'),
        save:rect('#file-save'), saveState:rect('#save-state'), editorHeading:rect('#editor-panel > .panel-heading'),
        saveInEditor:!!document.querySelector('#editor-panel .editor-heading-actions #file-save'),
        saveInToolbar:!!document.querySelector('.toolbar #file-save'),
        hiddenWarning:getComputedStyle(document.querySelector('#external-warning')).display,
        cancelCompileDisabled:document.querySelector('#cancel-compile').disabled,
        sidebarBackground:getComputedStyle(document.querySelector('.files-panel')).backgroundColor,
        paperBackground:getComputedStyle(document.querySelector('#editor-panel')).backgroundColor,
        brandFont:getComputedStyle(document.querySelector('.brand strong')).fontFamily,
        emptyFont:getComputedStyle(document.querySelector('.editor-empty strong')).fontFamily,
        illustrationTransform:getComputedStyle(document.querySelector('.paper-illustration')).transform,
        themeColors:['.brand-mark','.environment','.files-panel','#editor-panel','.preview-panel',
          '.preview-panel .panel-heading','#project-open','#compile','#cloud-open','.statusbar',
          '.collaboration-state','.collaboration-card','.repository-transfer'].map(selector=>{
            const style=getComputedStyle(document.querySelector(selector));
            return {selector,color:style.color,background:style.backgroundColor}; }),
        controls:[...document.querySelectorAll('.project-navigation button,.toolbar button,.topbar button,.editor-heading-actions button')].map(e=>({id:e.id,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})) };
    })()`)
    assert(metrics.scrollWidth <= metrics.width, `${name}: horizontal page overflow`)
    assert.equal(metrics.topbar.height, 42); assert.equal(metrics.toolbar.height, 34)
    assert.equal(metrics.sidebar.y, 76); assert.equal(metrics.editor.y, 110)
    if (name !== 'narrow') assert.equal(metrics.preview.y, 76)
    assert(metrics.editor.width >= 200 && metrics.editor.height >= 120, `${name}: editor squeezed away`)
    assert(metrics.preview.width >= 200 && metrics.preview.height >= 150, `${name}: preview squeezed away`)
    assert.equal(metrics.hiddenWarning, 'none'); assert.equal(metrics.cancelCompileDisabled, true)
    assert(!/Georgia|SimSun|Songti|Times New Roman/.test(metrics.brandFont + metrics.emptyFont))
    assert.equal(metrics.illustrationTransform, 'none')
    assert.equal(metrics.saveInEditor, true); assert.equal(metrics.saveInToolbar, false)
    assert(metrics.save.x >= metrics.saveState.x + metrics.saveState.width + 8, `${name}: save/status overlap`)
    assert(Math.abs(metrics.save.y + metrics.save.height / 2 - metrics.saveState.y - metrics.saveState.height / 2) < 1)
    assert(metrics.save.x + metrics.save.width <= metrics.editorHeading.x + metrics.editorHeading.width - 8)
    const color = selector => metrics.themeColors.find(sample => sample.selector === selector)
    assert.equal(color('#compile').background, 'rgb(0, 101, 159)')
    assert.equal(color('#project-open').background, 'rgb(234, 244, 251)')
    assert.equal(color('.environment').background, 'rgba(0, 0, 0, 0)')
    for (const control of metrics.controls) assert(control.left >= 0 && control.right <= metrics.width, `${name}: clipped ${control.id}`)
    report.sizes.push({ name, ...metrics }); await fs.writeFile(join(output, `paper-theme-${name}.png`), (await window.webContents.capturePage()).toPNG())
    await captureCompileOptions(window, report, name)
  }
}
async function captureCompileOptions(window, report, name) {
  const metrics = await window.webContents.executeJavaScript(`(() => {
    const details=document.querySelector('.advanced-compile'), summary=details.querySelector('summary');
    const permission=()=>JSON.stringify([...document.querySelectorAll('[data-lock],#cancel-compile')].map(e=>[e.id,e.disabled]));
    const before=permission(); summary.click();
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const panel=details.querySelector('.advanced-fields'), selects=[...panel.querySelectorAll('select')];
    const fields=selects.map(e=>{e.focus();const r=rect(e);return {id:e.id,...r,focused:document.activeElement===e,
      hit:document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)===e,disabled:e.disabled,
      label:e.closest('label').textContent.trim(),options:e.options.length}});
    const ancestors=[];for(let e=panel.parentElement;e;e=e.parentElement){const s=getComputedStyle(e);
      ancestors.push({name:e.className||e.tagName,x:s.overflowX,y:s.overflowY})}
    const group=document.querySelector('.toolbar-actions'), cloud=document.querySelector('#cloud-open');
    return {open:details.open,panel:rect(panel),summary:rect(summary),sidebar:rect(document.querySelector('.files-panel')),
      group:rect(group),cloud:rect(cloud),toolbar:rect(document.querySelector('.toolbar')),fields,ancestors,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      background:getComputedStyle(panel).backgroundColor,shadow:getComputedStyle(panel).boxShadow,
      cloudLast:group.lastElementChild===cloud,cloudInTopbar:!!document.querySelector('.topbar #cloud-open'),
      compileDisabled:document.querySelector('#compile').disabled,permissionsUnchanged:before===permission()};
  })()`)
  report.options.push({ name, ...metrics }); assertCompileOptions(metrics, name)
  await settle() // Geometry is synchronous, but offscreen painting needs a frame before capture.
  await fs.writeFile(join(output, `paper-theme-options-${name}.png`), (await window.webContents.capturePage()).toPNG())
  await window.webContents.executeJavaScript('document.querySelector(".advanced-compile > summary").click(); document.activeElement.blur()')
}
function assertCompileOptions(metrics, name) {
  assert.equal(metrics.open, true); assert.equal(metrics.cloudLast, true); assert.equal(metrics.cloudInTopbar, false)
  assert.equal(metrics.compileDisabled, true); assert.equal(metrics.permissionsUnchanged, true)
  assert(metrics.scrollWidth <= metrics.width, `${name}: open options overflow`)
  assert(Math.abs(metrics.panel.right - metrics.summary.right) < 1, `${name}: popup not anchored right`)
  assert(Math.abs(metrics.panel.top - metrics.summary.bottom - 8) < 1, `${name}: popup vertical offset`)
  assert(metrics.panel.left >= metrics.sidebar.right, `${name}: popup covers file tree`)
  assert(metrics.panel.right <= metrics.width - 8 && metrics.panel.left >= 8, `${name}: popup outside viewport`)
  assert.equal(metrics.background, 'rgb(255, 255, 255)'); assert.notEqual(metrics.shadow, 'none')
  assert.equal(metrics.fields.length, 2)
  assert(Math.abs(metrics.fields[0].width - metrics.fields[1].width) < 1, `${name}: main-file select squeezed`)
  for (const field of metrics.fields) {
    assert(field.focused && field.hit && field.options > 0, `${name}: select inaccessible: ${field.id}`)
    assert(field.label.includes(field.id === 'engine' ? '引擎' : '主文件'))
    assert(field.left >= metrics.panel.left + 8 && field.right <= metrics.panel.right - 8)
    assert(field.top >= metrics.panel.top + 8 && field.bottom <= metrics.panel.bottom - 8)
  }
  for (const ancestor of metrics.ancestors) assert(ancestor.x === 'visible' && ancestor.y === 'visible', `${name}: clipping ancestor ${ancestor.name}`)
  assert(metrics.cloud.right >= metrics.toolbar.right - 12 && metrics.group.right <= metrics.toolbar.right - 8)
}
async function checkInlineStates(window, report) {
  window.setContentSize(1000, 680)
  await settle()
  report.inlineStates = await window.webContents.executeJavaScript(`(() => {
    const notice=document.querySelector('#environment-summary'), name=document.querySelector('#project-name');
    const original=name.textContent, y=()=>document.querySelector('.workspace').getBoundingClientRect().y;
    notice.hidden=true; const readyY=y(); notice.hidden=false; notice.classList.add('missing');
    const errorY=y(); notice.classList.remove('missing');
    name.textContent='A long project title '.repeat(12); document.querySelector('#project-root').title='C:/fixture/paper';
    const longTitleY=y(), longScrollWidth=document.documentElement.scrollWidth, overflow=longScrollWidth>innerWidth;
    const titleBounds=[...document.querySelectorAll('.topbar,.project-heading,#project-name')].map(e=>({tag:e.id||e.className,
      width:e.getBoundingClientRect().width,minWidth:getComputedStyle(e).minWidth,flex:getComputedStyle(e).flex}));
    name.textContent=original;
    return {fixturesOnly:true,readyY,errorY,longTitleY,overflow,width:innerWidth,longScrollWidth,titleBounds,
      compileDisabled:document.querySelector('#compile').disabled};
  })()`)
  assert.equal(report.inlineStates.readyY, 76); assert.equal(report.inlineStates.errorY, 76)
  assert.equal(report.inlineStates.longTitleY, 76); assert.equal(report.inlineStates.overflow, false)
  assert.equal(report.inlineStates.compileDisabled, true, 'presentation changes must not grant compilation')
}
async function captureDialog(window, report) {
  window.setContentSize(1440, 950)
  await window.webContents.executeJavaScript('document.querySelector("#cloud-dialog").showModal()')
  await settle()
  report.dialog = await window.webContents.executeJavaScript(`(() => { const d=document.querySelector('#cloud-dialog');
    return { width:d.clientWidth,scrollWidth:d.scrollWidth,open:d.open,
      hiddenAuthorization:getComputedStyle(document.querySelector('#collaboration-authorization')).display,
      loginDisabled:document.querySelector('#collaboration-login').disabled }; })()`)
  assert.equal(report.dialog.open, true); assert.equal(report.dialog.hiddenAuthorization, 'none')
  assert.equal(report.dialog.loginDisabled, true); assert(report.dialog.scrollWidth <= report.dialog.width)
  await fs.writeFile(join(output, 'paper-theme-collaboration.png'), (await window.webContents.capturePage()).toPNG())
}
async function captureComponents(window, report) {
  await window.webContents.executeJavaScript('document.querySelector("#cloud-dialog").close(); document.querySelector("#setup-dialog").showModal()')
  await settle()
  report.components = await window.webContents.executeJavaScript(`(() => { const d=document.querySelector('#setup-dialog');
    return { width:d.clientWidth,scrollWidth:d.scrollWidth,title:document.querySelector('#setup-title').textContent,
      retryHidden:document.querySelector('#setup-prepare').hidden,cancelHidden:document.querySelector('#setup-cancel').hidden }; })()`)
  assert.equal(report.components.title, '编译组件'); assert(report.components.scrollWidth <= report.components.width)
  assert.equal(report.components.retryHidden, true); assert.equal(report.components.cancelHidden, true)
  await fs.writeFile(join(output, 'paper-theme-components.png'), (await window.webContents.capturePage()).toPNG())
}
async function runElectron() {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.env.PAPER_THEME_PROFILE)
  app.disableHardwareAcceleration()
  await app.whenReady()
  const timer = setTimeout(() => app.exit(2), 30000)
  const window = new BrowserWindow({ width: 1440, height: 950, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, offscreen: true } })
  const report = { ok: false, scope: 'Scientific blue/orange accent static source HTML/CSS in sandboxed offscreen development Electron; software-rendered, no preload or application logic',
    notValidated: ['production editor/PDF interaction', 'dynamic CloudProjectPanel', 'GitHub accounts or collaboration', 'TeX compilation', 'installed app'], sizes: [], options: [], hashes: {} }
  try {
    await window.loadURL(await staticPage(report)); await captureSizes(window, report)
    await checkInlineStates(window, report); await captureDialog(window, report); await captureComponents(window, report)
    report.ok = true
  } catch (error) { report.error = error.stack || error.message }
  finally {
    await fs.writeFile(resultPath, JSON.stringify(report, null, 2) + '\n'); clearTimeout(timer)
    window.destroy(); app.exit(report.ok ? 0 : 1)
  }
}
async function launch() {
  const work = await fs.mkdtemp(join(tmpdir(), 'paperstudio-theme-visual-'))
  assert.equal(dirname(work), tmpdir()); assert(basename(work).startsWith('paperstudio-theme-visual-'))
  await fs.mkdir(output, { recursive: true })
  try {
    const env = { ...process.env, PAPER_THEME_PROFILE: join(work, 'profile') }
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.ELECTRON_RENDERER_URL
    const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit' })
    const code = await new Promise((done, fail) => { child.once('close', done); child.once('error', fail) })
    const report = JSON.parse(await fs.readFile(resultPath, 'utf8'))
    console.log(JSON.stringify({ ok: report.ok, error: report.error, scope: report.scope,
      sizes: report.sizes.map(({ name, topbar, toolbar, editor, sidebar }) => ({ name, topbar: topbar.height,
        toolbar: toolbar.height, workspaceY: sidebar.y, editorY: editor.y })), options: report.options.map(({name,panel,summary,fields})=>({name,panel,summary,focusable:fields.every(field=>field.focused&&field.hit)})), inlineStates: report.inlineStates, components: report.components }))
    assert.equal(code, 0, 'Static visual Electron failed')
  } finally { await fs.rm(work, { recursive: true, force: false }) }
}
if (process.versions.electron) runElectron().catch(error => { console.error(error); require('electron').app.exit(1) })
else launch().catch(error => { console.error(error); process.exitCode = 1 })
