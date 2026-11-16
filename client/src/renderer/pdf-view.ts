/// <reference types="vite/client" />
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './pdf-preview-style.css'
import { element, text } from './dom'
import { readableError } from './editor-model'
import { uiAttribute } from './i18n-dom'

GlobalWorkerOptions.workerSrc = workerUrl

export const PDF_PREVIEW_LIMITS = Object.freeze({ pages: 2000, canvases: 5, pixelsPerCanvas: 3000000, canvasEdge: 8192, cssEdge: 16000 })
const PADDING = 24, GAP = 16
interface PageSlot {
  node: HTMLDivElement; number: number; top: number; width: number; height: number
  ratio: number | null; canvas: HTMLCanvasElement | null; page: PDFPageProxy | null; rendered: number; failed: number
}
interface Drawing { slot: PageSlot; page: PDFPageProxy; canvas: HTMLCanvasElement; task: RenderTask }

/** Canvas-only, continuously scrollable preview. Never creates PDF text/annotation/script/link layers. */
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
  private host = element('pdf-pages')
  private scroll = this.host.closest<HTMLElement>('.pdf-scroll')
  private observer: ResizeObserver | null = null
  private onScroll = (): void => { void this.schedule().catch(error => this.report(error)) }
  private onResize = (): void => { void this.resize().catch(error => this.report(error)) }

  constructor(private notify: (message: string) => void) {
    if (!this.scroll) throw new Error('缺少 PDF 滚动容器')
    this.host.classList.add('pdf-page-stack')
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true })
    window.addEventListener('resize', this.onResize)
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this.onResize)
      this.observer.observe(this.scroll)
    }
  }

  async show(bytes: Uint8Array): Promise<void> {
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
      this.page = 1; this.zoom = 1; this.ratio = Math.SQRT2; this.lastError = ''
      this.mount(document.numPages)
      element('pdf-empty').hidden = true
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
    this.invalidate()
    this.layout()
    await this.schedule()
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
      return { node, number: index + 1, top: 0, width: 0, height: 0, ratio: null, canvas: null, page: null, rendered: -1, failed: -1 }
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
      top += slot.height + GAP; widest = Math.max(widest, slot.width)
    }
    this.host.style.width = `${Math.max(this.width, widest + PADDING * 2)}px`
    if (anchor && oldTop >= PADDING) scroll.scrollTop = Math.max(0, anchor.top + fraction * anchor.height - PADDING)
    scroll.scrollLeft = Math.max(0, horizontal * parseFloat(this.host.style.width) - scroll.clientWidth / 2)
    this.updatePosition()
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
    slot.canvas = canvas; slot.page = page; slot.node.replaceChildren(canvas)
    const drawing: Drawing = { slot, page, canvas, task: page.render({ canvas, viewport }) }
    this.drawing = drawing
    try {
      await drawing.task.promise
      if (this.current(owner, slot, version)) slot.rendered = version
    } catch (error) { if (this.current(owner, slot, version)) throw error } finally {
      if (this.drawing === drawing) this.drawing = null
      if (!this.current(owner, slot, version) || slot.rendered !== version) {
        if (slot.canvas === canvas) { slot.canvas = null; slot.page = null; slot.node.replaceChildren() }
        canvas.width = 0; canvas.height = 0; page.cleanup()
      }
    }
  }

  private current(owner: PDFDocumentProxy, slot: PageSlot, version: number): boolean {
    return !this.disposed && owner === this.document && version === this.renderVersion && this.visible().includes(slot)
  }

  private release(slot: PageSlot): void {
    const canvas = slot.canvas, page = slot.page
    if (!canvas && !page && this.drawing?.slot !== slot) return
    slot.canvas = null; slot.page = null; slot.rendered = -1; slot.node.replaceChildren()
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
    this.renderVersion++; this.pending = false
    for (const slot of this.slots) this.release(slot)
    this.loading = null; this.document = null; this.drawing = null; this.work = null; this.slots = []; this.width = 0
    this.host.replaceChildren(); this.host.style.width = ''
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
    const cleanup = this.reset()
    element('pdf-empty').hidden = false
    text('pdf-position', '尚未编译')
    await cleanup
  }

  async dispose(): Promise<void> {
    if (this.disposed) { await this.retirement; return }
    this.disposed = true
    this.scroll?.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    this.observer?.disconnect(); this.observer = null
    await this.clear()
  }
}
