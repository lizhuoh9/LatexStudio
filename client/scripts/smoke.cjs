const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn } = require('node:child_process')

function runElectron(profile, project, phase) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SMOKE_PROFILE: profile, SMOKE_PROJECT: project, SMOKE_PHASE: phase }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [join(__dirname, 'smoke-electron.cjs')], { env, stdio: 'inherit' })
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Workspace smoke exceeded deadline')) }, 240000)
    child.on('error', error => { clearTimeout(deadline); reject(error) })
    child.on('exit', code => {
      clearTimeout(deadline)
      code === 0 ? resolve() : reject(new Error(`Electron workspace smoke exited ${code}`))
    })
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'PaperStudio local smoke '))
  const project = join(root, '论文 project')
  const profile = join(root, 'profile')
  await mkdir(project); await mkdir(profile)
  await writeFile(join(project, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
PaperStudio local compiler smoke.
\end{document}
`)
  await writeFile(join(root, 'outside.txt'), 'SELF-CREATED SENTINEL - NOT USER DATA')
  try {
    await runElectron(profile, project, 'first')
    await runElectron(profile, project, 'restart')
    console.log('PASS real workspace runtime: local IPC/files/CAS/external-edit protection/history/restart')
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
