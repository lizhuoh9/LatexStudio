import { getLocale, isUiLocale, setLocale, subscribeLocale, type UiLocale } from '../shared/i18n'
import type { PreferencesApi, PreferencesState } from '../shared/locale-contracts'
import { button, element, text } from './dom'

declare global { interface Window { paperstudioPreferences?: PreferencesApi } }

/** A missing or denied UI preference never prevents account-free local editing. */
export async function initializeLocalePreference(api: PreferencesApi | undefined): Promise<void> {
  if (!api) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const state = await Promise.race([api.get(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Preference bridge unavailable')), 1500)
    })])
    if (isUiLocale(state?.locale)) setLocale(state.locale)
  } catch { /* Chinese remains available if this optional preference cannot load. */ }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

export class LocalePanel {
  private closing = false
  private disposed = false
  private saving = false
  private pendingLocale: UiLocale | null = null
  private readonly select = element<HTMLSelectElement>('language-select')
  private readonly unsubscribe: Array<() => void> = []
  private change = (): void => { void this.choose() }

  constructor(private api: PreferencesApi | undefined = window.paperstudioPreferences) {
    button('language-open', () => {
      if (!this.closing && !this.disposed) element<HTMLDialogElement>('language-dialog').showModal()
    })
    button('language-close', () => { if (!this.closing && !this.disposed) element<HTMLDialogElement>('language-dialog').close() })
    this.select.addEventListener('change', this.change)
    this.unsubscribe.push(subscribeLocale(() => { this.select.value = getLocale() }))
    if (api) this.unsubscribe.push(api.onChanged(state => this.receive(state)))
    this.select.value = getLocale()
  }

  private receive(state: PreferencesState): void {
    if (this.disposed || !isUiLocale(state?.locale)) return
    if (this.closing) { this.pendingLocale = state.locale; return }
    setLocale(state.locale); this.select.value = getLocale()
  }

  private async choose(): Promise<void> {
    const locale = this.select.value
    if (this.closing || this.disposed || this.saving || !isUiLocale(locale)) { this.select.value = getLocale(); return }
    this.saving = true; this.select.disabled = true
    text('language-status', ''); element('language-status').hidden = true
    try {
      if (this.api) {
        const state = await this.api.set(locale)
        if (!isUiLocale(state?.locale) || state.locale !== locale) throw new Error('Invalid preference acknowledgement')
        this.receive(state)
      } else {
        setLocale(locale)
        if (!this.disposed && !this.closing) { text('language-status', '仅本次使用，无法保存语言设置。'); element('language-status').hidden = false }
      }
    } catch {
      if (!this.disposed && !this.closing) {
        this.select.value = getLocale(); text('language-status', '无法保存语言设置，请重试。'); element('language-status').hidden = false
      }
    } finally { this.saving = false; if (!this.disposed) this.select.disabled = this.closing }
  }

  setClosing(closing: boolean): void {
    this.closing = closing; this.select.disabled = closing || this.saving
    if (!closing && this.pendingLocale) { const locale = this.pendingLocale; this.pendingLocale = null; this.receive({ locale }) }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.select.disabled = true; this.select.removeEventListener('change', this.change)
    for (const unsubscribe of this.unsubscribe) unsubscribe()
  }
}
