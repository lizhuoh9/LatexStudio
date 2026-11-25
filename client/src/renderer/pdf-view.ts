/// <reference types="vite/client" />
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './pdf-preview-style.css'
import type { SyncTexTarget } from '../shared/synctex'
import type { PdfTextItem } from '../shared/comment-anchor'
import { element, text } from './dom'
import { readableError } from './editor-model'
import { uiAttribute } from './i18n-dom'
import { PdfTextMeasure } from './pdf-text-measure'

GlobalWorkerOptions.workerSrc = workerUrl

export const PDF_PREVIEW_LIMITS = Object.freeze({ pages: 2000, canvases: 5, pixelsPerCanvas: 3000000, canvasEdge: 8192, cssEdge: 16000 })
const PADDING = 24, GAP = 16
interface PageSlot {
  node: HTMLDivElement; number: number; top: number; width: number; height: number
  baseWidth: number | null; baseHeight: number | null
  ratio: number | null; canvas: HTMLCanvasElement | null; textNode: HTMLDivElement | null
  textLayer: TextLayer | null; page: PDFPageProxy | null; rendered: number; failed: number
}
interface Drawing { slot: PageSlot; page: PDFPageProxy; canvas: HTMLCanvasElement; task: RenderTask }
interface PanState { pointerId: number; startX: number; startY: number; startLeft: number; startTop: number; moved: boolean }
export interface PdfDoubleClickLocation { page: number; x: number; y: number; word?: string }
/** Plain text items of one page in PDF points, top-left origin, as text only (no fonts, links or scripts). */
export interface PdfPageText { width: number; height: number; items: PdfTextItem[] }
const MAX_TEXT_ITEMS = 50_000

interface RunStyle { fontFamily?: string; vertical?: boolean }
/** Hints for measuring the characters inside one text run; none for vertical, rotated or degenerate runs. */
function runFont(entry: { fontName?: string; width?: number; transform: number[] }, styles: Record<string, RunStyle | undefined> | undefined): Pick<PdfTextItem, 'font' | 'family' | 'ems'> {
  const style = entry.fontName ? styles?.[entry.fontName] : undefined, size = entry.transform[0]!, width = entry.width ?? 0
  if (!entry.fontName || style?.vertical || !(size > 0) || !(width > 0) || Math.abs(entry.transform[1]!) > size * 1e-3) return {}
  return { font: entry.fontName, ...(style?.fontFamily ? { family: style.fontFamily } : {}), ems: width / size }
}

function extractPdfWord(target: EventTarget | null): string | undefined {
  const selected = typeof window.getSelection === 'function' ? window.getSelection()?.toString() ?? '' : ''
  const raw = selected.trim() || ((target as Element | null)?.closest?.('.textLayer span')?.textContent?.trim() ?? '')
  const match = /[A-Za-z0-9\u4e00-\u9fff]+(?:[-_][A-Za-z0-9\u4e00-\u9fff]+)*/.exec(raw)
  return match?.[0]
}

/** Continuous preview with crisp canvas bitmaps and selectable plain-text spans; never renders PDF annotations/scripts/links. */
export class PdfPreview {
  private document: PDFDocumentProxy | null = null
  private loading: PDFDocumentLoadingTask | null = null
  private drawing: Drawing | null = null
  private generation = 0
  private renderVersion = 0
  private page = 1
  private zoom = 1
  private width = 0
  private ratio = Math.SQRT2
  private slots: PageSlot[] = []
  private work: Promise<void> | null = null
  private pending = false
  private retirement: Promise<void> = Promise.resolve()
  private disposed = false
  private lastError = ''
  private ctrlPressed = false
  private pan: PanState | null = null
  private highlights: HTMLDivElement[] = []
  private highlightSlot: PageSlot | null = null
  private highlightTimer: ReturnType<typeof setTimeout> | null = null
  private overlays = new Map<string, (page: number) => HTMLElement | null>()
  private documentListener: (() => void) | null = null
  private readonly pageListeners = new Set<(page: number) => void>()
  private lastListenerError = ''
  private texts = new Map<number, Promise<PdfPageText | null>>()
  private readonly measure = new PdfTextMeasure()
  /** Where each character sits inside a text run from `pageText` (see PdfTextMeasure). */
  readonly textEdges = this.measure.edges
  private host = element('pdf-pages')
  private scroll = this.host.closest<HTMLElement>('.pdf-scroll')
  private observer: ResizeObserver | null = null
  private onScroll = (): void => { void this.schedule().catch(error => this.report(error)) }
  private onResize = (): void => { void this.resize().catch(error => this.report(error)) }
  private onWheel = (event: WheelEvent): void => {
    this.syncModifier(event.ctrlKey || event.metaKey)
    if ((!event.ctrlKey && !event.metaKey) || !this.document || this.disposed || !event.deltaY) return
    event.preventDefault()
    void this.scale(event.deltaY < 0 ? 0.1 : -0.1).catch(error => this.report(error))
  }
  private onKeyChange = (event: KeyboardEvent): void => { this.syncModifier(event.ctrlKey || event.metaKey) }
  private onBlur = (): void => { this.syncModifier(false) }
  private onPointerDown = (event: PointerEvent): void => {
    const hasCtrl = Boolean(event.ctrlKey || event.metaKey)
    this.syncModifier(hasCtrl)
    if (event.button !== 0 || !hasCtrl || !this.document || !this.scroll || this.disposed) return
    if (!this.canPanScroll()) return
    const rect = typeof this.scroll.getBoundingClientRect === 'function' ? this.scroll.getBoundingClientRect() : null
    if (rect && (event.clientX > rect.left + this.scroll.clientWidth || event.clientY > rect.top + this.scroll.clientHeight)) return
    this.pan = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      startLeft: this.scroll.scrollLeft, startTop: this.scroll.scrollTop, moved: false }
  }
  private onPointerMove = (event: PointerEvent): void => {
    if (!this.pan || event.pointerId !== this.pan.pointerId || !this.scroll || this.disposed) return
    if (!(event.ctrlKey || event.metaKey)) { this.onPointerUp(event); return }
    const dx = event.clientX - this.pan.startX, dy = event.clientY - this.pan.startY
    if (!this.pan.moved && Math.hypot(dx, dy) < 4) return
    this.pan.moved = true
    event.preventDefault?.()
    this.scroll.classList?.add?.('is-panning')
    this.scroll.scrollLeft = Math.max(0, this.pan.startLeft - dx)
    this.scroll.scrollTop = Math.max(0, this.pan.startTop - dy)
  }
  private onPointerUp = (event: PointerEvent): void => {
    if (!this.pan || event.pointerId !== this.pan.pointerId) return
    this.pan = null
    this.scroll?.classList?.remove?.('is-panning')
  }
  private onDblClick = (event: MouseEvent): void => {
    if (!this.document || !this.onDoubleClick || this.disposed) return
    const target = (event.target as Element | null)?.closest?.<HTMLElement>('.pdf-page')
    if (!target) return
    const pageNumber = Number(target.dataset?.pdfPage), slot = this.slots[pageNumber - 1]
    if (!slot || typeof target.getBoundingClientRect !== 'function') return
    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const rx = (event.clientX - rect.left) / rect.width, ry = (event.clientY - rect.top) / rect.height
    const word = extractPdfWord(event.target)
    void this.resolveAndNotifyDoubleClick(this.document, slot, pageNumber, rx, ry, word).catch(error => this.report(error))
  }

  constructor(private notify: (message: string) => void, private onDoubleClick?: (location: PdfDoubleClickLocation) => void) {
    if (!this.scroll) throw new Error('缺少 PDF 滚动容器')
    this.host.classList.add('pdf-page-stack')
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true })
    this.scroll.addEventListener('wheel', this.onWheel, { passive: false })
    this.scroll.addEventListener('pointerdown', this.onPointerDown)
    this.scroll.addEventListener('dblclick', this.onDblClick)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyChange)
    window.addEventListener('keyup', this.onKeyChange)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('resize', this.onResize)
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize)
      this.observer.observe(this.scroll)
    }
  }

  /** `mounted` runs once the new document's pages exist (text is readable), before any page has been painted. */
  async show(bytes: Uint8Array, mounted?: () => void): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    await this.reset()
    if (this.disposed || generation !== this.generation) return
    // PDF.js 6 removed the eval option from its type/API; keep the defensive value plus the HTML CSP.
    const options = { data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, disableAutoFetch: true, disableStream: true }
    try {
      const loading = getDocument(options)
      this.loading = loading
      const document = await loading.promise
      if (generation !== this.generation || this.disposed) return
      if (!Number.isInteger(document.numPages) || document.numPages < 1 || document.numPages > PDF_PREVIEW_LIMITS.pages) throw new Error(`PDF 页数超出预览上限（${PDF_PREVIEW_LIMITS.pages} 页）`)
      this.document = document
      this.page = 1; this.ratio = Math.SQRT2; this.lastError = ''
      this.mount(document.numPages)
      element('pdf-empty').hidden = true
      this.documentChanged()
      try { mounted?.() } catch { /* A listener must not turn a loaded preview into a failed one. */ }
      await this.schedule()
    } catch (error) {
      if (generation === this.generation && !this.disposed) {
        this.report(error)
        await this.reset()
        if (generation !== this.generation || this.disposed) return
        element('pdf-empty').hidden = false
        text('pdf-position', '预览失败')
        throw new Error(`PDF 预览失败：${readableError(error)}`)
      }
    }
  }

  async move(delta: number): Promise<void> {
    if (!this.document || !this.scroll || this.disposed || !Number.isFinite(delta)) return
    this.updatePosition()
    const next = Math.max(1, Math.min(this.slots.length, this.page + Math.trunc(delta)))
    const slot = this.slots[next - 1]
    if (!slot) return
    this.scroll.scrollTop = Math.max(0, slot.top - PADDING)
    await this.schedule()
  }

  async scale(delta: number): Promise<void> {
    if (!this.document || this.disposed || !Number.isFinite(delta)) return
    const next = Math.max(.5, Math.min(2, Math.round((this.zoom + delta) * 100) / 100))
    if (next === this.zoom) return
    this.zoom = next
    this.renderVersion++
    if (this.drawing) this.release(this.drawing.slot)
    this.layout()
    await this.schedule()
  }

  /** Jumps to a SyncTeX PDF location (refining to the exact word bounding box when available) and shows a focus highlight. */
  async jumpTo(target: SyncTexTarget, word?: string): Promise<void> {
    const owner = this.document, scroll = this.scroll
    if (!owner || !scroll || this.disposed || target.page < 1 || target.page > this.slots.length) return
    const slot = this.slots[target.page - 1]
    if (!slot) return
    await this.ensurePageDimensions(owner, slot)
    if (owner !== this.document || this.disposed || !slot.baseWidth || !slot.baseHeight) return
    const refined = word ? await this.refineTargetWord(owner, slot, target, word) : target
    if (owner !== this.document || this.disposed || !slot.baseWidth || !slot.baseHeight) return
    const scaleX = slot.width / slot.baseWidth, scaleY = slot.height / slot.baseHeight
    const cssX = Math.max(0, refined.x * scaleX - 3), cssY = Math.max(0, refined.y * scaleY - 2)
    const cssW = Math.max(24, refined.width * scaleX + 6), cssH = Math.max(16, refined.height * scaleY + 4)
    this.scrollToBox(scroll, slot, cssX, cssY, cssW)
    this.showHighlight(slot, [{ x: cssX, y: cssY, width: cssW, height: cssH }])
    await this.schedule()
  }

  /** Scrolls to a comment's text (PDF points, one rect per line) and flashes every line the same temporary way
   * as a SyncTeX jump; nothing stays on the page afterwards. `flash` false only scrolls (a search hit has its own mark).
   */
  async reveal(page: number, rects: readonly { x: number; y: number; width: number; height: number }[], flash = true): Promise<void> {
    const owner = this.document, scroll = this.scroll, slot = this.slots[page - 1]
    if (!owner || !scroll || !slot || this.disposed || !rects.length) return
    await this.ensurePageDimensions(owner, slot)
    if (owner !== this.document || this.disposed || !slot.baseWidth || !slot.baseHeight) return
    const scaleX = slot.width / slot.baseWidth, scaleY = slot.height / slot.baseHeight
    const boxes = rects.map(rect => ({ x: Math.max(0, rect.x * scaleX - 2), y: Math.max(0, rect.y * scaleY - 2),
      width: rect.width * scaleX + 4, height: rect.height * scaleY + 4 }))
    this.scrollToBox(scroll, slot, boxes[0]!.x, boxes[0]!.y, boxes[0]!.width)
    if (flash) this.showHighlight(slot, boxes)
    await this.schedule()
  }

  private scrollToBox(scroll: HTMLElement, slot: PageSlot, cssX: number, cssY: number, cssW: number): void {
    scroll.scrollTop = Math.max(0, slot.top + cssY - (scroll.clientHeight || 800) * 0.42)
    const pageLeft = slot.node.offsetLeft ?? 0
    if (scroll.scrollWidth > scroll.clientWidth + 1) {
      const targetLeft = pageLeft + cssX
      if (targetLeft < scroll.scrollLeft || targetLeft + cssW > scroll.scrollLeft + scroll.clientWidth) {
        scroll.scrollLeft = Math.max(0, targetLeft + cssW / 2 - scroll.clientWidth / 2)
      }
    }
  }

  private async refineTargetWord(owner: PDFDocumentProxy, slot: PageSlot, target: SyncTexTarget, word: string): Promise<SyncTexTarget> {
    if (!word) return target
    const page = await owner.getPage(slot.number)
    try {
      if (owner !== this.document || this.disposed || typeof page.getTextContent !== 'function') return target
      const base = page.getViewport({ scale: 1 })
      if (typeof base.convertToViewportPoint !== 'function') return target
      const { items, styles } = await page.getTextContent()
      if (owner !== this.document || this.disposed) return target
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const exactRegex = new RegExp(`(?<![A-Za-z0-9_\\u4e00-\\u9fff])${escaped}(?![A-Za-z0-9_\\u4e00-\\u9fff])`, 'gi')
      let best: { box: SyncTexTarget; score: number } | null = null
      for (const entry of items) {
        if (!('str' in entry) || !entry.str || !Array.isArray(entry.transform) || entry.transform.length < 6) continue
        const tx = entry.transform[4]!, ty = entry.transform[5]!, len = entry.str.length
        const itemH = Math.max(entry.height || 0, Math.hypot(entry.transform[2]!, entry.transform[3]!), 10)
        const [vx1, vy1] = base.convertToViewportPoint(tx, ty)
        const [vx2, vy2] = base.convertToViewportPoint(tx + (entry.width || 0), ty + itemH)
        const left = Math.min(vx1!, vx2!), top = Math.min(vy1!, vy2!)
        const width = Math.abs(vx2! - vx1!), height = Math.max(10, Math.abs(vy2! - vy1!))
        if (Math.abs(top - target.y) > 72) continue
        let edges: ArrayLike<number> | null | undefined
        for (const match of entry.str.matchAll(exactRegex)) {
          const idx = match.index ?? 0
          // Measured character positions (counted per code point) when available; equal widths otherwise.
          if (edges === undefined) edges = this.measure.edges({ str: entry.str, x: left, y: top, width, height, ...runFont(entry, styles) })
          const first = edges ? [...entry.str.slice(0, idx)].length : 0, last = edges ? first + [...match[0]].length : 0
          const subX = left + (edges ? edges[first]! : idx / len) * width
          const subW = Math.max(12, (edges ? edges[last]! - edges[first]! : match[0].length / len) * width)
          const score = Math.abs(top - target.y) * 4 + Math.abs(subX - target.x) * 0.35
          if (!best || score < best.score) {
            best = { score, box: { page: target.page, x: subX, y: top, width: subW, height } }
          }
        }
      }
      return best ? best.box : target
    } catch { return target } finally { page.cleanup() }
  }

  /** A stable per-page element drawn between the page bitmap and the text layer; one provider per named layer
   * (comment highlights, search hits).
   */
  setOverlay(provider: ((page: number) => HTMLElement | null) | null, layer = 'comments'): void {
    if (provider) this.overlays.set(layer, provider); else this.overlays.delete(layer)
    for (const slot of this.slots) if (slot.canvas) slot.node.replaceChildren(...this.slotChildren(slot))
  }

  /** Runs when a document's pages become readable and again when the document goes away. */
  setDocumentListener(listener: (() => void) | null): void { this.documentListener = listener }
  /** A failing listener is reported but must not turn a loaded preview into a failed one. */
  private documentChanged(): void { try { this.documentListener?.() } catch (error) { if (!this.disposed) this.notify(readableError(error)) } }

  /** Runs each time a page has been painted; by then the fonts that page uses are loaded, so text on it can be
   * measured exactly. Returns the function that removes the listener.
   */
  onPageRendered(listener: (page: number) => void): () => void {
    this.pageListeners.add(listener)
    return () => { this.pageListeners.delete(listener) }
  }
  private pageRendered(page: number): void {
    this.measure.fontsChanged()
    for (const listener of [...this.pageListeners]) {
      try { listener(page) } catch (error) { this.listenerFailed(error) }
    }
  }
  /** Reported once per document: a listener that keeps failing must not raise a notice on every painted page. */
  private listenerFailed(error: unknown): void {
    const message = readableError(error)
    if (this.disposed || message === this.lastListenerError) return
    this.lastListenerError = message
    this.notify(message)
  }

  get pageCount(): number { return this.document ? this.slots.length : 0 }
  /** The page at the top of the visible area (1-based). */
  get currentPage(): number { return this.page }

  /** Page size in PDF points once known (measured on demand). */
  async pageSize(pageNumber: number): Promise<{ width: number; height: number } | null> {
    const owner = this.document, slot = this.slots[pageNumber - 1]
    if (!owner || !slot || this.disposed) return null
    await this.ensurePageDimensions(owner, slot)
    return owner === this.document && slot.baseWidth && slot.baseHeight ? { width: slot.baseWidth, height: slot.baseHeight } : null
  }

  /** Cached per document; null when the page has no readable text or the document changed meanwhile. */
  async pageText(pageNumber: number): Promise<PdfPageText | null> {
    const owner = this.document
    if (!owner || this.disposed || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.slots.length) return null
    let task = this.texts.get(pageNumber)
    if (!task) {
      // A failed read is not remembered, so a later comment placement or search can try the page again.
      const reading: Promise<PdfPageText | null> = this.readPageText(owner, pageNumber).catch(() => {
        if (this.texts.get(pageNumber) === reading) this.texts.delete(pageNumber)
        return null
      })
      task = reading; this.texts.set(pageNumber, task)
    }
    const result = await task
    return owner === this.document && !this.disposed ? result : null
  }

  private async readPageText(owner: PDFDocumentProxy, pageNumber: number): Promise<PdfPageText | null> {
    const page = await owner.getPage(pageNumber)
    try {
      if (typeof page.getTextContent !== 'function') return null
      const base = page.getViewport({ scale: 1 })
      if (typeof base.convertToViewportPoint !== 'function') return null
      const { items, styles } = await page.getTextContent()
      const result: PdfTextItem[] = []
      for (const entry of items) {
        if (result.length >= MAX_TEXT_ITEMS) break
        if (!('str' in entry) || !entry.str || !Array.isArray(entry.transform) || entry.transform.length < 6) continue
        const tx = entry.transform[4]!, ty = entry.transform[5]!, size = Math.max(entry.height || 0, Math.hypot(entry.transform[2]!, entry.transform[3]!), 1)
        const [x1, y1] = base.convertToViewportPoint(tx, ty - size * 0.22), [x2, y2] = base.convertToViewportPoint(tx + (entry.width || 0), ty + size * 0.9)
        if (![x1, y1, x2, y2].every(value => Number.isFinite(value))) continue
        result.push({ str: entry.str, x: Math.min(x1!, x2!), y: Math.min(y1!, y2!), width: Math.abs(x2! - x1!), height: Math.abs(y2! - y1!), ...runFont(entry, styles) })
      }
      return { width: base.width, height: base.height, items: result }
    } finally { page.cleanup() }
  }

  private slotChildren(slot: PageSlot): Node[] {
    const nodes: Node[] = []
    if (slot.canvas) nodes.push(slot.canvas)
    if (slot.canvas) for (const provider of this.overlays.values()) {
      const overlay = provider(slot.number)
      if (overlay) nodes.push(overlay)
    }
    if (slot.textNode) nodes.push(slot.textNode)
    if (this.highlightSlot === slot) nodes.push(...this.highlights)
    return nodes
  }

  private async resolveAndNotifyDoubleClick(owner: PDFDocumentProxy, slot: PageSlot, pageNumber: number,
    rx: number, ry: number, word?: string): Promise<void> {
    await this.ensurePageDimensions(owner, slot)
    if (owner !== this.document || this.disposed || !slot.baseWidth || !slot.baseHeight) return
    this.onDoubleClick?.({ page: pageNumber, x: rx * slot.baseWidth, y: ry * slot.baseHeight, ...(word ? { word } : {}) })
  }

  private async ensurePageDimensions(owner: PDFDocumentProxy, slot: PageSlot): Promise<void> {
    if (slot.baseWidth && slot.baseHeight) return
    const page = await owner.getPage(slot.number)
    try {
      if (owner !== this.document || this.disposed) return
      const base = page.getViewport({ scale: 1 })
      const ratio = base.height / base.width
      if (![base.width, base.height].every(value => Number.isFinite(value) && value >= .01 && value <= 10000000) ||
        !Number.isFinite(ratio) || ratio < .01 || ratio > 100) return
      slot.baseWidth = base.width; slot.baseHeight = base.height; slot.ratio = ratio
      if (slot.number === 1) this.ratio = ratio
      this.layout()
    } finally { page.cleanup() }
  }

  /** Temporary focus boxes (CSS px on the page); they fade out and are removed after 3.5 s. */
  private showHighlight(slot: PageSlot, boxes: readonly { x: number; y: number; width: number; height: number }[]): void {
    this.clearHighlight()
    this.highlights = boxes.map(({ x, y, width, height }) => {
      const box = window.document.createElement('div')
      box.className = 'pdf-sync-highlight'; box.setAttribute('aria-hidden', 'true')
      box.style.left = `${x}px`; box.style.top = `${y}px`
      box.style.width = `${width}px`; box.style.height = `${height}px`
      return box
    })
    this.highlightSlot = slot
    slot.node.replaceChildren(...this.slotChildren(slot))
    this.highlightTimer = setTimeout(() => this.clearHighlight(), 3500)
  }

  private clearHighlight(): void {
    if (this.highlightTimer !== null) { clearTimeout(this.highlightTimer); this.highlightTimer = null }
    const shown = this.highlights.length > 0, slot = this.highlightSlot
    this.highlights = []; this.highlightSlot = null
    if (shown && slot) slot.node.replaceChildren(...this.slotChildren(slot))
  }

  private canPanScroll(): boolean {
    return Boolean(this.document && this.scroll && (this.zoom > 1 ||
      this.scroll.scrollWidth > this.scroll.clientWidth + 1 ||
      this.scroll.scrollHeight > this.scroll.clientHeight + 1))
  }

  private syncModifier(ctrl: boolean): void {
    if (this.ctrlPressed === ctrl) return
    this.ctrlPressed = ctrl
    this.updatePanState()
  }

  private updatePanState(): void {
    const canPan = this.canPanScroll()
    this.scroll?.classList?.toggle?.('can-pan', canPan)
    this.scroll?.classList?.toggle?.('ctrl-pan-mode', canPan && this.ctrlPressed)
    if (!canPan || !this.ctrlPressed) { this.pan = null; this.scroll?.classList?.remove?.('is-panning') }
  }

  /** ResizeObserver handles divider/layout changes; exposed for a host's explicit layout fallback. */
  async resize(): Promise<void> {
    if (!this.document || !this.scroll || this.disposed) return
    const width = this.scroll.clientWidth
    if (width > 0 && width !== this.width) { this.invalidate(); this.layout() }
    await this.schedule()
  }

  private mount(count: number): void {
    this.slots = Array.from({ length: count }, (_, index) => {
      const node = window.document.createElement('div')
      node.className = 'pdf-page'; node.dataset.pdfPage = String(index + 1)
      node.setAttribute('role', 'img'); uiAttribute(node, 'aria-label', `PDF 第 ${index + 1} 页`)
      return { node, number: index + 1, top: 0, width: 0, height: 0, baseWidth: null, baseHeight: null,
        ratio: null, canvas: null, textNode: null, textLayer: null, page: null, rendered: -1, failed: -1 }
    })
    this.host.replaceChildren(...this.slots.map(slot => slot.node))
    this.layout()
  }

  private layout(): void {
    const scroll = this.scroll
    if (!scroll || !this.slots.length) return
    const anchor = this.slots[this.indexAt(scroll.scrollTop + PADDING)], oldTop = scroll.scrollTop
    const fraction = anchor?.height ? Math.max(0, (oldTop + PADDING - anchor.top) / anchor.height) : 0
    const oldWidth = parseFloat(this.host.style.width) || scroll.clientWidth
    const horizontal = oldWidth ? (scroll.scrollLeft + scroll.clientWidth / 2) / oldWidth : .5
    this.width = scroll.clientWidth || this.width || 600
    let top = PADDING, widest = 0
    for (const slot of this.slots) {
      const ratio = slot.ratio ?? this.ratio, desired = Math.max(100, this.width - PADDING * 2) * this.zoom
      slot.width = Math.min(desired, PDF_PREVIEW_LIMITS.cssEdge, PDF_PREVIEW_LIMITS.cssEdge / ratio)
      slot.height = slot.width * ratio; slot.top = top
      slot.node.style.width = `${slot.width}px`; slot.node.style.height = `${slot.height}px`
      if (slot.canvas) { slot.canvas.style.width = `${slot.width}px`; slot.canvas.style.height = `${slot.height}px` }
      if (slot.textNode && slot.baseWidth) slot.textNode.style?.setProperty?.('--total-scale-factor', String(slot.width / slot.baseWidth))
      top += slot.height + GAP; widest = Math.max(widest, slot.width)
    }
    this.host.style.width = `${Math.max(this.width, widest + PADDING * 2)}px`
    if (anchor && oldTop >= PADDING) scroll.scrollTop = Math.max(0, anchor.top + fraction * anchor.height - PADDING)
    scroll.scrollLeft = Math.max(0, horizontal * parseFloat(this.host.style.width) - scroll.clientWidth / 2)
    this.updatePosition()
    this.updatePanState()
  }

  private indexAt(y: number): number {
    let low = 0, high = this.slots.length - 1
    while (low < high) {
      const middle = Math.floor((low + high) / 2), slot = this.slots[middle]
      if (slot && slot.top + slot.height + GAP <= y) low = middle + 1
      else high = middle
    }
    return low
  }

  private visible(): PageSlot[] {
    if (!this.scroll || !this.slots.length) return []
    const first = this.indexAt(this.scroll.scrollTop), last = this.indexAt(this.scroll.scrollTop + (this.scroll.clientHeight || 800))
    const selected: PageSlot[] = []
    for (let index = first; index <= last && selected.length < PDF_PREVIEW_LIMITS.canvases; index++) {
      const slot = this.slots[index]; if (slot) selected.push(slot)
    }
    for (const index of [first - 1, last + 1]) {
      const slot = this.slots[index]; if (slot && selected.length < PDF_PREVIEW_LIMITS.canvases) selected.push(slot)
    }
    return selected
  }

  private updatePosition(): void {
    if (!this.document || !this.scroll) return
    this.page = this.indexAt(this.scroll.scrollTop + PADDING) + 1
    text('pdf-position', `${this.page} / ${this.document.numPages} · ${Math.round(this.zoom * 100)}%`)
  }

  private schedule(): Promise<void> {
    const owner = this.document
    if (!owner || this.disposed) return Promise.resolve()
    this.updatePosition()
    const wanted = new Set(this.visible())
    for (const slot of this.slots) if (!wanted.has(slot)) this.release(slot)
    this.pending = true
    if (this.work) return this.work
    const work = this.pump(owner)
    this.work = work
    void work.finally(() => { if (this.work === work) this.work = null }).catch(() => undefined)
    return work
  }

  private async pump(owner: PDFDocumentProxy): Promise<void> {
    while (this.pending && owner === this.document && !this.disposed) {
      this.pending = false
      const version = this.renderVersion
      for (const slot of this.visible()) {
        if (owner !== this.document || this.disposed) return
        if (version !== this.renderVersion) { this.pending = true; break }
        if (slot.rendered === version || slot.failed === version) continue
        try { await this.renderPage(owner, slot, version) } catch (error) {
          if (owner === this.document && version === this.renderVersion) { this.release(slot); slot.failed = version; throw error }
        }
      }
      if (owner !== this.document || this.disposed) return
      this.pending ||= this.visible().some(slot => slot.rendered !== this.renderVersion && slot.failed !== this.renderVersion)
    }
  }

  private async renderPage(owner: PDFDocumentProxy, slot: PageSlot, version: number): Promise<void> {
    const page = await owner.getPage(slot.number)
    if (!this.current(owner, slot, version)) { page.cleanup(); return }
    const base = page.getViewport({ scale: 1 })
    const ratio = base.height / base.width
    if (![base.width, base.height].every(value => Number.isFinite(value) && value >= .01 && value <= 10000000) || !Number.isFinite(ratio) || ratio < .01 || ratio > 100) { page.cleanup(); throw new Error('PDF 页面尺寸无效') }
    slot.baseWidth = base.width; slot.baseHeight = base.height
    slot.ratio = ratio
    if (slot.number === 1) this.ratio = slot.ratio
    this.layout()
    const wanted = new Set(this.visible())
    for (const candidate of this.slots) if (!wanted.has(candidate)) this.release(candidate)
    if (!this.current(owner, slot, version)) { page.cleanup(); return }
    const scale = Math.min(slot.width / base.width * Math.max(1, Math.min(window.devicePixelRatio || 1, 2)),
      Math.sqrt(PDF_PREVIEW_LIMITS.pixelsPerCanvas / (base.width * base.height)), PDF_PREVIEW_LIMITS.canvasEdge / base.width, PDF_PREVIEW_LIMITS.canvasEdge / base.height)
    const viewport = page.getViewport({ scale }), canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height))
    canvas.style.width = `${slot.width}px`; canvas.style.height = `${slot.height}px`
    canvas.setAttribute('aria-hidden', 'true')
    const previousCanvas = slot.canvas, previousPage = slot.page, previousTextLayer = slot.textLayer
    previousTextLayer?.cancel()
    let textNode: HTMLDivElement | null = null
    if (typeof TextLayer === 'function' && (typeof page.streamTextContent === 'function' || typeof page.getTextContent === 'function')) {
      textNode = window.document.createElement('div')
      textNode.className = 'textLayer'
      textNode.style?.setProperty?.('--total-scale-factor', String(slot.width / base.width))
    }
    slot.canvas = canvas; slot.textNode = textNode; slot.textLayer = null; slot.page = page
    slot.node.replaceChildren(...this.slotChildren(slot))
    if (previousCanvas) { previousCanvas.width = 0; previousCanvas.height = 0 }
    previousPage?.cleanup()
    const drawing: Drawing = { slot, page, canvas, task: page.render({ canvas, viewport }) }
    this.drawing = drawing
    try {
      await drawing.task.promise
      if (this.current(owner, slot, version)) {
        slot.rendered = version
        this.pageRendered(slot.number)
        if (textNode && typeof TextLayer === 'function') {
          const cssViewport = page.getViewport({ scale: slot.width / base.width })
          const textSource = typeof page.streamTextContent === 'function' ? page.streamTextContent() : await page.getTextContent()
          if (this.current(owner, slot, version) && slot.textNode === textNode) {
            const layer = new TextLayer({ textContentSource: textSource, container: textNode, viewport: cssViewport })
            slot.textLayer = layer
            try { await layer.render() } catch { if (this.current(owner, slot, version)) { slot.textLayer = null } }
          }
        }
      }
    } catch (error) { if (this.current(owner, slot, version)) throw error } finally {
      if (this.drawing === drawing) this.drawing = null
      if (!this.current(owner, slot, version) || slot.rendered !== version) {
        if (slot.canvas === canvas) {
          slot.textLayer?.cancel(); slot.textLayer = null; slot.textNode = null
          slot.canvas = null; slot.page = null; slot.node.replaceChildren(...this.slotChildren(slot))
        }
        canvas.width = 0; canvas.height = 0; page.cleanup()
      }
    }
  }

  private current(owner: PDFDocumentProxy, slot: PageSlot, version: number): boolean {
    return !this.disposed && owner === this.document && version === this.renderVersion && this.visible().includes(slot)
  }

  private release(slot: PageSlot): void {
    const canvas = slot.canvas, page = slot.page, textLayer = slot.textLayer
    if (!canvas && !page && !textLayer && !slot.textNode && this.drawing?.slot !== slot) return
    textLayer?.cancel()
    slot.canvas = null; slot.textNode = null; slot.textLayer = null; slot.page = null; slot.rendered = -1
    slot.node.replaceChildren(...this.slotChildren(slot))
    if (this.drawing?.slot === slot) { this.drawing.task.cancel(); return }
    if (canvas) { canvas.width = 0; canvas.height = 0 }
    page?.cleanup()
  }

  private invalidate(): void {
    this.renderVersion++
    for (const slot of this.slots) this.release(slot)
  }

  private reset(): Promise<void> {
    const loading = this.loading, drawing = this.drawing
    this.clearHighlight()
    this.texts.clear()
    this.measure.reset()
    this.lastListenerError = ''
    this.renderVersion++; this.pending = false
    for (const slot of this.slots) this.release(slot)
    this.loading = null; this.document = null; this.drawing = null; this.work = null; this.slots = []; this.width = 0
    this.pan = null
    this.host.replaceChildren(); this.host.style.width = ''
    this.updatePanState()
    this.documentChanged()
    if (this.scroll) { this.scroll.scrollTop = 0; this.scroll.scrollLeft = 0 }
    this.retirement = this.retirement.then(async () => {
      const results = await Promise.allSettled([loading ? Promise.resolve().then(() => loading.destroy()) : Promise.resolve(), drawing?.task.promise ?? Promise.resolve()])
      if (drawing) { drawing.canvas.width = 0; drawing.canvas.height = 0; drawing.page.cleanup() }
      const destruction = results[0]
      if (destruction?.status === 'rejected') throw destruction.reason
    })
    return this.retirement
  }

  private report(error: unknown): void {
    if (this.disposed) return
    const message = `PDF 预览失败：${readableError(error)}`
    if (message !== this.lastError) { this.lastError = message; this.notify(message) }
  }

  async clear(): Promise<void> {
    this.generation++
    this.zoom = 1
    const cleanup = this.reset()
    element('pdf-empty').hidden = false
    text('pdf-position', '尚未编译')
    await cleanup
  }

  async dispose(): Promise<void> {
    if (this.disposed) { await this.retirement; return }
    this.disposed = true
    this.pan = null
    this.clearHighlight()
    this.scroll?.removeEventListener('scroll', this.onScroll)
    this.scroll?.removeEventListener('wheel', this.onWheel)
    this.scroll?.removeEventListener('pointerdown', this.onPointerDown)
    this.scroll?.removeEventListener('dblclick', this.onDblClick)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyChange)
    window.removeEventListener('keyup', this.onKeyChange)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('resize', this.onResize)
    this.observer?.disconnect(); this.observer = null
    await this.clear()
  }
}
