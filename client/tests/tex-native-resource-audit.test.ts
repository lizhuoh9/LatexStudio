import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPreparedTex } from '../src/main/tex/prepare'
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_MANAGED_TEX_RESOURCE_AUDIT === '1'
const candidates = {
  ctex: 'tex/latex/ctex/ctexart.cls',
  xeCJK: 'tex/xelatex/xecjk/xeCJK.sty',
  zhnumber: 'tex/latex/zhnumber/zhnumber.sty',
  Fandol: 'fonts/opentype/public/fandol/FandolSong-Regular.otf'
}
/** Static known-TDS checks only: presence is NOT a complete dependency or executable acceptance proof. */
describe.skipIf(!enabled)('fixed managed resource package audit', () => {
  it('records Chinese candidate files without executing tools or exposing resource paths', async () => {
    const prepared = await findPreparedTex(resolve('release/native-tex-lab/tex/runtimes'), 'win32')
    expect(prepared).not.toBeNull()
    if (!prepared) throw new Error('Prepare the fixed, catalog-verified resource first')
    const result: Record<string, boolean> = {}
    for (const [name, path] of Object.entries(candidates)) {
      try {
        const info = await lstat(join(prepared.root, 'install/texmf-dist', path))
        result[name] = info.isFile() && !info.isSymbolicLink() && info.size > 0
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Static candidate inspection failed')
        result[name] = false
      }
    }
    console.info(`PAPERSTUDIO_FIXED_TDS_CHINESE_CANDIDATES=${JSON.stringify(result)}`)
    expect(prepared.manifest.chineseResources).toBe(false)
  }, 120000)
})
