import type { UiLocale } from './i18n'

/** Only a validated language enum crosses this bridge; never a path, project or account setting. */
export interface PreferencesState { locale: UiLocale }
export interface PreferencesApi {
  get(): Promise<PreferencesState>
  set(locale: UiLocale): Promise<PreferencesState>
  onChanged(listener: (state: PreferencesState) => void): () => void
}
export const PREFERENCES_CHANNELS = {
  get: 'preferences:get', set: 'preferences:set', changed: 'preferences:changed'
} as const
export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh-CN' || value === 'en' || value === 'ko'
}
