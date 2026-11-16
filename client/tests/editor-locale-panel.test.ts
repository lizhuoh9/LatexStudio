import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreferencesApi, PreferencesState } from '../src/shared/locale-contracts'
import { getLocale, setLocale, type UiLocale } from '../src/shared/i18n'
import { initializeLocalePreference, LocalePanel } from '../src/renderer/locale-panel'

class Control {
  value = ''; disabled = false; hidden = false; open = false; textContent = ''
  listeners = new Map<string, () => void>()
  addEventListener(name: string, listener: () => void): void { this.listeners.set(name, listener) }
  removeEventListener(name: string): void { this.listeners.delete(name) }
  emit(name: string): void { this.listeners.get(name)?.() }
  showModal(): void { this.open = true }
  close(): void { this.open = false }
}
const state = vi.hoisted(() => ({ nodes: new Map<string, Control>() }))
vi.mock('../src/renderer/dom', () => ({
  element: (id: string) => { if (!state.nodes.has(id)) state.nodes.set(id, new Control()); return state.nodes.get(id)! },
  text: (id: string, value: string) => { if (!state.nodes.has(id)) state.nodes.set(id, new Control()); state.nodes.get(id)!.textContent = value },
  button: (id: string, action: () => void) => { if (!state.nodes.has(id)) state.nodes.set(id, new Control()); state.nodes.get(id)!.addEventListener('click', action) }
}))
const field = (id: string): Control => state.nodes.get(id)!
const flush = async (): Promise<void> => { for (let n = 0; n < 12; n++) await Promise.resolve() }
let panel: LocalePanel | undefined
beforeEach(() => { setLocale('zh-CN'); state.nodes.clear(); vi.stubGlobal('window', {}) })
afterEach(() => { panel?.dispose(); panel = undefined; setLocale('zh-CN'); vi.unstubAllGlobals() })
function fixture(save: (locale: UiLocale) => Promise<PreferencesState> = async locale => ({ locale })) {
  let changed: ((value: PreferencesState) => void) | undefined
  const unsubscribe = vi.fn()
  const api: PreferencesApi = { get: vi.fn(async () => ({ locale: 'zh-CN' as const })), set: vi.fn(save),
    onChanged: listener => { changed = listener; return unsubscribe } }
  panel = new LocalePanel(api)
  return { api, unsubscribe, changed: (locale: UiLocale) => changed?.({ locale }) }
}

describe('interface language preference UI', () => {
  it('loads a valid choice before startup but leaves Chinese on missing/failed/invalid bridge', async () => {
    await initializeLocalePreference(undefined); expect(getLocale()).toBe('zh-CN')
    const good = fixture(); vi.mocked(good.api.get).mockResolvedValue({ locale: 'ko' })
    await initializeLocalePreference(good.api); expect(getLocale()).toBe('ko')
    setLocale('zh-CN'); vi.mocked(good.api.get).mockRejectedValue(new Error('private path must not be surfaced'))
    await initializeLocalePreference(good.api); expect(getLocale()).toBe('zh-CN')
    vi.mocked(good.api.get).mockResolvedValue({ locale: '../en' } as unknown as PreferencesState)
    await initializeLocalePreference(good.api); expect(getLocale()).toBe('zh-CN')
  })
  it('waits for durable acknowledgement, coalesces extra clicks and changes no account/project API', async () => {
    let resolve!: (state: PreferencesState) => void
    const pending = new Promise<PreferencesState>(done => { resolve = done })
    const saved = fixture(() => pending)
    field('language-select').value = 'en'; field('language-select').emit('change')
    expect(getLocale()).toBe('zh-CN'); expect(field('language-select').disabled).toBe(true)
    field('language-select').emit('change'); expect(saved.api.set).toHaveBeenCalledTimes(1)
    resolve({ locale: 'en' }); await flush()
    expect(getLocale()).toBe('en'); expect(field('language-select').disabled).toBe(false)
    expect(saved.api.get).not.toHaveBeenCalled()
  })
  it('keeps the last saved language on failure and shows only a fixed safe message', async () => {
    fixture(async () => { throw new Error('private-path CANARY_CREDENTIAL') })
    field('language-select').value = 'ko'; field('language-select').emit('change'); await flush()
    expect(getLocale()).toBe('zh-CN'); expect(field('language-select').value).toBe('zh-CN')
    expect(field('language-status').textContent).toBe('无法保存语言设置，请重试。')
    expect(field('language-status').textContent).not.toMatch(/CANARY|private-path/)
  })
  it('rejects unsupported values without dispatch and responds to trusted change events', async () => {
    const saved = fixture(); field('language-select').value = '../../ko'; field('language-select').emit('change')
    expect(saved.api.set).not.toHaveBeenCalled(); saved.changed('ko')
    expect(getLocale()).toBe('ko'); expect(field('language-select').value).toBe('ko')
  })
  it('freezes during close, applies admitted preference after canceled close, ignores late dispose', async () => {
    let resolve!: (state: PreferencesState) => void
    const saved = fixture(() => new Promise(done => { resolve = done }))
    field('language-select').value = 'en'; field('language-select').emit('change'); panel!.setClosing(true)
    resolve({ locale: 'en' }); await flush(); expect(getLocale()).toBe('zh-CN'); expect(field('language-select').disabled).toBe(true)
    panel!.setClosing(false); expect(getLocale()).toBe('en')
    panel!.dispose(); saved.changed('ko'); expect(getLocale()).toBe('en'); expect(saved.unsubscribe).toHaveBeenCalledOnce()
  })
  it('allows memory-only fallback only when the optional old bridge is absent and reports the limitation', async () => {
    panel = new LocalePanel(undefined); field('language-select').value = 'ko'; field('language-select').emit('change'); await flush()
    expect(getLocale()).toBe('ko'); expect(field('language-status').hidden).toBe(false)
    expect(field('language-status').textContent).toContain('仅本次使用')
  })
})
