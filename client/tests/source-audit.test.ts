import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const { audit } = createRequire(import.meta.url)('../scripts/audit-source.cjs') as {
  audit(root: string, entries?: string[], retained?: Record<string, string>): {
    ok: boolean; unreachable: string[]; reachable: number; dynamicImports: string[];
    missingEntries: string[]; syntaxErrors: Array<{ file: string; code: number }>
  }
}
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-source-audit-')); roots.push(root)
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, content)
  }
  return root
}

describe('read-only production entrypoint reachability audit', () => {
  it('keeps the actual app free of unexplained source islands', () => {
    expect(audit(resolve('src'))).toMatchObject({ ok: true, unreachable: [], dynamicImports: [], missingEntries: [] })
  })
  it('follows imports, exports and literal dynamic imports but does not use tests as production roots', async () => {
    const root = await fixture({ 'entry.ts': "import './active'; export * from './exports'; void import('./lazy')",
      'active.ts': 'export const active = true', 'exports.ts': 'export const value = 1', 'lazy.ts': 'export {}',
      'test-only.ts': 'export const unused = true', 'ambient.d.ts': 'declare const ambient: number' })
    expect(audit(root, ['entry.ts'], {})).toMatchObject({ ok: false, reachable: 4, unreachable: ['test-only.ts'] })
  })
  it('accepts explicitly justified verification/platform utilities, never an unexplained allowlist value', async () => {
    const root = await fixture({ 'entry.ts': 'export {}', 'policy.ts': 'export const policy = true' })
    expect(audit(root, ['entry.ts'], { 'policy.ts': 'Explicitly maintained platform policy' }).ok).toBe(true)
    expect(audit(root, ['entry.ts'], { 'policy.ts': '' }).ok).toBe(false)
  })
  it('refuses to claim a complete static graph with computed imports or missing entrypoints', async () => {
    const root = await fixture({ 'entry.ts': 'const name = "./x"; void import(name)' })
    expect(audit(root, ['entry.ts'], {})).toMatchObject({ ok: false, dynamicImports: ['entry.ts'] })
    expect(audit(root, ['absent.ts'], {})).toMatchObject({ ok: false, missingEntries: ['absent.ts'] })
  })
  it('reports syntax errors rather than silently approving an unparsed source', async () => {
    const root = await fixture({ 'entry.ts': 'export const =' })
    expect(audit(root, ['entry.ts'], {}).syntaxErrors.length).toBeGreaterThan(0)
  })
})
