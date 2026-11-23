/**
 * Source editor font stack.
 *
 * The first four entries are Overleaf's default editor stack ("monaco" option in
 * services/web/frontend/js/shared/utils/styles.ts): system fonts, nothing bundled.
 * Windows usually resolves to Consolas (or Ubuntu Mono when the user installed it),
 * macOS to Menlo/Monaco.
 *
 * The CJK entries come before the generic `monospace` on purpose: on Chinese
 * Windows, Chromium maps `monospace` (and the unsupported `ui-monospace`) to
 * NSimSun, so without them Chinese comments - and, with the old stack, all source
 * text - render in that bitmap-era serif face.
 */
export const OVERLEAF_EDITOR_FONTS: readonly string[] = ['Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas']

export const CJK_EDITOR_FALLBACK_FONTS: readonly string[] = [
  'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Malgun Gothic', 'Apple SD Gothic Neo'
]

function cssFamily(name: string): string {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `"${name}"`
}

export const EDITOR_FONT_FAMILY: string =
  [...OVERLEAF_EDITOR_FONTS, ...CJK_EDITOR_FALLBACK_FONTS].map(cssFamily).concat('monospace').join(', ')
