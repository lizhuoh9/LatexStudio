/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { indexPdfPage, indexSource, type PdfTextItem } from '../src/shared/comment-anchor'
import type { SyncTexData } from '../src/shared/synctex'
import { placeComment, type PlacementSources } from '../src/renderer/comment-placement'
import { dehyphenate, PdfCommentInput, type PdfPoint, type PdfSelectionCapture } from '../src/renderer/pdf-selection'

const anchor = { file: 'main.tex', line: 2, endLine: 2, quote: 'strong gains over the baseline', before: '', after: '', page: 1 }
const synctex: SyncTexData = { files: ['main.tex'], nodes: [
  { file: 0, line: 2, page: 1, x: 72, y: 90, width: 300, height: 12, kind: 'leaf' },
  { file: 0, line: 40, page: 2, x: 72, y: 300, width: 300, height: 12, kind: 'leaf' }] }
function sources(pages: Record<number, PdfTextItem[]>, source: string | null, pageCount = 3): PlacementSources & { read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(async (number: number) => pages[number] ? { width: 600, height: 800, index: indexPdfPage(pages[number]!) } : null)
  return { pageCount, synctex, source: async () => source === null ? null : indexSource(source), page: read, read }
}
const line = (str: string, y = 90): PdfTextItem => ({ str, x: 72, y, width: str.length * 6, height: 12 })

describe('placing a comment in the current PDF', () => {
  it('waits for a compiled PDF before judging the position', async () => {
    expect(await placeComment(anchor, sources({}, 'x', 0))).toEqual({ placement: { state: 'pending' }, mark: null })
  })

  it('follows the source to its new line and the PDF page SyncTeX maps it to', async () => {
    const moved = `${'filler\n'.repeat(39)}Our method shows strong gains over the baseline.`
    const placed = await placeComment(anchor, sources({ 2: [line('Our method shows strong gains over the baseline.', 300)] }, moved))
    expect(placed.placement).toMatchObject({ state: 'anchored', page: 2, y: 300 })
    expect(placed.mark).toMatchObject({ page: 2, pageWidth: 600, pageHeight: 800 })
  })

  it('looks on the neighbouring pages when text flowed across a page break', async () => {
    const placed = await placeComment(anchor, sources({ 1: [line('unrelated text')], 2: [line('strong gains over the baseline', 40)] }, 'Our method shows strong gains over the baseline.'))
    expect(placed.placement).toMatchObject({ state: 'anchored', page: 2 })
  })

  it('accepts a partial PDF match only while the source still holds the text', async () => {
    const pdf = { 1: [line('strong gains [3] over the old baseline')] }
    const kept = await placeComment(anchor, sources(pdf, 'Our method shows strong gains over the baseline.'))
    expect(kept.placement.state).toBe('anchored')
    const rewritten = await placeComment(anchor, sources(pdf, 'We now report modest improvements only.'))
    expect(rewritten).toEqual({ placement: { state: 'stale', line: 2 }, mark: null })
  })

  it('keeps an exact PDF match even when the source file is gone, and is lost when neither has it', async () => {
    expect((await placeComment(anchor, sources({ 1: [line('strong gains over the baseline')] }, null))).placement.state).toBe('anchored')
    expect((await placeComment(anchor, sources({ 1: [line('different words')] }, null))).placement).toEqual({ state: 'stale', line: 2 })
  })
})

class Node {
  className = ''; parent: Node | null = null; dataset: Record<string, string> = {}; hidden = true
  style: Record<string, string> = {}; handlers = new Map<string, Set<(event: unknown) => void>>()
  constructor(public nodeType = 1) {}
  get parentElement(): Node | null { return this.parent }
  closest(selector: string): Node | null {
    return selector === `.${this.className}` || this.className.split(' ').includes(selector.slice(1)) ? this : this.parent?.closest(selector) ?? null
  }
  contains(node: Node | null): boolean { for (let current = node; current; current = current.parent) if (current === this) return true; return false }
  getBoundingClientRect(): DOMRect { return { left: 100, top: 50, width: 300, height: 400, right: 400, bottom: 450 } as DOMRect }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
  }
  removeEventListener(type: string, handler: (event: unknown) => void): void { this.handlers.get(type)?.delete(handler) }
  emit(type: string, event: unknown = { preventDefault: vi.fn() }): void { for (const handler of this.handlers.get(type) ?? []) handler(event) }
}
function child(parent: Node, className: string, nodeType = 1): Node { const node = new Node(nodeType); node.className = className; node.parent = parent; return node }

describe('the add-comment button beside a PDF selection', () => {
  let scroll: Node, button: Node, page: Node, text: Node, other: Node, selection: { collapsed: boolean; start: Node; end: Node; text: string }
  let host: { pageSize: () => Promise<{ width: number; height: number }>; enabled: () => boolean;
    comment: Mock<(capture: PdfSelectionCapture) => void>; point: Mock<(page: number, at: PdfPoint) => void> }
  let removeAllRanges: Mock<() => void>, root: Node
  beforeEach(() => {
    vi.useFakeTimers()
    scroll = new Node(); button = new Node()
    page = child(scroll, 'pdf-page'); page.dataset.pdfPage = '3'
    text = child(child(page, 'textLayer'), '', 3)
    const otherPage = child(scroll, 'pdf-page'); otherPage.dataset.pdfPage = '4'; other = child(child(otherPage, 'textLayer'), '', 3)
    selection = { collapsed: false, start: text, end: text, text: 'docu-\nment ready' }
    removeAllRanges = vi.fn()
    const range = { get startContainer() { return selection.start }, get endContainer() { return selection.end },
      getClientRects: () => [{ left: 130, top: 90, width: 60, height: 10, right: 190, bottom: 100 }, { left: 100, top: 104, width: 90, height: 10, right: 190, bottom: 114 }] }
    vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 800, addEventListener: vi.fn(), removeEventListener: vi.fn(),
      getSelection: () => ({ rangeCount: 1, get isCollapsed() { return selection.collapsed }, getRangeAt: () => range, toString: () => selection.text, removeAllRanges }) })
    root = new Node(9)
    vi.stubGlobal('document', root)
    host = { pageSize: vi.fn(async () => ({ width: 600, height: 800 })), enabled: () => true,
      comment: vi.fn<(capture: PdfSelectionCapture) => void>(), point: vi.fn<(page: number, at: PdfPoint) => void>() }
    new PdfCommentInput(scroll as unknown as HTMLElement, button as unknown as HTMLButtonElement, host)
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('appears next to a one-page selection and hands over page coordinates and the dehyphenated text', async () => {
    root.emit('pointerup'); vi.runAllTimers()
    expect(button.hidden).toBe(false)
    expect(button.style).toEqual({ left: '196px', top: '120px' })
    button.emit('click'); await vi.runAllTimersAsync()
    expect(host.comment).toHaveBeenCalledWith({ page: 3, quote: 'document ready', start: { x: 62, y: 90 }, end: { x: 178, y: 118 } })
    expect(removeAllRanges).toHaveBeenCalledOnce()
    expect(button.hidden).toBe(true)
  })

  it('stays hidden for a selection spanning two pages or outside the text layer, and hides on scroll', () => {
    selection.end = other
    root.emit('pointerup'); vi.runAllTimers()
    expect(button.hidden).toBe(true)
    selection.end = text
    root.emit('pointerup'); vi.runAllTimers()
    expect(button.hidden).toBe(false)
    scroll.emit('scroll')
    expect(button.hidden).toBe(true)
  })

  it('turns a plain click into a page point for opening highlighted comments', async () => {
    selection.collapsed = true
    scroll.emit('click', { button: 0, ctrlKey: false, metaKey: false, target: text, clientX: 250, clientY: 250 }); await vi.runAllTimersAsync()
    expect(host.point).toHaveBeenCalledWith(3, { x: 300, y: 400 })
    scroll.emit('click', { button: 0, ctrlKey: true, metaKey: false, target: text, clientX: 250, clientY: 250 }); await vi.runAllTimersAsync()
    expect(host.point).toHaveBeenCalledOnce()
  })

  it('rejoins only lowercase words hyphenated at a line end', () => {
    expect(dehyphenate('docu-\nment and state-of-\nThe-art')).toBe('document and state-of-\nThe-art')
  })
})
