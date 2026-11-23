import { describe, expect, it } from 'vitest'
import { CJK_EDITOR_FALLBACK_FONTS, EDITOR_FONT_FAMILY, OVERLEAF_EDITOR_FONTS } from '../src/renderer/editor-font'

const families = (): string[] => EDITOR_FONT_FAMILY.split(',').map(part => part.trim().replace(/^"|"$/g, ''))

describe('source editor font stack', () => {
  it('starts with Overleaf\'s default editor fonts in the same order', () => {
    expect(families().slice(0, 4)).toEqual(['Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas'])
    expect(OVERLEAF_EDITOR_FONTS).toEqual(families().slice(0, 4))
  })

  it('names CJK fonts before the generic monospace so Chinese/Korean do not fall to NSimSun', () => {
    const list = families()
    expect(list.at(-1)).toBe('monospace')
    for (const font of CJK_EDITOR_FALLBACK_FONTS) expect(list.indexOf(font)).toBeLessThan(list.indexOf('monospace'))
    expect(list.indexOf('Microsoft YaHei UI')).toBeGreaterThan(list.indexOf('Consolas'))
  })

  it('drops ui-monospace, which Chromium on Windows does not resolve', () => {
    expect(EDITOR_FONT_FAMILY).not.toContain('ui-monospace')
  })

  it('quotes multi-word family names and leaves single words bare', () => {
    expect(EDITOR_FONT_FAMILY).toContain('"Ubuntu Mono"')
    expect(EDITOR_FONT_FAMILY).toContain('"Microsoft YaHei UI"')
    expect(EDITOR_FONT_FAMILY.startsWith('Monaco, Menlo, ')).toBe(true)
  })
})
