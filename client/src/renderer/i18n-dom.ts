import { getLocale, subscribeLocale, translate } from '../shared/i18n'

type Binding = { source: string | (() => string); kind: 'node' | 'text' | 'value' | 'attribute'; attribute?: string }
const bindings = new Map<Node, Map<string, Binding>>()
const protectedText = new Set(['project-name', 'active-file', 'project-settings-name', 'file-tree-context',
  'account-label', 'account-name', 'account-initial', 'collaboration-state', 'collaboration-code',
  'collaboration-verification', 'revision-context', 'revision-file-name', 'revision-selected-time',
  'license-text', 'notices-text', 'log'])
let unsubscribe: (() => void) | null = null
let pruning = false

function render(node: Node, binding: Binding): void {
  const value = typeof binding.source === 'function' ? binding.source() : translate(binding.source)
  if (binding.kind === 'node') { if (node.nodeValue !== value) node.nodeValue = value }
  else if (binding.kind === 'text') { if (node.textContent !== value) node.textContent = value }
  else if (binding.kind === 'value') { if ((node as HTMLTextAreaElement).value !== value) (node as HTMLTextAreaElement).value = value }
  else if (typeof (node as Element).getAttribute !== 'function' || (node as Element).getAttribute(binding.attribute!) !== value) (node as Element).setAttribute(binding.attribute!, value)
}
function remember(node: Node, key: string, binding: Binding): void {
  // Rows are often built off-DOM and appended as one batch; prune only after that synchronous render completes.
  if (!pruning) { pruning = true; queueMicrotask(() => {
    pruning = false
    for (const old of bindings.keys()) if (old.isConnected === false) bindings.delete(old)
  }) }
  let items = bindings.get(node)
  if (!items) { items = new Map(); bindings.set(node, items) }
  items.set(key, binding); render(node, binding)
}
export function uiText(node: Node, source: string): void { remember(node, '#text', { kind: 'text', source }) }
export function uiFormattedText(node: Node, source: () => string): void { remember(node, '#text', { kind: 'text', source }) }
export function uiFormattedAttribute(node: Element, attribute: 'title' | 'aria-label', source: () => string): void {
  remember(node, attribute, { kind: 'attribute', attribute, source })
}
export function uiAttribute(node: Element, attribute: 'title' | 'aria-label' | 'placeholder' | 'aria-valuetext', source: string): void {
  remember(node, attribute, { kind: 'attribute', attribute, source })
}
/** Read-only application error detail, never an editable filename, token, paper or summary input. */
export function uiErrorValue(node: HTMLTextAreaElement, source: string): void {
  remember(node, '#value', { kind: 'value', source })
}
export function forgetUiText(node: Node): void { bindings.get(node)?.delete('#text') }
export function textIsLiteral(id: string): boolean { return protectedText.has(id) }

/** Call only on our initial HTML or a newly installed trusted UI TEMPLATE, before inserting user data. No DOM observer. */
export function localizeStaticHtml(root: Document | Element): void {
  const owner = root.nodeType === 9 ? root as Document : root.ownerDocument
  if (!owner?.createTreeWalker || !root.querySelectorAll) return // Minimal non-browser test bridges remain usable.
  const ignored = 'script, style, pre, code, textarea, [data-i18n-ignore], .cm-editor'
  const walker = owner.createTreeWalker(root, 4)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(ignored) || !/[\u3400-\u9fff]/.test(node.nodeValue ?? '')) continue
    texts.push(node as Text)
  }
  for (const node of texts) remember(node, '#node', { kind: 'node', source: node.nodeValue ?? '' })
  for (const node of root.querySelectorAll('[title], [aria-label], [placeholder]')) {
    if (node.closest('[data-i18n-ignore], .cm-editor')) continue
    for (const attribute of ['title', 'aria-label', 'placeholder'] as const) {
      const source = node.getAttribute(attribute)
      if (source && /[\u3400-\u9fff]/.test(source)) uiAttribute(node, attribute, source)
    }
  }
}
export function refreshUiTranslations(): void {
  for (const [node, items] of bindings) {
    if (node.isConnected === false) { bindings.delete(node); continue }
    for (const binding of items.values()) render(node, binding)
  }
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = getLocale()
}
export function startDomLocalization(): () => void {
  unsubscribe?.(); unsubscribe = subscribeLocale(refreshUiTranslations)
  localizeStaticHtml(document); refreshUiTranslations()
  return () => { unsubscribe?.(); unsubscribe = null; bindings.clear() }
}
