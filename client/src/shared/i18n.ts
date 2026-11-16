import { UI_TRANSLATIONS, UI_PATTERNS } from './i18n-ui'
import { MESSAGE_TRANSLATIONS, MESSAGE_PATTERNS } from './i18n-messages'
import { NATIVE_TRANSLATIONS, NATIVE_PATTERNS } from './i18n-native'

export type UiLocale = 'zh-CN' | 'en' | 'ko'
export type Translation = readonly [source: string, english: string, korean: string]
export const UI_LOCALES: readonly UiLocale[] = Object.freeze(['zh-CN', 'en', 'ko'])
let current: UiLocale = 'zh-CN'
const listeners = new Set<() => void>()
export function isUiLocale(value: unknown): value is UiLocale { return value === 'zh-CN' || value === 'en' || value === 'ko' }
export function getLocale(): UiLocale { return current }
export function intlLocale(): string { return current === 'en' ? 'en-US' : current === 'ko' ? 'ko-KR' : 'zh-CN' }
export function subscribeLocale(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setLocale(locale: UiLocale): void {
  if (!isUiLocale(locale)) throw new Error('Unsupported interface language')
  if (current === locale) return
  current = locale
  for (const listener of [...listeners]) { try { listener() } catch { /* One view must not break the other language bindings. */ } }
}

function combine(...groups: readonly (readonly Translation[])[]): readonly Translation[] { return groups.flat() }
export const translationEntries = combine(UI_TRANSLATIONS, NATIVE_TRANSLATIONS, MESSAGE_TRANSLATIONS)
export const translationPatterns = combine(UI_PATTERNS, NATIVE_PATTERNS, MESSAGE_PATTERNS)
const messages = new Map<string, readonly [string, string]>()
for (const [source, en, ko] of translationEntries) if (!messages.has(source)) messages.set(source, [en, ko])
const patterns = translationPatterns.map(entry => ({ entry, parts: entry[0].split(/(\{\d+\})/g) }))
const sentences = [...messages.keys()].filter(key => /[。！？]$/.test(key)).sort((a, b) => b.length - a.length)

/** Trusted message templates only; values are copied verbatim, never evaluated or translated as document data. */
function argumentsFor(source: string, parts: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>()
  let offset = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!/^\{\d+\}$/.test(part)) {
      if (!source.startsWith(part, offset)) return null
      offset += part.length; continue
    }
    const delimiter = parts[i + 1] ?? ''
    if (!delimiter && i + 2 < parts.length) return null
    const end = delimiter ? i + 2 === parts.length ? source.length - delimiter.length : source.indexOf(delimiter, offset) : source.length
    if (end < offset || end - offset > 4096) return null
    const value = source.slice(offset, end), previous = values.get(part)
    if (previous !== undefined && previous !== value) return null
    values.set(part, value); offset = end
  }
  return offset === source.length ? values : null
}

const diagnosticPrefixes = ['操作未完成：', '同步未完成：', 'PDF 预览失败：', '失败：', '共享文件历史不可用：',
  '无法取得项目写锁，未确认保存；请保留草稿。', '写锁释放未确认，不能确认保存成功。']
const diagnosticSuffixes = ['。当前草稿已保留，请检查目录权限后重试。', '；历史事务恢复未确认，请保留草稿。',
  '；临时文件清理未确认。', '；文件可能已保存，请保留草稿并检查实际文件，勿反复覆盖。']

/** This is for application UI messages, not arbitrary filenames, paper text, compiler output or protocol identifiers. */
export function translate(source: string, locale: UiLocale = current): string { return translateBounded(source, locale, 0) }
function translateBounded(source: string, locale: UiLocale, depth: number): string {
  if (locale === 'zh-CN' || !source || source.length > 16000 || depth >= 16) return source
  const pair = messages.get(source), index = locale === 'en' ? 0 : 1
  if (pair) return pair[index] || source
  for (const { entry, parts } of patterns) {
    const values = argumentsFor(source, parts)
    if (values) return entry[index + 1]!.replace(/\{\d+\}/g, marker => values.get(marker) ?? marker)
  }
  const trimmed = source.trim()
  if (trimmed !== source && trimmed) {
    const translated = translateBounded(trimmed, locale, depth + 1)
    return source.slice(0, source.indexOf(trimmed)) + translated + source.slice(source.indexOf(trimmed) + trimmed.length)
  }
  // Electron's fixed IPC wrapper is diagnostic context, not a token or user-supplied URL.
  const remote = source.match(/^Error invoking remote method '[a-zA-Z0-9:_-]{1,80}': Error: /)
  if (remote) return remote[0] + translateBounded(source.slice(remote[0].length), locale, depth + 1)
  const failure = source.indexOf('失败：'), operation = source.slice(0, failure)
  if (failure > 0 && failure <= 80 && messages.has(operation)) return translateBounded(operation, locale, depth + 1) +
    ' — ' + translateBounded('失败：', locale, depth + 1) + translateBounded(source.slice(failure + 3), locale, depth + 1)
  for (const suffix of diagnosticSuffixes) {
    if (source !== suffix && source.endsWith(suffix)) return translateBounded(source.slice(0, -suffix.length), locale, depth + 1) + translateBounded(suffix, locale, depth + 1)
  }
  for (const prefix of diagnosticPrefixes) {
    if (source.startsWith(prefix)) return (messages.get(prefix)?.[index] ?? prefix) + translateBounded(source.slice(prefix.length), locale, depth + 1)
  }
  for (const key of sentences) {
    if (source.startsWith(key) && /^[ \n]/.test(source.slice(key.length, key.length + 1))) {
      return translateBounded(key, locale, depth + 1) + translateBounded(source.slice(key.length), locale, depth + 1)
    }
  }
  if (source.includes('\n')) return source.split('\n').map(line => translateBounded(line, locale, depth + 1)).join('\n')
  return source
}
