// Opt-in REAL Windows/Electron/AppContainer test. Never run concurrently with another native preparation.
// Run only after Lead confirms the final build is ready: PAPERSTUDIO_OFFLINE_NATIVE=1 node scripts/smoke-offline.cjs
// All data/report/screenshots stay in a new owned OS Temp directory for review; no automatic deletion.
const assert = require('node:assert/strict')
const fsSync = require('node:fs')
const { mkdtemp, mkdir, writeFile, readFile, lstat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const root = resolve(__dirname, '..')

const papers = {
  'main.tex': String.raw`\documentclass{article}
\usepackage[margin=25mm]{geometry}
\usepackage{amsmath,amssymb,graphicx,booktabs,tikz,enumitem,hyperref}
\hypersetup{colorlinks=true,urlcolor=blue}
\begin{document}
\section{Offline scientific writing}
A real private snapshot, real sandbox, and local PDF: $\mathbb{R}$.
\begin{align} E &= mc^2 \\ \int_0^1 x^2\,dx &= \frac13 \end{align}
\begin{enumerate}[label=(\alph*)]\item Offline packages.\item No network.\end{enumerate}
\begin{tabular}{lr}\toprule Method & Value \\\midrule Local & 42 \\\bottomrule\end{tabular}
\begin{tikzpicture}\draw[blue,thick] (0,0) -- (2,1) -- (3,0);\end{tikzpicture}
\includegraphics[width=20mm]{figure.pdf}
\href{https://example.invalid/offline-not-requested}{A typeset link is not a network request.}
\end{document}
`,
  'bib.tex': String.raw`\documentclass{article}
\begin{document}
An offline citation \cite{offline2026}.
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`,
  'references.bib': String.raw`@article{offline2026,
  author = {Offline, Alice},
  title = {A Real Local Bibliography},
  journal = {Fixture Journal},
  year = {2026},
  volume = {1},
  pages = {1--2}
}
`,
  'zh.tex': String.raw`\documentclass{ctexart}
\usepackage{amsmath}
\begin{document}
\section{离线中文写作验收}
宋体正文，\textbf{黑体加粗}。这是由真正的本地隔离引擎生成的中文论文。
\[ E = mc^2,\qquad \int_0^1 x\,dx = \frac12 \]
\end{document}
`
}

function figurePdf() {
  const stream = '0 0.396 0.624 rg 10 10 80 40 re f\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 60] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`]
  let body = '%PDF-1.4\n', offsets = [0]
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n` }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}`
  return Buffer.from(body + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

async function fixture() {
  const work = await mkdtemp(join(tmpdir(), 'paperstudio-offline-'))
  const owner = randomUUID(), profile = join(work, 'profile'), project = join(work, 'project')
  await mkdir(profile); await mkdir(project)
  await writeFile(join(work, 'fixture-owner'), owner, { flag: 'wx' })
  for (const [name, content] of Object.entries(papers)) await writeFile(join(project, name), content, { flag: 'wx' })
  await writeFile(join(project, 'figure.pdf'), figurePdf(), { flag: 'wx' })
  await assert.rejects(lstat(join(profile, 'tex')), { code: 'ENOENT' })
  const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  const build = { main: await hash(join(root, 'out/main/index.js')), preload: await hash(join(root, 'out/preload/index.js')) }
  await writeFile(join(work, 'launch.json'), JSON.stringify({ work, profile, project, build, startedAt: new Date().toISOString() }, null, 2))
  return { work, profile, project, owner }
}

function observeParent(f) {
  for (const name of ['electron-stdout.log', 'electron-stderr.log']) fsSync.writeFileSync(join(f.work, name), '', { flag: 'wx' })
  const state = { parentPid: process.pid, childPid: null, events: [] }
  const event = (stage, extra = {}) => {
    state.events.push({ stage, at: new Date().toISOString(), ...extra })
    fsSync.writeFileSync(join(f.work, 'parent.json'), JSON.stringify(state, null, 2))
  }
  let logged = 0
  const output = (name, stream) => chunk => {
    if (logged < 8 * 1024 * 1024) { fsSync.appendFileSync(join(f.work, name), chunk); logged += chunk.length }
    try { stream.write(chunk) } catch { /* Persisted output remains authoritative if a supervisor disconnects stdout. */ }
  }
  event('before-spawn')
  return { state, event, output }
}
async function launch(f) {
  const env = { ...process.env, SMOKE_WORK: f.work, SMOKE_PROFILE: f.profile, SMOKE_PROJECT: f.project, SMOKE_TOKEN: f.owner }
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  console.log('OFFLINE_SMOKE_TEMP=' + f.work)
  const audit = observeParent(f)
  const child = spawn(require('electron'), [join(__dirname, 'smoke-offline-electron.cjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  audit.state.childPid = child.pid ?? null; audit.event('spawn-returned')
  child.stdout.on('data', audit.output('electron-stdout.log', process.stdout))
  child.stderr.on('data', audit.output('electron-stderr.log', process.stderr))
  child.once('spawn', () => audit.event('spawn-confirmed'))
  process.once('exit', code => audit.event('parent-exit', { code }))
  await new Promise((done, fail) => {
    let finished = false
    // Native work gets 9 minutes; final minute is ONLY cooperative cancel/close, never a helper kill.
    const stop = setTimeout(() => {
      audit.event('nine-minute-cooperative-stop', { connected: child.connected })
      if (child.connected) child.send({ kind: 'offline-smoke-stop' })
    }, 540000)
    const deadline = setTimeout(() => {
      audit.event('ten-minute-bound-cleanup-unknown', { connected: child.connected })
      finished = true; child.unref(); if (child.connected) child.disconnect()
      fail(new Error('Ten-minute bound reached: cleanup NOT confirmed; fixture and live Electron retained. Never delete it blindly.'))
    }, 600000)
    child.once('error', error => { audit.event('child-error', { message: String(error) }); clearTimeout(stop); clearTimeout(deadline); if (!finished) fail(error) })
    child.once('exit', (code, signal) => {
      audit.event('child-exit', { code, signal })
      clearTimeout(stop); clearTimeout(deadline)
      if (!finished) code === 0 ? done() : fail(new Error(`Offline native smoke exited code=${code}, signal=${signal}; inspect ${join(f.work, 'result.json')}`))
    })
  })
  const report = JSON.parse(await readFile(join(f.work, 'result.json'), 'utf8'))
  assert.equal(report.passed, true); assert.equal(report.safeCloseConfirmed, true)
  console.log('PASS_OFFLINE_NATIVE=' + JSON.stringify({ report: join(f.work, 'result.json'), screenshot: join(f.work, 'offline-current.png') }))
}

async function main() {
  assert.equal(process.env.PAPERSTUDIO_OFFLINE_NATIVE, '1', 'Explicit native opt-in required; wait for Lead build-ready first')
  assert.equal(process.platform, 'win32', 'This acceptance is Windows-native only')
  const f = await fixture()
  try { await launch(f) } finally { console.log('Fixture intentionally retained for Lead review: ' + f.work) }
}
module.exports = { papers, figurePdf }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
