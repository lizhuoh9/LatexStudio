import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractWindowsTexZip } from '../src/main/tex/archive'
import { installationDigest } from '../src/main/tex/catalog'
import { hashFile, TEX_ASSETS } from '../src/main/tex/manifest'

const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_TEX_CATALOG_BUILD === '1'
/** Developer release evidence only. No network, executable launch or permission grants. */
describe.skipIf(!enabled)('generate application catalog from the fixed archive', () => {
  it('re-extracts verified bytes through one handle and hashes the entire install tree', async () => {
    const asset = TEX_ASSETS.win32
    const archive = resolve('release/native-tex-lab/tex/downloads', `${asset.sha256}.zip`)
    expect(await hashFile(archive)).toBe(asset.sha256)
    const base = resolve('release/native-tex-catalog-staging')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'paperstudio-catalog-'))
    try {
      const options: NonNullable<Parameters<typeof extractWindowsTexZip>[2]> & { expectedSha256: string } = { expectedSha256: asset.sha256 }
      await extractWindowsTexZip(archive, join(root, 'install'), options)
      const digest = await installationDigest(join(root, 'install'))
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
      console.info(`PAPERSTUDIO_WINDOWS_INSTALL_TREE_SHA256=${digest}`)
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
  }, 20 * 60_000)
})
