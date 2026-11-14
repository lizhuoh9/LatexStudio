import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPreparedTex } from '../src/main/tex/prepare'
import { auditChineseBase } from '../src/main/tex/base-metadata'
const enabled = process.platform === 'win32' && process.env.PAPERSTUDIO_TEX_CHINESE_BASE_AUDIT === '1'
/** Explicit developer inspection of already authenticated bytes; no engine/network/ACL or asset execution. */
describe.skipIf(!enabled)('fixed Windows Chinese base metadata', () => {
  it('records bounded source hints, never format or Chinese execution acceptance', async () => {
    const prepared = await findPreparedTex(resolve('release/native-tex-lab/tex/runtimes'), 'win32')
    expect(prepared).not.toBeNull()
    if (!prepared) throw new Error('Missing fixed, catalog-verified lab runtime')
    const result = await auditChineseBase(join(prepared.root, 'install'))
    console.info(`PAPERSTUDIO_FIXED_CHINESE_BASE_METADATA=${JSON.stringify(result)}`)
    expect(result.formatCompatibilityVerified).toBe(false)
    expect(result.chineseCompilationVerified).toBe(false)
    expect(prepared.manifest.chineseResources).toBe(false)
  }, 120000)
})
