import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWindowsSandboxSession } from '../src/main/sandbox/windows'
import { createBuild, removeBuild } from '../src/main/local/build'
import { findPreparedTex } from '../src/main/tex/prepare'
import { hashFile } from '../src/main/tex/manifest'

// Opt-in benchmark of the real helper: session start (to ready), one trivial engine run, dispose. Used as the
// before/after control for helper ACL changes; it compiles nothing and grants nothing beyond a normal session.
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_SANDBOX_TIMING === '1'
const ROUNDS = 3

describe.skipIf(!enabled)('Windows sandbox session timing', () => {
  it('measures ready, run and dispose for a trivial engine call', async () => {
    const data = resolve('release/native-tex-lab')
    const prepared = await findPreparedTex(join(data, 'tex/runtimes'), 'win32')
    if (!prepared) throw new Error('Prepare the lab runtime first')
    const project = join(data, 'fixture-project')
    await mkdir(project, { recursive: true })
    const rounds: Array<{ readyMs: number; runMs: number; disposeMs: number; code: number }> = []
    for (let round = 0; round < ROUNDS; round++) {
      const build = await createBuild(project, join(data, 'builds'))
      const source = join(build, 'source'), probe = join(build, 'probe')
      await mkdir(source); await mkdir(probe)
      try {
        let started = performance.now()
        const session = await createWindowsSandboxSession({ executable: join(prepared.root, prepared.manifest.engines.pdflatex),
          runtimeRoot: prepared.root, workDirs: [source, probe], timeoutMs: 120000 })
        const readyMs = performance.now() - started
        started = performance.now()
        const result = await session.run(['--version'], source)
        const runMs = performance.now() - started
        started = performance.now()
        await session.dispose()
        rounds.push({ readyMs: Math.round(readyMs), runMs: Math.round(runMs), disposeMs: Math.round(performance.now() - started), code: result.code })
      } finally { await removeBuild(build) }
    }
    const helper = await hashFile(resolve('resources/win32/PaperStudio.Sandbox.exe'))
    console.info(`PAPERSTUDIO_SANDBOX_TIMING=${JSON.stringify({ helper, rounds })}`)
    for (const round of rounds) expect(round.code).toBe(0)
  }, 600_000)
})
