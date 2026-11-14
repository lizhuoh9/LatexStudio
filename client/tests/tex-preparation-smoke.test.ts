import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareNativeTex } from '../src/main/tex/prepare'
import { readManagedManifest } from '../src/main/tex/manifest'

const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_TEX_PREPARATION_SMOKE === '1'
/** Explicitly downloads ~247 MB into a persistent app-owned lab cache; executes NO TeX/install script. */
describe.skipIf(!enabled)('real fixed Windows TeX resource preparation (no executable launch)', () => {
  it('downloads exact bytes/hash, safely extracts, and validates actual relocated layout', async () => {
    const dataRoot = resolve('release/native-tex-lab')
    await mkdir(dataRoot, { recursive: true })
    const result = await prepareNativeTex(dataRoot)
    expect(result.manifest.platform).toBe('win32')
    expect(result.manifest.chineseResources).toBe(false)
    expect(await readManagedManifest(result.root)).toEqual(result.manifest)
  }, 20 * 60_000)
})
