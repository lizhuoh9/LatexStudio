'use strict'
// Developer tool for real-Mac acceptance (docs/MACOS-COMPILE-PLAN.md, phase 0). Talks protocol 1 to the compile helper
// directly, without the app, so individual questions can be answered one at a time. Never part of the product.
//
//   node scripts/mac-helper-driver.cjs probe <helper> <tex-install-dir> <kind>:<path-or-port> ...
//   node scripts/mac-helper-driver.cjs hang  <helper> <tex-install-dir>
//
// `probe` prints one JSON line with the READY facts and every probe verdict, then closes the session.
// `hang` starts an endless pdfTeX run, prints "PGID <n>" and waits: kill this process to test that the helper
// notices its parent is gone and kills the tool.
const { spawn } = require('node:child_process')

function connect(helper, texRoot) {
  const child = spawn(helper, ['--tex-root', texRoot, '--timeout-ms', '120000'], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: '/usr/bin:/bin' } })
  let buffered = Buffer.alloc(0), waiter = null
  const frames = []
  function parse() {
    for (;;) {
      const end = buffered.indexOf(0x0a)
      if (end < 0) return
      const parts = buffered.subarray(0, end).toString('latin1').split(' ')
      const size = parts[0] === 'READY' ? Number(parts[3]) : parts[0] === 'OUT' ? Number(parts[2]) : parts[0] === 'FILE' ? Number(parts[1]) : 0
      if (buffered.length < end + 1 + size) return
      const frame = { name: parts[0], fields: parts.slice(1), payload: buffered.subarray(end + 1, end + 1 + size) }
      buffered = buffered.subarray(end + 1 + size)
      if (waiter) { const resolve = waiter; waiter = null; resolve(frame) } else frames.push(frame)
    }
  }
  child.stdout.on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); parse() })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    if (waiter) { const resolve2 = waiter; waiter = null; resolve2({ name: 'GONE', fields: [String(code), String(signal)], payload: Buffer.alloc(0) }) }
    resolve({ code, signal })
  }))
  const next = (timeoutMs = 20000) => frames.length ? Promise.resolve(frames.shift()) : new Promise(resolve => {
    const timer = setTimeout(() => { waiter = null; resolve({ name: 'TIMEOUT', fields: [], payload: Buffer.alloc(0) }) }, timeoutMs)
    waiter = frame => { clearTimeout(timer); resolve(frame) }
  })
  const send = (header, ...payload) => child.stdin.write(Buffer.concat([Buffer.from(header + '\n'), ...payload]))
  return { child, next, send, exited }
}

async function ready(session) {
  const frame = await session.next()
  if (frame.name !== 'READY') return { ready: false, got: frame.name, fields: frame.fields }
  return { ready: true, protocol: Number(frame.fields[0]), sandboxed: frame.fields[1] === '1', root: frame.payload.toString('utf8') }
}

async function probe(helper, texRoot, requests) {
  const session = connect(helper, texRoot), report = { helper, texRoot, ...(await ready(session)), probes: [] }
  if (report.ready) {
    for (const request of requests) {
      const split = request.indexOf(':'), kind = request.slice(0, split), argument = Buffer.from(request.slice(split + 1))
      session.send(`PROBE ${kind} ${argument.length}`, argument)
      const frame = await session.next()
      report.probes.push({ kind, argument: argument.toString(), verdict: frame.name === 'PROBE' ? frame.fields[0] : frame.name, errno: Number(frame.fields[1] ?? -1) })
      if (frame.name !== 'PROBE') break
    }
    session.send('CLOSE')
    const closed = await session.next()
    report.closed = closed.name === 'CLOSED' ? closed.fields[0] === '1' : closed.name
  } else session.child.kill('SIGKILL')
  report.exit = await session.exited
  console.log(JSON.stringify(report))
}

async function hang(helper, texRoot) {
  const session = connect(helper, texRoot), state = await ready(session)
  if (!state.ready || !state.sandboxed) { console.log(JSON.stringify(state)); session.child.kill('SIGKILL'); process.exitCode = 1; return }
  const name = Buffer.from('loop.tex'), body = Buffer.from('\\def\\x{\\x}\\x\n')
  session.send(`PUT ${name.length} ${body.length}`, name, body)
  if ((await session.next()).name !== 'OK') { process.exitCode = 1; return }
  const args = Buffer.from(['-no-shell-escape', '-progname=pdflatex', '-fmt=pdflatex', '-interaction=nonstopmode',
    '-jobname=paperstudio', '-output-directory=./.paperstudio-output', './loop.tex'].map(arg => arg + '\0').join(''))
  session.send(`RUN pdflatex ${args.length}`, args)
  const started = await session.next()
  console.log(started.name === 'STARTED' ? `PGID ${started.fields[0]}` : `NOT-STARTED ${started.name} ${started.fields.join(' ')}`)
  setInterval(() => undefined, 1000) // stay alive until killed from outside
}

const [mode, helper, texRoot, ...rest] = process.argv.slice(2)
if (process.platform !== 'darwin' || !helper || !texRoot || !['probe', 'hang'].includes(mode)) {
  console.error('Usage (macOS only): mac-helper-driver.cjs probe|hang <helper> <tex-install-dir> [kind:argument ...]')
  process.exitCode = 64
} else (mode === 'probe' ? probe(helper, texRoot, rest) : hang(helper, texRoot)).catch(error => { console.error(error.message); process.exitCode = 1 })
