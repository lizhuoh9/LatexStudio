import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getLocale, intlLocale, isUiLocale, setLocale, subscribeLocale, translate,
  translationEntries, translationPatterns, UI_LOCALES, type Translation, type UiLocale
} from '../src/shared/i18n'

const initialLocale = getLocale()
const locales = ['zh-CN', 'en', 'ko'] as const
const foreignLocales = ['en', 'ko'] as const
const unsubscribe: Array<() => void> = []
const observe = (listener: () => void): (() => void) => {
  const stop = subscribeLocale(listener); unsubscribe.push(stop); return stop
}
const render = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{\d+\}/g, marker => values[marker] ?? marker)
const placeholders = (template: string): string[] => [...new Set(template.match(/\{\d+\}/g) ?? [])].sort()
// Exact duplicates have documented first-entry precedence, not last-entry overrides.
const firstEntries = (entries: readonly Translation[]): Translation[] => {
  const seen = new Set<string>()
  return entries.filter(([source]) => { if (seen.has(source)) return false; seen.add(source); return true })
}
const pattern = (source: string): Translation => {
  const entry = translationPatterns.find(([key]) => key === source)
  if (!entry) throw new Error(`Missing trusted test template: ${source}`)
  return entry
}

beforeEach(() => { setLocale('zh-CN') })
afterEach(() => {
  for (const stop of unsubscribe.splice(0)) stop()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); setLocale('zh-CN')
})

describe('shared interface locale state', () => {
  it('defaults to Chinese and exposes only the three immutable locale identifiers', () => {
    expect(initialLocale).toBe('zh-CN')
    expect(getLocale()).toBe('zh-CN')
    expect(UI_LOCALES).toEqual(locales)
    expect(Object.isFrozen(UI_LOCALES)).toBe(true)
  })
  it.each(locales)('accepts the exact %s enum and selects its Intl identifier', locale => {
    expect(isUiLocale(locale)).toBe(true)
    setLocale(locale)
    expect(getLocale()).toBe(locale)
    expect(intlLocale()).toBe(({ 'zh-CN': 'zh-CN', en: 'en-US', ko: 'ko-KR' } as const)[locale])
  })
  it.each([undefined, null, '', 'zh', 'zh-cn', 'EN', 'ko-KR', 'fr', '../en', 0, {}, ['en'], { locale: 'en' }])(
    'rejects non-enum value %j without changing state or notifying views', value => {
      const listener = vi.fn(); observe(listener)
      expect(isUiLocale(value)).toBe(false)
      expect(() => setLocale(value as UiLocale)).toThrow('Unsupported interface language')
      expect(getLocale()).toBe('zh-CN'); expect(listener).not.toHaveBeenCalled()
    }
  )
  it('notifies once per actual change and changes the default translator immediately', () => {
    const observed: Array<[UiLocale, string]> = []
    const stop = observe(() => observed.push([getLocale(), translate('保存')]))
    setLocale('zh-CN'); setLocale('en'); setLocale('en'); setLocale('ko'); setLocale('zh-CN')
    expect(observed).toEqual([['en', 'Save'], ['ko', '저장'], ['zh-CN', '保存']])
    stop(); stop(); setLocale('en')
    expect(observed).toHaveLength(3)
  })
  it('isolates a failing subscriber without skipping other views', () => {
    observe(() => { throw new Error('fixture view disposed') })
    const view = vi.fn(); observe(view)
    expect(() => setLocale('en')).not.toThrow()
    expect(view).toHaveBeenCalledOnce(); expect(getLocale()).toBe('en')
  })
  it('explicit translation never mutates the current locale or notifies views', () => {
    const listener = vi.fn(); observe(listener)
    expect(translate('保存', 'en')).toBe('Save')
    expect(translate('保存', 'ko')).toBe('저장')
    expect(getLocale()).toBe('zh-CN'); expect(listener).not.toHaveBeenCalled()
  })
})

describe('representative application-owned text', () => {
  it.each([
    ['保存', 'Save', '저장'],
    ['语言设置请求无效。', 'Invalid language settings request.', '언어 설정 요청이 유효하지 않습니다.'],
    ['此页面不能访问语言设置。', 'This page cannot access language settings.', '이 페이지에서는 언어 설정에 접근할 수 없습니다.'],
    ['GitHub登录', 'Sign in with GitHub', 'GitHub 로그인'],
    ['打开本地论文', 'Open local paper', '로컬 논문 열기'],
    ['软件更新', 'Software update', '소프트웨어 업데이트'],
    ['编译日志', 'Compile log', '컴파일 로그'],
    ['当前文档有尚未保存的编辑。', 'The current document has unsaved edits.', '현재 문서에 저장하지 않은 편집 내용이 있습니다.'],
    ['未能确认安全关闭，窗口和编辑草稿已保留。', 'Safe shutdown could not be confirmed. The window and draft have been kept.', '안전한 종료를 확인할 수 없어 창과 편집 초안을 유지했습니다.'],
    ['剪切', 'Cut', '잘라내기'],
    ['退出 LatexStudio', 'Quit LatexStudio', 'LatexStudio 종료']
  ] as const)('translates %s into English and Korean, with Chinese identity', (source, en, ko) => {
    expect(translate(source, 'zh-CN')).toBe(source)
    expect(translate(source, 'en')).toBe(en)
    expect(translate(source, 'ko')).toBe(ko)
  })
  it.each([
    '语言设置请求无效。',
    '此页面不能访问语言设置。',
    '无法确认语言设置已保存，请重试；论文文件未修改。'
  ])('requires a translated fixed preference-system message: %s', source => {
    const entry = translationEntries.find(([key]) => key === source)
    expect(entry, source).toBeDefined()
    if (!entry) throw new Error(`Missing fixed system message: ${source}`)
    expect(translate(source, 'zh-CN')).toBe(source)
    for (const locale of foreignLocales) {
      const expected = entry[locale === 'en' ? 1 : 2]
      expect(expected.length).toBeGreaterThan(0); expect(expected).not.toBe(source)
      expect(translate(source, locale)).toBe(expected)
    }
  })
  it('uses every first exact catalog entry without partial-word replacements', () => {
    expect(translationEntries.length).toBeGreaterThan(0)
    for (const [source, en, ko] of firstEntries(translationEntries)) {
      expect(source.length).toBeGreaterThan(0)
      expect(en.length).toBeGreaterThan(0); expect(ko.length).toBeGreaterThan(0)
      expect(translate(source, 'zh-CN'), source).toBe(source)
      expect(translate(source, 'en'), source).toBe(en)
      expect(translate(source, 'ko'), source).toBe(ko)
    }
  })
  it.each(foreignLocales)('preserves unknown diagnostics, paper text and protocol-looking strings in %s', locale => {
    for (const source of [
      '', 'unrecognized diagnostic ERR_FIXTURE_42', '用户自己的保存论文标题',
      '\\section{保存} % 编译日志', 'D:\\papers\\保存\\取消.tex', '/home/保存/取消.tex',
      'https://example.invalid/保存?q=取消', 'workspace:save', 'AUTHORIZATION_REQUIRED',
      '! Undefined control sequence. l.42 \\保存', '<script>保存()</script>',
      'prefix保存suffix', '保存。用户原文', '保存\u0000取消'
    ]) expect(translate(source, locale), source).toBe(source)
  })
  it.each(foreignLocales)('retains leading/trailing whitespace exactly in %s', locale => {
    expect(translate(' \t保存\r\n  ', locale)).toBe(` \t${translate('保存', locale)}\r\n  `)
    expect(translate(' \t未收录的用户文字\r\n  ', locale)).toBe(' \t未收录的用户文字\r\n  ')
    expect(translate(' \t\r\n  ', locale)).toBe(' \t\r\n  ')
  })
  it.each(foreignLocales)('leaves oversized input unchanged in %s', locale => {
    const source = '保存'.repeat(8001)
    expect(translate(source, locale)).toBe(source)
  })
})

describe('literal trusted-template interpolation', () => {
  it('keeps the same placeholder set in source and both translations', () => {
    expect(translationPatterns.length).toBeGreaterThan(0)
    for (const [source, en, ko] of translationPatterns) {
      expect(placeholders(source).length, source).toBeGreaterThan(0)
      expect(placeholders(en), source).toEqual(placeholders(source))
      expect(placeholders(ko), source).toEqual(placeholders(source))
    }
  })
  it.each(foreignLocales)('interpolates all catalog templates with literal Chinese/data values in %s', locale => {
    for (const entry of firstEntries(translationPatterns)) {
      const values = Object.fromEntries(placeholders(entry[0]).map((marker, index) =>
        [marker, `保存_取消_原值${index}_$&_$1_$\`_$'_{1}_<b>_취소`]))
      const source = render(entry[0], values)
      expect(translate(source, 'zh-CN'), entry[0]).toBe(source)
      expect(translate(source, locale), entry[0]).toBe(render(entry[locale === 'en' ? 1 : 2], values))
    }
  })
  it.each(foreignLocales)('preserves path/name boundaries and replacement metacharacters in %s', locale => {
    const entry = pattern('主文件：{0} · 项目根目录：{1}')
    const values = {
      '{0}': '保存/取消.tex',
      '{1}': 'D:\\保存\\取消 $& $1 $` $\' {0} <img src=x onerror=保存()>'
    }
    expect(translate(render(entry[0], values), locale)).toBe(render(entry[locale === 'en' ? 1 : 2], values))
    expect(translate('回退文件 保存/取消.tex 到所选版本？', locale)).toBe(locale === 'en'
      ? 'Restore file 保存/取消.tex to the selected version?'
      : '파일 保存/取消.tex을(를) 선택한 버전으로 복원하시겠습니까?')
  })
  it.each(foreignLocales)('copies multiline trailing user values without recursively translating them in %s', locale => {
    const entry = pattern('邀请人：{0}')
    const values = { '{0}': '保存\n取消\r\nGitHub登录\n<script>throw new Error("inert")</script>' }
    expect(translate(render(entry[0], values), locale)).toBe(render(entry[locale === 'en' ? 1 : 2], values))
  })
  it.each(foreignLocales)('keeps raw native dialog detail values after the trusted newline in %s', locale => {
    const entry = pattern('{0} 个待记录文件改动。同步会保存本地版本并收发远端版本；冲突时不会强制覆盖。\n{1}')
    const values = { '{0}': '2', '{1}': '保存\n取消\nD:\\保存\\取消.tex\nERR_FIXTURE_42' }
    expect(translate(render(entry[0], values), locale)).toBe(render(entry[locale === 'en' ? 1 : 2], values))
  })
  it.each(foreignLocales)('requires full template boundaries and bounds raw arguments in %s', locale => {
    for (const source of ['prefix 回退文件 保存 到所选版本？', '回退文件 保存 到所选版本？ suffix',
      `邀请人：${'x'.repeat(4097)}`]) expect(translate(source, locale)).toBe(source)
    expect(translate(`邀请人：${'x'.repeat(4096)}`, locale)).toBe(`${locale === 'en' ? 'Invited by: ' : '초대한 사람: '}${'x'.repeat(4096)}`)
  })
})

describe('fixed error context and composed application warnings', () => {
  it.each(foreignLocales)('translates only the body of the fixed Electron IPC wrapper in %s', locale => {
    const prefix = "Error invoking remote method 'workspace:save': Error: "
    const message = '未能确认安全关闭，窗口和编辑草稿已保留。'
    expect(translate(prefix + message, locale)).toBe(prefix + translate(message, locale))
    expect(translate(prefix + 'ERR_FIXTURE_42 /保存/取消.tex', locale)).toBe(prefix + 'ERR_FIXTURE_42 /保存/取消.tex')
    const malformed = "Error invoking remote method 'not/a/channel': Error: 保存"
    expect(translate(malformed, locale)).toBe(malformed)
    const longChannel = `Error invoking remote method '${'x'.repeat(81)}': Error: 保存`
    expect(translate(longChannel, locale)).toBe(longChannel)
  })
  it.each(foreignLocales)('preserves operation context and literal unknown diagnostics in %s', locale => {
    const prefix = locale === 'en' ? 'Operation did not complete: ' : '작업을 완료하지 못했습니다: '
    expect(translate('操作未完成：保存', locale)).toBe(prefix + translate('保存', locale))
    expect(translate('操作未完成：ERR_FIXTURE_42 /保存/取消.tex', locale)).toBe(prefix + 'ERR_FIXTURE_42 /保存/取消.tex')
  })
  it.each(foreignLocales)('joins fixed sentences only at a real space/newline boundary in %s', locale => {
    const first = '当前文档有尚未保存的编辑。'
    const second = '未能确认安全关闭，窗口和编辑草稿已保留。'
    expect(translate(`${first} ${second}`, locale)).toBe(`${translate(first, locale)} ${translate(second, locale)}`)
    expect(translate(`${first}\n${second}`, locale)).toBe(`${translate(first, locale)}\n${translate(second, locale)}`)
    expect(translate(`${first}用户原文`, locale)).toBe(`${first}用户原文`)
    expect(translate('保存\nERR_FIXTURE_42\n取消', locale)).toBe(`${translate('保存', locale)}\nERR_FIXTURE_42\n${translate('取消', locale)}`)
  })
  it.each(foreignLocales)('composes owned nested failures without translating raw path data in %s', locale => {
    const raw = 'D:/保存/取消.tex', body = `已创建本地文件：${raw}`
    const suffix = '。当前草稿已保留，请检查目录权限后重试。'
    const translated = translate(`操作未完成：${body}${suffix}`, locale)
    expect(translated).toBe(translate('操作未完成：', locale) + translate(body, locale) + translate(suffix, locale))
    expect(translated).toContain(raw)
    expect(translated.replace(raw, '')).not.toMatch(/[㐀-鿿]/)
    for (const label of ['关联', '下载项目', '同步', '后台传输']) {
      for (const source of [`${label}正在进行。`, `已请求取消${label}，正在等待操作与清理收束。`,
        `${label}操作等待已结束；这不代表成功、连接清理已确认或修改已撤回，请查看最终结果。`]) {
        expect(translate(source, locale), source).not.toMatch(/[㐀-鿿]/)
      }
    }
  })
  it.each(foreignLocales)('translates a closed software operation failure without interpreting raw names in %s', locale => {
    const raw = 'D:/保存/取消.tex', body = `已创建本地文件：${raw}`, operation = '保存文件'
    const result = translate(`${operation}失败：${body}`, locale)
    expect(result).toBe(translate(operation, locale) + ' — ' + translate('失败：', locale) + translate(body, locale))
    expect(result).toContain(raw)
    expect(result.replace(raw, '')).not.toMatch(/[㐀-鿿]/)
    expect(translate('用户文件名失败：保存', locale)).toBe('用户文件名失败：保存')
  })
  it('needs no DOM, network, persistence or evaluation when switching and translating', () => {
    const forbidden = vi.fn(() => { throw new Error('Unexpected external side effect') })
    const storage = { getItem: forbidden, setItem: forbidden, removeItem: forbidden, clear: forbidden }
    vi.stubGlobal('fetch', forbidden)
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage)
    vi.stubGlobal('document', { createElement: forbidden, querySelector: forbidden })
    vi.stubGlobal('window', { localStorage: storage, sessionStorage: storage, fetch: forbidden })
    vi.stubGlobal('eval', forbidden)
    const source = '邀请人：<script>globalThis.__paperstudioI18nProbe = true</script>保存'
    for (const locale of locales) {
      setLocale(locale)
      expect(translate(source)).toContain('<script>globalThis.__paperstudioI18nProbe = true</script>保存')
    }
    expect(forbidden).not.toHaveBeenCalled()
    expect(Object.prototype.hasOwnProperty.call(globalThis, '__paperstudioI18nProbe')).toBe(false)
  })
})
