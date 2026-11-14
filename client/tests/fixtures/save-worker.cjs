const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Execute the actual TypeScript production modules in independent Node processes, no Electron/TeX.
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file)
const { ProjectService } = require(path.join(__dirname, '../../src/main/local/project.ts'))
const root = process.argv[2], content = process.argv[3], hold = process.argv[4] === 'hold'
let service, revision
function waitFor(kind) {
  return new Promise(resolve => {
    const listener = message => { if (message?.kind === kind) { process.off('message', listener); resolve() } }
    process.on('message', listener)
  })
}
async function run() {
  const proceed = hold ? waitFor('release') : null
  service = new ProjectService(root, { beforeWrite: async () => {
    process.send({ kind: 'prepared' })
    if (proceed) await proceed
  } })
  await service.initialize()
  revision = (await service.read('main.tex')).revision
  const start = waitFor('start')
  process.send({ kind: 'ready' })
  await start
  try {
    const saved = await service.save('main.tex', content, revision)
    process.send({ kind: 'result', ok: true, content: saved.content })
  } catch (error) { process.send({ kind: 'result', ok: false, message: error.message }) }
  finally { service.dispose(); process.disconnect() }
}
run().catch(error => {
  process.send?.({ kind: 'fatal', message: error.message })
  service?.dispose()
  process.exitCode = 1
  process.disconnect?.()
})
