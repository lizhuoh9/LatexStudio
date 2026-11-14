import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installationDigest, verifyInstallationCatalog } from '../src/main/tex/catalog'

const roots: string[] = []
async function folder(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'paperstudio-catalog-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(root: string): Promise<void> {
  await mkdir(join(root, 'bin'), { recursive: true })
  await writeFile(join(root, 'bin/engine.exe'), 'fixture engine')
  await writeFile(join(root, 'bin/dependency.dll'), 'fixture DLL')
  await writeFile(join(root, 'texmf.cnf'), 'fixture config')
  await writeFile(join(root, 'pdflatex.fmt'), 'fixture format')
}
describe('application-pinned full resource catalog', () => {
  it('has a deterministic digest independent of installation location', async () => {
    const a = await folder(), b = await folder(); await fixture(a); await fixture(b)
    expect(await installationDigest(a)).toBe(await installationDigest(b))
  })
  it.each(['bin/engine.exe', 'bin/dependency.dll', 'texmf.cnf', 'pdflatex.fmt'])('detects modified %s even if a public manifest is rewritten', async path => {
    const root = await folder(); await fixture(root)
    const before = await installationDigest(root)
    await writeFile(join(root, path), 'changed resource')
    expect(await installationDigest(root)).not.toBe(before)
  })
  it('binds paths, additions and removals, not only engine contents', async () => {
    const root = await folder(); await fixture(root)
    const before = await installationDigest(root)
    await writeFile(join(root, 'extra.dll'), 'injected resource')
    expect(await installationDigest(root)).not.toBe(before)
    await rm(join(root, 'extra.dll')); await rm(join(root, 'pdflatex.fmt'))
    expect(await installationDigest(root)).not.toBe(before)
  })
  it('refuses untrusted trees without accepting a ready flag as authority', async () => {
    const root = await folder(); await fixture(join(root, 'install'))
    await writeFile(join(root, 'paperstudio-runtime.json'), JSON.stringify({ ready: true, assetSha256: 'public value' }))
    await expect(verifyInstallationCatalog(root)).rejects.toThrow('TeX')
  })
  it('honors cancellation before walking or hashing', async () => {
    const root = await folder(); await fixture(root)
    await expect(installationDigest(root, AbortSignal.abort())).rejects.toThrow()
  })
})
