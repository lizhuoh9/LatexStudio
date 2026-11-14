import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { element, text } from './dom'
import { readableError } from './editor-model'

GlobalWorkerOptions.workerSrc = workerUrl

/** Canvas-only preview: no PDF scripts, annotations, remote links or embedded HTML. */
export class PdfPreview {
  private document: PDFDocumentProxy | null = null
  private loading: PDFDocumentLoadingTask | null = null
  private renderTask: RenderTask | null = null
  private generation = 0
  private renderVersion = 0
  private page = 1
  private zoom = 1

  constructor(private notify: (message: string) => void) {}

  async show(bytes: Uint8Array): Promise<void> {
    const generation = ++this.generation
    this.renderTask?.cancel()
    await this.disposeDocument()
    // PDF.js 6 removed the eval option from its type/API; keep the defensive value
    // when passing options, and enforce no unsafe-eval independently in HTML CSP.
    const options = { data: new Uint8Array(bytes), isEvalSupported: false,
      useSystemFonts: true, disableAutoFetch: true, disableStream: true }
    this.loading = getDocument(options)
    const loading = this.loading
    try {
      const document = await loading.promise
      if (generation !== this.generation) { await loading.destroy(); return }
      this.document = document
      this.page = 1; this.zoom = 1
      element('pdf-empty').hidden = true
      await this.render()
    } catch (error) {
      if (generation === this.generation) {
        const message = `PDF 预览失败：${readableError(error)}`
        this.notify(message)
        throw new Error(message)
      }
    }
  }

  async move(delta: number): Promise<void> {
    if (!this.document) return
    this.page = Math.max(1, Math.min(this.document.numPages, this.page + delta))
    await this.render()
  }

  async scale(delta: number): Promise<void> {
    this.zoom = Math.max(0.5, Math.min(2, this.zoom + delta))
    await this.render()
  }

  private async render(): Promise<void> {
    const document = this.document
    if (!document) return
    const version = ++this.renderVersion
    this.renderTask?.cancel()
    const page = await document.getPage(this.page)
    if (version !== this.renderVersion || document !== this.document) return
    const canvas = window.document.createElement('canvas')
    const base = page.getViewport({ scale: 1 })
    const fit = Math.max(100, element('pdf-pages').clientWidth - 36) / base.width
    const scale = Math.min(fit * this.zoom * Math.min(window.devicePixelRatio, 2), Math.sqrt(16000000 / (base.width * base.height)))
    const viewport = page.getViewport({ scale })
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
    canvas.style.width = `${base.width * fit * this.zoom}px`
    canvas.style.height = `${base.height * fit * this.zoom}px`
    canvas.setAttribute('aria-label', `PDF 第 ${this.page} 页`)
    const task = page.render({ canvas, viewport })
    this.renderTask = task
    try { await task.promise } catch (error) {
      if (version === this.renderVersion && document === this.document) throw error
      return
    }
    if (version !== this.renderVersion || document !== this.document) return
    element('pdf-pages').replaceChildren(canvas)
    text('pdf-position', `${this.page} / ${document.numPages} · ${Math.round(this.zoom * 100)}%`)
  }

  private async disposeDocument(): Promise<void> {
    const loading = this.loading
    this.loading = null; this.document = null
    if (loading) await loading.destroy()
  }

  async clear(): Promise<void> {
    this.generation += 1; this.renderVersion += 1
    this.renderTask?.cancel()
    await this.disposeDocument()
    element('pdf-pages').replaceChildren()
    element('pdf-empty').hidden = false
    text('pdf-position', '尚未编译')
  }
}
