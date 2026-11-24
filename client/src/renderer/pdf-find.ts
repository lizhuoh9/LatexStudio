import { findAllInPdfPage, indexPdfPage, quoteKey, type PdfPageIndex, type PdfTextRect } from '../shared/comment-anchor'
import { translate } from '../shared/i18n'
import type { PdfPageText } from './pdf-view'
import { element } from './dom'
import { readableError } from './editor-model'
import { uiFormattedText } from './i18n-dom'
import './find-bar-style.css'

export const PDF_FIND_LIMITS = Object.freeze({ query: 200, matches: 2000, publishEvery: 16, typingDelayMs: 140 })
export interface PdfFindSource { readonly pageCount: number; pageText(page: number): Promise<PdfPageText | null> }
export interface PdfFindMatch { page: number; pageWidth: number; pageHeight: number; rects: PdfTextRect[] }
/** `matches` are in page order; `current` is -1 when there is none. `capped` means more exist than were collected. */
export interface PdfFindState { query: string; matches: readonly PdfFindMatch[]; current: number; searching: boolean; capped: boolean }
const NOTHING: PdfFindState = Object.freeze({ query: '', matches: Object.freeze([]), current: -1, searching: false, capped: false })

/** Searches the plain text of every page (never links, annotations or scripts) and keeps one selected match.
 * Pages are read from the page the user is looking at, wrapping round, so the nearest match is shown first.
 */
export class PdfFindModel {
  private generation = 0
  private state: PdfFindState = NOTHING
  private selected: PdfFindMatch | null = null
  private readonly indexes = new WeakMap<PdfPageText, PdfPageIndex>()

  constructor(private readonly source: PdfFindSource, private readonly changed: (state: PdfFindState, reveal: boolean) => void) {}

  get current(): PdfFindState { return this.state }

  async search(text: string, fromPage = 1, reveal = true): Promise<void> {
    const query = text.slice(0, PDF_FIND_LIMITS.query), generation = ++this.generation, pages = this.source.pageCount
    this.selected = null
    if (!quoteKey(query) || pages < 1) { this.emit({ ...NOTHING, query }, false); return }
    const byPage = new Map<number, PdfFindMatch[]>()
    let total = 0, capped = false
    const publish = (searching: boolean, jump: boolean): void => {
      const matches = [...byPage.keys()].sort((a, b) => a - b).flatMap(page => byPage.get(page)!)
      this.emit({ query, matches, current: this.selected ? matches.indexOf(this.selected) : -1, searching, capped }, jump)
    }
    this.emit({ ...NOTHING, query, searching: true }, false)
    const start = Math.max(1, Math.min(pages, Math.trunc(fromPage) || 1))
    for (let offset = 0; offset < pages && !capped; offset++) {
      const page = (start - 1 + offset) % pages + 1, content = await this.source.pageText(page)
      if (generation !== this.generation) return
      if (!content) continue
      const found = findAllInPdfPage(this.index(content), query, PDF_FIND_LIMITS.matches - total)
        .map(rects => ({ page, pageWidth: content.width, pageHeight: content.height, rects }))
      if (!found.length) continue
      byPage.set(page, found); total += found.length; capped = total >= PDF_FIND_LIMITS.matches
      if (!this.selected) { this.selected = found[0]!; publish(true, reveal) }
      else if (offset % PDF_FIND_LIMITS.publishEvery === 0) publish(true, false)
    }
    publish(false, false)
  }

  /** Moves to the next (1) or previous (-1) match, wrapping at either end. */
  step(delta: 1 | -1): void {
    const { matches, current } = this.state
    if (!matches.length) return
    const next = ((current < 0 ? (delta > 0 ? -1 : 0) : current) + delta + matches.length) % matches.length
    this.selected = matches[next]!
    this.emit({ ...this.state, current: next }, true)
  }

  /** The document was replaced: the same words are looked up again without moving the view. */
  refresh(): Promise<void> { return this.search(this.state.query, this.selected?.page ?? 1, false) }

  clear(): void { this.generation++; this.selected = null; this.emit(NOTHING, false) }

  private index(content: PdfPageText): PdfPageIndex {
    let index = this.indexes.get(content)
    if (!index) { index = indexPdfPage(content.items); this.indexes.set(content, index) }
    return index
  }

  private emit(state: PdfFindState, reveal: boolean): void { this.state = state; this.changed(state, reveal) }
}

/** Search hits drawn under the selectable text layer, one stable container per page (like comment highlights). */
class PdfFindMarks {
  private readonly containers = new Map<number, HTMLDivElement>()
  private matches: readonly PdfFindMatch[] = []
  private current: PdfFindMatch | null = null

  readonly provider = (page: number): HTMLElement => {
    let container = this.containers.get(page)
    if (!container) {
      container = document.createElement('div')
      container.className = 'pdf-find-layer'; container.setAttribute('aria-hidden', 'true')
      this.containers.set(page, container)
      this.paint(page)
    }
    return container
  }

  set(matches: readonly PdfFindMatch[], current: PdfFindMatch | null): void {
    const stale = matches === this.matches ? [this.current, current].filter(match => match !== null) : [...this.matches, ...matches]
    const pages = new Set(stale.map(match => match.page))
    this.matches = matches; this.current = current
    for (const page of pages) this.paint(page)
  }

  private paint(page: number): void {
    const container = this.containers.get(page)
    if (!container) return
    const nodes: HTMLElement[] = []
    for (const match of this.matches) {
      if (match.page !== page || match.pageWidth <= 0 || match.pageHeight <= 0) continue
      for (const rect of match.rects) {
        const node = document.createElement('div')
        node.className = match === this.current ? 'pdf-find-mark is-current' : 'pdf-find-mark'
        node.style.left = `${(rect.x / match.pageWidth) * 100}%`; node.style.top = `${(rect.y / match.pageHeight) * 100}%`
        node.style.width = `${(rect.width / match.pageWidth) * 100}%`; node.style.height = `${(rect.height / match.pageHeight) * 100}%`
        nodes.push(node)
      }
    }
    container.replaceChildren(...nodes)
  }
}

export interface PdfFindHost extends PdfFindSource {
  readonly currentPage: number
  setOverlay(provider: ((page: number) => HTMLElement | null) | null, layer?: string): void
  setDocumentListener(listener: (() => void) | null): void
  reveal(page: number, rects: readonly PdfTextRect[], flash?: boolean): Promise<void>
}

const SELECTION_PREFILL_LIMIT = 100

/** The floating find bar over the PDF: Ctrl/Cmd+F while working in the PDF, Enter / Shift+Enter to move, Esc to close. */
export class PdfFind {
  private readonly bar = element('pdf-find')
  private readonly input = element<HTMLInputElement>('pdf-find-input')
  private readonly count = element('pdf-find-count')
  private readonly opener = element<HTMLButtonElement>('pdf-find-open')
  private readonly previous = element<HTMLButtonElement>('pdf-find-previous')
  private readonly next = element<HTMLButtonElement>('pdf-find-next')
  private readonly panel = this.bar.closest<HTMLElement>('.preview-panel')
  private readonly pages = this.bar.closest<HTMLElement>('.pdf-scroll')
  private readonly marks = new PdfFindMarks()
  private readonly model: PdfFindModel
  private readonly cleanups: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private pointerInPdf = false

  constructor(private readonly pdf: PdfFindHost, private readonly enabled: () => boolean, private readonly notify: (message: string) => void) {
    this.model = new PdfFindModel(pdf, (state, reveal) => this.render(state, reveal))
    pdf.setOverlay(this.marks.provider, 'find')
    pdf.setDocumentListener(() => { if (!this.bar.hidden) void this.model.refresh().catch(error => this.notify(readableError(error))) })
    this.listen(this.opener, 'click', () => { if (this.bar.hidden) this.open(); else this.close() })
    this.listen(element('pdf-find-close'), 'click', () => this.close())
    this.listen(this.previous, 'click', () => this.move(-1))
    this.listen(this.next, 'click', () => this.move(1))
    this.listen(this.input, 'input', () => this.typed())
    this.listen(this.bar, 'keydown', event => this.keydown(event as KeyboardEvent))
    this.listen(document, 'pointerdown', event => { this.pointerInPdf = this.within(this.pages, event.target) }, true)
    this.listen(window, 'keydown', event => this.shortcut(event as KeyboardEvent))
    this.render(this.model.current, false)
  }

  open(): void {
    if (!this.enabled()) return
    this.bar.hidden = false
    this.opener.setAttribute('aria-expanded', 'true')
    const selected = this.selectedText()
    if (selected) this.input.value = selected
    this.input.focus(); this.input.select()
    if (this.input.value !== this.model.current.query || !this.model.current.matches.length) this.searchNow()
  }

  close(): void {
    const focused = this.bar.contains(document.activeElement)
    this.cancelTimer()
    this.bar.hidden = true
    this.opener.setAttribute('aria-expanded', 'false')
    this.model.clear()
    if (focused) this.opener.focus()
  }

  dispose(): void {
    this.cancelTimer()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.model.clear()
    this.pdf.setDocumentListener(null); this.pdf.setOverlay(null, 'find')
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void, capture = false): void {
    target.addEventListener(type, handler, capture)
    this.cleanups.push(() => target.removeEventListener(type, handler, capture))
  }

  private within(area: HTMLElement | null, target: EventTarget | null): boolean {
    return Boolean(area && target instanceof Node && area.contains(target))
  }

  /** Text selected inside the PDF, when it is short enough to be a search term. */
  private selectedText(): string {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !element('pdf-pages').contains(selection.anchorNode)) return ''
    const value = selection.toString().trim()
    return value && value.length <= SELECTION_PREFILL_LIMIT && !/[\r\n]/.test(value) ? value : ''
  }

  private cancelTimer(): void { if (this.timer !== null) { clearTimeout(this.timer); this.timer = null } }
  private typed(): void {
    this.cancelTimer()
    this.timer = setTimeout(() => { this.timer = null; this.searchNow() }, PDF_FIND_LIMITS.typingDelayMs)
  }
  private searchNow(): void {
    this.cancelTimer()
    void this.model.search(this.input.value, this.pdf.currentPage).catch(error => this.notify(readableError(error)))
  }

  private move(delta: 1 | -1): void {
    if (this.timer !== null || this.input.value !== this.model.current.query) this.searchNow()
    else this.model.step(delta)
  }

  private keydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close() }
    else if (event.key === 'Enter' && event.target === this.input) { event.preventDefault(); this.move(event.shiftKey ? -1 : 1) }
  }

  /** Ctrl/Cmd+F belongs to the PDF only while the user is working in its pages (or its toolbar); the source
   * editor keeps its own, and so does any other text field, such as a comment being written beside the PDF.
   */
  private shortcut(event: KeyboardEvent): void {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return
    const target = event.target instanceof Element ? event.target : null
    const typingElsewhere = Boolean(target?.closest('input, textarea, select, [contenteditable], .cm-editor')) && !this.bar.contains(target)
    const here = !typingElsewhere && (this.pointerInPdf || this.within(this.panel, target))
    if (!here || !this.enabled() || !this.panel?.getClientRects().length || document.querySelector('dialog[open]')) return
    event.preventDefault()
    this.open()
  }

  private render(state: PdfFindState, reveal: boolean): void {
    const total = state.matches.length, current = state.matches[state.current] ?? null
    const missing = Boolean(state.query.trim()) && !state.searching && total === 0 && this.pdf.pageCount > 0
    this.marks.set(state.matches, current)
    uiFormattedText(this.count, () => missing ? translate('无结果')
      : total ? `${state.current + 1} / ${total}${state.capped ? '+' : ''}` : state.searching ? '…' : '')
    this.input.parentElement?.classList.toggle('is-missing', missing)
    this.previous.disabled = this.next.disabled = total === 0
    if (reveal && current) void this.pdf.reveal(current.page, current.rects, false).catch(error => this.notify(readableError(error)))
  }
}
