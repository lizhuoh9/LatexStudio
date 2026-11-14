import { describe, expect, it } from 'vitest'
import { isNetworkProject, isUncPath } from '../src/main/local/network'
import { SafeProject } from '../src/main/local/paths'

const bs = String.fromCharCode(92)
const unc = (...parts: string[]) => bs + bs + parts.join(bs)

describe('local workspace network-root guard', () => {
  it('detects UNC shares without accepting Windows device namespaces as network paths', async () => {
    expect(isUncPath(unc('nas', 'papers', 'thesis'))).toBe(true)
    expect(isUncPath(unc('?', 'C:', 'x'))).toBe(false)
    expect(isUncPath(unc('.', 'pipe', 'x'))).toBe(false)
    expect(isUncPath('C:' + bs + 'papers')).toBe(false)
    expect(await isNetworkProject(unc('nas', 'papers', 'thesis'), 'win32', async () => new Set())).toBe(true)
  })

  it('detects mapped Windows shares without pretending to identify macOS mount types', async () => {
    const drives = async () => new Set(['Z'])
    expect(await isNetworkProject('Z:' + bs + 'thesis', 'win32', drives)).toBe(true)
    expect(await isNetworkProject('C:' + bs + 'thesis', 'win32', drives)).toBe(false)
    expect(await isNetworkProject(unc('nas', 'papers', 'thesis'), 'darwin', drives)).toBe(false)
  })

  it('keeps the low-level path reader strict; the workspace applies the stronger local-root policy', () => {
    expect(() => new SafeProject(unc('nas', 'papers', 'thesis'))).not.toThrow()
    expect(() => new SafeProject(unc('?', 'C:', 'papers'))).toThrow()
    expect(() => new SafeProject(unc('.', 'C:', 'papers'))).toThrow()
    expect(() => new SafeProject(unc('nas', 'papers') + bs)).toThrow('整个网络共享')
  })
})
