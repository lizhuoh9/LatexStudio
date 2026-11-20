/// <reference lib="dom" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const api = vi.hoisted(() => ({ getDocument: vi.fn(), worker: { workerSrc: '' }, element: vi.fn(), text: vi.fn() }))
vi.mock('pdfjs-dist', () => ({ getDocument: api.getDocument, GlobalWorkerOptions: api.worker, TextLayer: null }))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'owned-fixture-worker' }))
vi.mock('../src/renderer/dom', () => ({ element: api.element, text: api.text }))
import { PdfPreview, PDF_PREVIEW_LIMITS } from '../src/renderer/pdf-view'

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
class NodeMock {
  hidden = false; textContent = ''; className = ''; width = 0; height = 0
  clientWidth = 640; clientHeight = 700; scrollWidth = 640; scrollHeight = 700; scrollTop = 0; scrollLeft = 0; offsetLeft = 0
  style: Record<string, string> = {}; dataset: Record<string, string> = {}; attributes = new Map<string, string>()
  children: NodeMock[] = []; handlers = new Map<string, Set<(event?: unknown) => void>>()
  rect = { left: 0, top: 0, width: 600, height: 800 }
  classSet = new Set<string>()
  classList = {
    add: (name: string) => { this.classSet.add(name); this.className = [...this.classSet].join(' ') },
    remove: (name: string) => { this.classSet.delete(name); this.className = [...this.classSet].join(' ') },
    toggle: (name: string, force?: boolean) => {
      const next = force ?? !this.classSet.has(name)
      if (next) this.classSet.add(name); else this.classSet.delete(name)
      this.className = [...this.classSet].join(' '); return next
    }
  }
  constructor(readonly tagName: string) {}
  closest(selector?: string): NodeMock | null {
    return selector === '.pdf-page' && (this.classSet.has('pdf-page') || this.className.split(/\s+/).includes('pdf-page')) ? this : scroller
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.classSet.has('pdf-page') || this.className.split(/\s+/).includes('pdf-page')
      ? { left: 20, top: 24, width: parseFloat(this.style.width || '600'), height: parseFloat(this.style.height || '800') }
      : { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }
  }
  replaceChildren(...nodes: NodeMock[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(name: string, listener: (event?: unknown) => void): void {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set())
    this.handlers.get(name)!.add(listener)
  }
  removeEventListener(name: string, listener: (event?: unknown) => void): void { this.handlers.get(name)?.delete(listener) }
  emit(name: string, event?: unknown): void { for (const listener of this.handlers.get(name) ?? []) listener(event) }
  set innerHTML(_value: string) { throw new Error('PDF data must never become markup') }
}
let host: NodeMock, scroller: NodeMock, empty: NodeMock, position: NodeMock, browser: NodeMock
let preview: PdfPreview | null, resizeCallback: (() => void) | undefined
let surfaces: NodeMock[], notify: Mock<(message: string) => void>, disconnect: Mock<() => void>
const flush = async (): Promise<void> => { for (let i = 0; i < 100; i++) await Promise.resolve() }
function source(count = 12, width = 600, height = 800) {
  const renderGates: Deferred<void>[] = [], pages = new Map<number, ReturnType<typeof createPage>>()
  const tasks: { promise: Promise<void>; cancel: Mock<() => void> }[] = []
  let concurrent = 0, peak = 0
  function createPage(number: number) {
    return { number, cleanup: vi.fn(), getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: width * scale, height: height * scale })),
      render: vi.fn(() => {
        const gate = renderGates.shift(), promise = gate?.promise ?? Promise.resolve()
        concurrent++; peak = Math.max(peak, concurrent)
        void promise.then(() => { concurrent-- }, () => { concurrent-- })
        const task = { promise, cancel: vi.fn(() => gate?.reject(new Error('canceled render'))) }
        tasks.push(task); return task
      }) }
  }
  const page = (number: number) => { if (!pages.has(number)) pages.set(number, createPage(number)); return pages.get(number)! }
  const document = { numPages: count, getPage: vi.fn(async (number: number) => page(number)) }
  const loading = { promise: Promise.resolve(document), destroy: vi.fn(async (): Promise<void> => {}) }
  return { document, loading, page, pages, tasks, renderGates, peak: () => peak }
}
beforeEach(() => {
  surfaces = []; preview = null; resizeCallback = undefined; notify = vi.fn(); disconnect = vi.fn()
  host = new NodeMock('div'); scroller = new NodeMock('div'); empty = new NodeMock('div'); position = new NodeMock('span'); browser = new NodeMock('window')
  const nodes = new Map([['pdf-pages', host], ['pdf-empty', empty], ['pdf-position', position]])
  api.getDocument.mockReset(); api.element.mockImplementation((id: string) => nodes.get(id))
  api.text.mockImplementation((id: string, value: string) => { if (id === 'pdf-position') position.textContent = value })
  vi.stubGlobal('window', { document: { createElement: (tag: string) => { const node = new NodeMock(tag); if (tag === 'canvas') surfaces.push(node); return node } },
    devicePixelRatio: 2, addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallback = callback }
    observe = vi.fn()
    disconnect = disconnect
  })
})
afterEach(async () => { await preview?.dispose().catch(() => undefined); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function open(count = 12) {
  const pdf = source(count); api.getDocument.mockReturnValue(pdf.loading)
  preview = new PdfPreview(notify); await preview.show(new Uint8Array([1, 2, 3]))
  return pdf
}
const live = () => surfaces.filter(canvas => canvas.width > 0 && canvas.height > 0)
const totalPixels = () => live().reduce((sum, canvas) => sum + canvas.width * canvas.height, 0)

describe('continuous local canvas PDF preview', () => {
  it('keeps a continuous stack of page shells while lazily rendering only nearby pages', async () => {
    const pdf = await open(120)
    expect(host.children).toHaveLength(120)
    expect(host.children.map(node => node.dataset.pdfPage)).toEqual(Array.from({ length: 120 }, (_, i) => String(i + 1)))
    expect(live().length).toBeGreaterThan(0); expect(live().length).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvases)
    expect(pdf.document.getPage.mock.calls.length).toBeLessThan(10)
    expect(host.children[0]?.attributes.get('aria-label')).toBe('PDF 第 1 页')
    expect(position.textContent).toBe('1 / 120 · 100%'); expect(empty.hidden).toBe(true)
  })
  it('fills newly visible pages when the first landscape page changes the initial height estimate', async () => {
    const pdf = source(40, 800, 300); api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    await preview.show(new Uint8Array([1]))
    expect(host.children[3]?.children[0]?.tagName).toBe('canvas')
    expect(live().length).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvases)
    expect(pdf.document.getPage.mock.calls.length).toBeLessThan(10)
  })
  it('updates the current-page indicator on vertical scroll and releases old offscreen bitmaps', async () => {
    const pdf = await open(120), old = [...live()]
    const height = parseFloat(host.children[0]!.style.height!)
    scroller.scrollTop = 24 + (height + 16) * 60; scroller.emit('scroll'); await flush()
    expect(position.textContent).toContain('61 / 120')
    expect(pdf.document.getPage.mock.calls.some(([number]) => number >= 60)).toBe(true)
    expect(old.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true)
    expect(live().length).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvases)
  })
  it('page buttons scroll the existing stack rather than replacing it with a single page', async () => {
    await open(8); const shells = [...host.children]
    await preview!.move(1); expect(position.textContent).toContain('2 / 8'); expect(scroller.scrollTop).toBeGreaterThan(0)
    await preview!.move(10000); expect(position.textContent).toContain('8 / 8')
    await preview!.move(-10000); expect(position.textContent).toContain('1 / 8')
    expect(host.children).toEqual(shells)
  })
  it('makes plus/minus zoom change actual page dimensions without compounding scroll-content width', async () => {
    await open(8); const normal = parseFloat(host.children[0]!.style.width!)
    await preview!.scale(.1); expect(parseFloat(host.children[0]!.style.width!)).toBeCloseTo(normal * 1.1)
    expect(parseFloat(host.style.width!)).toBeGreaterThan(scroller.clientWidth)
    await preview!.scale(.1); expect(parseFloat(host.children[0]!.style.width!)).toBeCloseTo(normal * 1.2)
    await preview!.scale(-.2); expect(parseFloat(host.children[0]!.style.width!)).toBeCloseTo(normal)
    expect(position.textContent).toContain('100%')
    await preview!.scale(100); expect(position.textContent).toContain('200%')
    await preview!.scale(-100); expect(position.textContent).toContain('50%')
    await preview!.scale(Number.NaN); await preview!.move(Infinity); expect(position.textContent).toContain('50%')
  })
  it('supports Ctrl/Meta + wheel zooming inside the PDF scroller', async () => {
    await open(4)
    const prevent = vi.fn()
    scroller.emit('wheel', { ctrlKey: true, metaKey: false, deltaY: -120, preventDefault: prevent }); await flush()
    expect(prevent).toHaveBeenCalledTimes(1); expect(position.textContent).toContain('110%')
    scroller.emit('wheel', { ctrlKey: false, metaKey: true, deltaY: 120, preventDefault: prevent }); await flush()
    expect(prevent).toHaveBeenCalledTimes(2); expect(position.textContent).toContain('100%')
    scroller.emit('wheel', { ctrlKey: false, metaKey: false, deltaY: -120, preventDefault: prevent }); await flush()
    expect(prevent).toHaveBeenCalledTimes(2); expect(position.textContent).toContain('100%')
  })
  it('observes divider/container resize and preserves the current page when refitting', async () => {
    await open(20); await preview!.move(5); expect(position.textContent).toContain('6 / 20')
    const old = [...live()], width = parseFloat(host.children[0]!.style.width!)
    scroller.clientWidth = 400; resizeCallback?.(); await flush()
    expect(parseFloat(host.children[0]!.style.width!)).toBeLessThan(width)
    expect(position.textContent).toContain('6 / 20'); expect(old.every(canvas => canvas.width === 0)).toBe(true)
    expect(live().length).toBeGreaterThan(0)
  })
  it('bounds canvas count and aggregate pixels across a large page count and huge display/zoom', async () => {
    scroller.clientWidth = 14000; await open(PDF_PREVIEW_LIMITS.pages)
    await preview!.scale(1)
    for (const target of [40, 300, 900, 1500]) {
      await preview!.move(target)
      expect(live().length).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvases)
      expect(totalPixels()).toBeLessThanOrEqual(PDF_PREVIEW_LIMITS.canvases * PDF_PREVIEW_LIMITS.pixelsPerCanvas)
      expect(live().every(canvas => canvas.width <= PDF_PREVIEW_LIMITS.canvasEdge && canvas.height <= PDF_PREVIEW_LIMITS.canvasEdge)).toBe(true)
    }
  })
  it('cancels an active render on zoom and serializes its replacement', async () => {
    const pdf = source(8), gate = deferred<void>(); pdf.renderGates.push(gate)
    api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    const showing = preview.show(new Uint8Array([1])); await flush()
    expect(pdf.tasks).toHaveLength(1)
    await preview.scale(.1); await showing
    expect(pdf.tasks[0]?.cancel).toHaveBeenCalled(); expect(pdf.peak()).toBe(1)
    expect(position.textContent).toContain('110%'); expect(notify).not.toHaveBeenCalled()
  })
  it('clear cancels and drains active work, destroys the document owner and zeros all surfaces', async () => {
    const pdf = source(8), gate = deferred<void>(); pdf.renderGates.push(gate)
    api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    const showing = preview.show(new Uint8Array([1])); await flush(); await preview.clear(); await showing
    expect(pdf.tasks[0]?.cancel).toHaveBeenCalled(); expect(pdf.loading.destroy).toHaveBeenCalledOnce()
    expect(live()).toHaveLength(0); expect(host.children).toHaveLength(0)
    expect(empty.hidden).toBe(false); expect(position.textContent).toBe('尚未编译'); expect(notify).not.toHaveBeenCalled()
  })
  it('rejects late old getPage results without changing the replacement document', async () => {
    const old = source(8), waiting = deferred<ReturnType<typeof old.page>>()
    old.document.getPage.mockImplementationOnce(() => waiting.promise)
    api.getDocument.mockReturnValueOnce(old.loading); preview = new PdfPreview(notify)
    const oldShow = preview.show(new Uint8Array([1])); await flush()
    const next = source(2); api.getDocument.mockReturnValue(next.loading)
    await preview.show(new Uint8Array([2])); waiting.resolve(old.page(1)); await oldShow; await flush()
    expect(host.children).toHaveLength(2); expect(position.textContent).toContain('1 / 2')
    expect(old.page(1).cleanup).toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled()
  })
  it('does not start a superseded load after asynchronous destruction finishes', async () => {
    const old = source(2), destroy = deferred<void>(), load = deferred<typeof old.document>()
    old.loading.promise = load.promise; old.loading.destroy.mockImplementation(() => destroy.promise)
    api.getDocument.mockReturnValueOnce(old.loading); preview = new PdfPreview(notify)
    const first = preview.show(new Uint8Array([1])); await flush()
    const second = preview.show(new Uint8Array([2])); await flush(); expect(api.getDocument).toHaveBeenCalledOnce()
    const clearing = preview.clear()
    destroy.resolve(); load.resolve(old.document)
    await Promise.all([first, second, clearing])
    expect(api.getDocument).toHaveBeenCalledOnce(); expect(host.children).toHaveLength(0)
    expect(position.textContent).toBe('尚未编译')
  })
  it('rejects oversized documents explicitly instead of allocating unbounded page shells', async () => {
    const pdf = source(PDF_PREVIEW_LIMITS.pages + 1); api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    await expect(preview.show(new Uint8Array([1]))).rejects.toThrow('页数超出')
    expect(host.children).toHaveLength(0); expect(pdf.document.getPage).not.toHaveBeenCalled()
    expect(pdf.loading.destroy).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce()
  })
  it('reports a synchronous PDF.js loading failure without creating remote or fallback content', async () => {
    api.getDocument.mockImplementation(() => { throw new Error('synthetic load failure') }); preview = new PdfPreview(notify)
    await expect(preview.show(new Uint8Array([1]))).rejects.toThrow('synthetic load failure')
    expect(notify).toHaveBeenCalledOnce(); expect(host.children).toHaveLength(0); expect(empty.hidden).toBe(false)
  })
  it('releases a failed active render instead of keeping a failed canvas surface', async () => {
    const pdf = source(1), gate = deferred<void>(); pdf.renderGates.push(gate)
    api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    const showing = preview.show(new Uint8Array([1])); await flush()
    const failure = expect(showing).rejects.toThrow('synthetic drawing failure')
    gate.reject(new Error('synthetic drawing failure')); await failure
    expect(live()).toHaveLength(0); expect(pdf.loading.destroy).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce()
  })
  it('rejects invalid page geometry and never allocates its bitmap', async () => {
    const pdf = source(1); pdf.page(1).getViewport.mockReturnValue({ width: Infinity, height: 800 })
    api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    await expect(preview.show(new Uint8Array([1]))).rejects.toThrow('页面尺寸无效')
    expect(surfaces).toHaveLength(0); expect(notify).toHaveBeenCalledOnce()
  })
  it('makes repeated dispose calls wait for the same outstanding document destruction', async () => {
    const pdf = await open(2), destroy = deferred<void>()
    pdf.loading.destroy.mockImplementation(() => destroy.promise)
    const first = preview!.dispose(); let secondFinished = false
    const second = preview!.dispose().then(() => { secondFinished = true })
    await flush(); expect(secondFinished).toBe(false)
    destroy.resolve(); await Promise.all([first, second])
    expect(secondFinished).toBe(true); expect(pdf.loading.destroy).toHaveBeenCalledOnce()
  })
  it('disconnects observers/listeners and ignores resize/scroll/show after disposal', async () => {
    const pdf = await open(6), calls = pdf.document.getPage.mock.calls.length
    await preview!.dispose(); scroller.emit('scroll'); browser.emit('resize'); resizeCallback?.()
    await preview!.show(new Uint8Array([9])); await preview!.scale(.1); await flush()
    expect(disconnect).toHaveBeenCalledOnce(); expect(scroller.handlers.get('scroll')?.size).toBe(0)
    expect(browser.handlers.get('resize')?.size).toBe(0); expect(pdf.document.getPage).toHaveBeenCalledTimes(calls)
    expect(host.children).toHaveLength(0); expect(live()).toHaveLength(0)
  })
  it('passes local copied bytes and eval/fetch restrictions, with no document scripting or annotation layers', async () => {
    const pdf = source(1), bytes = new Uint8Array([3, 4]); api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify)
    await preview.show(bytes)
    const options = api.getDocument.mock.calls[0]?.[0]
    expect(options.data).not.toBe(bytes); expect(options.data).toEqual(bytes)
    expect(options).toMatchObject({ isEvalSupported: false, disableAutoFetch: true, disableStream: true })
    expect(options).not.toHaveProperty('url')
    expect(host.children.every(node => node.tagName === 'div' && node.children.every(child => child.tagName === 'canvas'))).toBe(true)
    expect(readFileSync('src/renderer/pdf-preview-style.css', 'utf8')).not.toMatch(/@import|@font-face|url\(/)
  })
  it('only pans when holding Ctrl/Meta so plain drag selects words and dblclick jumps cleanly', async () => {
    await open(3); await preview!.scale(.5)
    expect(scroller.classSet.has('can-pan')).toBe(true)
    expect(scroller.classSet.has('ctrl-pan-mode')).toBe(false)
    scroller.scrollLeft = 20; scroller.scrollTop = 40
    // Plain drag without Ctrl/Meta must NOT pan (preserves PDF word/text selection)
    scroller.emit('pointerdown', { button: 0, ctrlKey: false, metaKey: false, pointerId: 1, clientX: 200, clientY: 200 })
    browser.emit('pointermove', { ctrlKey: false, metaKey: false, pointerId: 1, clientX: 120, clientY: 120 })
    expect(scroller.classSet.has('is-panning')).toBe(false)
    expect(scroller.scrollLeft).toBe(20); expect(scroller.scrollTop).toBe(40)
    browser.emit('pointerup', { pointerId: 1 })
    // Holding Ctrl activates pan cursor; tiny < 4px movement stays idle for Ctrl+click
    browser.emit('keydown', { ctrlKey: true, metaKey: false })
    expect(scroller.classSet.has('ctrl-pan-mode')).toBe(true)
    scroller.emit('pointerdown', { button: 0, ctrlKey: true, metaKey: false, pointerId: 2, clientX: 200, clientY: 200 })
    browser.emit('pointermove', { ctrlKey: true, metaKey: false, pointerId: 2, clientX: 202, clientY: 201 })
    expect(scroller.classSet.has('is-panning')).toBe(false)
    expect(scroller.scrollLeft).toBe(20); expect(scroller.scrollTop).toBe(40)
    // Dragging past 4px while holding Ctrl pans smoothly and clears on release
    browser.emit('pointermove', { ctrlKey: true, metaKey: false, pointerId: 2, clientX: 150, clientY: 160 })
    expect(scroller.classSet.has('is-panning')).toBe(true)
    expect(scroller.scrollLeft).toBe(70); expect(scroller.scrollTop).toBe(80)
    browser.emit('pointerup', { pointerId: 2 })
    browser.emit('keyup', { ctrlKey: false, metaKey: false })
    expect(scroller.classSet.has('is-panning')).toBe(false)
    expect(scroller.classSet.has('ctrl-pan-mode')).toBe(false)
  })
  it('translates PDF double-click coordinates into PDF big points and highlights jumpTo targets clearly', async () => {
    const onDbl = vi.fn(), pdf = source(4, 600, 800)
    api.getDocument.mockReturnValue(pdf.loading)
    preview = new PdfPreview(notify, onDbl)
    await preview.show(new Uint8Array([1, 2]))
    await preview.scale(.5)
    const page1 = host.children[0]!
    const renderedWidth = parseFloat(page1.style.width!), renderedHeight = parseFloat(page1.style.height!)
    scroller.emit('dblclick', { target: page1, clientX: 20 + renderedWidth * 0.5, clientY: 24 + renderedHeight * 0.25 })
    await flush()
    expect(onDbl).toHaveBeenCalledOnce()
    expect(onDbl.mock.calls[0]![0]).toMatchObject({ page: 1, x: expect.closeTo(300, 1), y: expect.closeTo(200, 1) })

    await preview.jumpTo({ page: 3, x: 120, y: 320, width: 10, height: 10 })
    expect(position.textContent).toContain('3 / 4')
    const hl = host.children[2]!.children.find(child => child.className.includes('pdf-sync-highlight'))
    expect(hl).toBeDefined()
    expect(parseFloat(hl!.style.width!)).toBeGreaterThanOrEqual(24)
    expect(parseFloat(hl!.style.height!)).toBeGreaterThanOrEqual(16)
  })
  it('refines jumpTo highlight onto the exact matched word when PDF text content is available', async () => {
    const pdf = source(2, 600, 800)
    const page1 = pdf.page(1) as ReturnType<typeof pdf.page> & { getTextContent?: () => Promise<unknown> }
    page1.getViewport = vi.fn(({ scale }: { scale: number }) => ({
      width: 600 * scale,
      height: 800 * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale]
    }))
    page1.getTextContent = vi.fn(async () => ({
      items: [{ str: 'Soft actuators and soft robots', transform: [1, 0, 0, 1, 100, 600], width: 200, height: 12 }]
    }))
    api.getDocument.mockReturnValue(pdf.loading)
    preview = new PdfPreview(notify)
    await preview.show(new Uint8Array([1, 2]))
    await preview.jumpTo({ page: 1, x: 150, y: 190, width: 44, height: 12 }, 'actuators')
    const hl = host.children[0]!.children.find(child => child.className.includes('pdf-sync-highlight'))
    expect(hl).toBeDefined()
    // 'actuators' is chars [5..14] out of 30 in width 200 -> roughly 60bp wide vs full 200bp line
    expect(parseFloat(hl!.style.width!)).toBeLessThan(100)
  })
})

describe('comment support in the PDF preview', () => {
  function withText(pdf: ReturnType<typeof source>, number: number, items: unknown[]): Mock {
    const page = pdf.page(number) as ReturnType<typeof pdf.page> & { getTextContent?: Mock }
    page.getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale] }))
    page.getTextContent = vi.fn(async () => ({ items }))
    return page.getTextContent
  }

  it('draws a stable comment overlay between the page bitmap and the selectable text, only on drawn pages', async () => {
    const overlays = new Map<number, NodeMock>()
    await open(6)
    preview!.setOverlay(page => { if (!overlays.has(page)) overlays.set(page, new NodeMock('div')); return overlays.get(page) as unknown as HTMLElement })
    const drawn = host.children[0]!
    expect(drawn.children[0]?.tagName).toBe('canvas')
    expect(drawn.children[1]).toBe(overlays.get(1))
    expect(host.children[5]!.children).toEqual([])
    await preview!.scale(.1)
    expect(host.children[0]!.children[1]).toBe(overlays.get(1))
    preview!.setOverlay(null)
    expect(host.children[0]!.children.every(child => child.tagName === 'canvas')).toBe(true)
  })

  it('reveals a comment by scrolling to it and flashing every line box temporarily, leaving nothing behind', async () => {
    await open(4)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await preview!.reveal(3, [{ x: 72, y: 300, width: 200, height: 12 }, { x: 72, y: 314, width: 80, height: 12 }])
      const flashes = () => host.children[2]!.children.filter(child => child.className.includes('pdf-sync-highlight'))
      const scale = parseFloat(host.children[2]!.style.width!) / 600
      expect(flashes()).toHaveLength(2)
      expect(parseFloat(flashes()[0]!.style.left!)).toBeCloseTo(72 * scale - 2, 5)
      expect(parseFloat(flashes()[1]!.style.width!)).toBeCloseTo(80 * scale + 4, 5)
      expect(position.textContent).toContain('3 / 4')
      vi.advanceTimersByTime(3600)
      expect(flashes()).toHaveLength(0)
      await preview!.reveal(9, [{ x: 1, y: 1, width: 1, height: 1 }])
      await preview!.reveal(2, [])
      expect(host.children.every(page => page.children.every(child => !child.className.includes('pdf-sync-highlight')))).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('reads page text once per document as top-left boxes in PDF points and forgets it with the document', async () => {
    const pdf = source(3, 600, 800)
    const read = withText(pdf, 2, [{ str: 'Results', transform: [10, 0, 0, 10, 100, 700], width: 40, height: 10 }, { str: '', transform: [1, 0, 0, 1, 0, 0] }, { type: 'beginMarkedContent' }])
    api.getDocument.mockReturnValue(pdf.loading); preview = new PdfPreview(notify); await preview.show(new Uint8Array([1]))
    const text = await preview.pageText(2)
    expect(text).toMatchObject({ width: 600, height: 800 })
    expect(text!.items).toHaveLength(1)
    expect(text!.items[0]).toMatchObject({ str: 'Results', x: 100, width: 40 })
    expect(text!.items[0]!.y).toBeCloseTo(800 - 709, 5)
    expect(text!.items[0]!.height).toBeCloseTo(11.2, 5)
    await preview.pageText(2)
    expect(read).toHaveBeenCalledOnce()
    expect(await preview.pageText(0)).toBeNull(); expect(await preview.pageText(4)).toBeNull()
    expect(await preview.pageSize(2)).toEqual({ width: 600, height: 800 })
    expect(preview.pageCount).toBe(3)
    await preview.show(new Uint8Array([2]))
    await preview.pageText(2)
    expect(read).toHaveBeenCalledTimes(2)
    await preview.clear()
    expect(preview.pageCount).toBe(0); expect(await preview.pageText(1)).toBeNull()
  })
})
