import { describe, expect, it } from 'vitest'
import { isTrustedSettingsSender } from '../src/main/url-policy'

describe('privileged IPC sender policy', () => {
  const trusted = 'file:///C:/app/out/renderer/index.html'
  it('accepts only the exact local window, URL and main frame', () => {
    expect(isTrustedSettingsSender(4, 4, true, trusted, trusted)).toBe(true)
    expect(isTrustedSettingsSender(5, 4, true, trusted, trusted)).toBe(false)
    expect(isTrustedSettingsSender(4, 4, false, trusted, trusted)).toBe(false)
    expect(isTrustedSettingsSender(4, 4, true, 'https://nas.example', trusted)).toBe(false)
    expect(isTrustedSettingsSender(4, 4, true, `${trusted}?spoof=1`, trusted)).toBe(false)
  })
})
