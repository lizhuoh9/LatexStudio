import { describe, expect, it } from 'vitest'
import { requireCompile, requireSettings, requireText, safeOperationError } from '../src/main/workspace/validation'

describe('trusted workspace payload validation', () => {
  it('accepts only bounded strings without NUL', () => {
    expect(requireText('main.tex', '文件')).toBe('main.tex')
    for (const value of [undefined, null, 1, {}, '', 'a\0b', 'x'.repeat(4097)]) {
      expect(() => requireText(value, '文件')).toThrow('格式不正确')
    }
  })

  it('requires an explicit supported engine', () => {
    expect(requireCompile({ mainFile: 'main.tex', engine: 'pdflatex' }))
      .toEqual({ mainFile: 'main.tex', engine: 'pdflatex' })
    for (const value of [null, [], 'main.tex', { mainFile: 'main.tex', engine: 'shell' }]) {
      expect(() => requireCompile(value)).toThrow()
    }
  })

  it('never allows header whitespace in authorization input', () => {
    for (const token of ['', 'a b', 'a\rb', 'a\nb', 'a\tb']) {
      expect(() => requireSettings({ url: 'https://github.com/example/paper', token })).toThrow()
    }
    expect(() => requireSettings(null)).toThrow()
    expect(() => requireSettings([])).toThrow()
  })

  it('copies only expected credential fields', () => {
    const result = requireSettings({ url: 'https://github.com/example/paper', token: 'fixture-value', admin: true })
    expect(result).toEqual({ url: 'https://github.com/example/paper', token: 'fixture-value' })
  })

  it('redacts supplied secrets and URL credentials from errors', () => {
    const error = safeOperationError(new Error('fixture-value https://name:fixture-value@github.com/example/paper'), ['fixture-value'])
    expect(error.message).not.toContain('fixture-value')
    expect(error.message).not.toContain('name:')
    expect(error.message).toContain('[已隐藏]')
  })

  it('bounds opaque errors without serializing arbitrary request objects', () => {
    expect(safeOperationError({ private: 'do-not-serialize' }).message).toBe('操作未完成，请重试。')
    expect(safeOperationError(new Error('x'.repeat(3000))).message).toHaveLength(1200)
  })
})
