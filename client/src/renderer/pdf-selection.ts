export interface PdfPoint { x: number; y: number }
/** A text selection on one PDF page, with its first and last line positions in PDF points. */
export interface PdfSelectionCapture { page: number; quote: string; start: PdfPoint; end: PdfPoint }

export interface PdfCommentInputHost {
  pageSize(page: number): Promise<{ width: number; height: number } | null>
  enabled(): boolean
  comment(capture: PdfSelectionCapture): void
  /** A plain click on a page point; returns whether it opened a comment. */
  point(page: number, at: PdfPoint): void
}

interface Selected { page: number; element: HTMLElement; quote: string; first: DOMRect; last: DOMRect }

function pageOf(node: Node | null): HTMLElement | null {
  const owner = node && (node.nodeType === 1 ? node as Element : node.parentElement)
  return owner?.closest?.<HTMLElement>('.pdf-page') ?? null
}
const inTextLayer = (node: Node | null): boolean => Boolean((node && (node.nodeType === 1 ? node as Element : node.parentElement))?.closest?.('.textLayer'))
/** Rejoins words hyphenated at a line end ("docu-\nment"); other line breaks become spaces when stored. */
export function dehyphenate(text: string): string { return text.replace(/(\p{Ll})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, '$1$2') }

/** Watches plain (non-Ctrl) text selection in the PDF and offers a small "Comment" button next to it.
 * Also turns a plain click into a page point so a highlighted comment can be opened. Never reads PDF links/scripts.
 */
export class PdfCommentInput {
  private readonly cleanups: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly scroll: HTMLElement, private readonly button: HTMLButtonElement, private readonly host: PdfCommentInputHost) {
    // A drag that starts in the PDF may end outside it, so the release is watched on the whole document.
    this.listen(document, 'pointerup', () => this.later())
    this.listen(scroll, 'keyup', () => this.later())
    this.listen(scroll, 'scroll', () => this.hide())
    this.listen(scroll, 'click', event => this.click(event as MouseEvent))
    this.listen(document, 'selectionchange', () => { if (!this.button.hidden && !this.current()) this.hide() })
    this.listen(window, 'resize', () => this.hide())
    this.listen(button, 'pointerdown', event => event.preventDefault())
    this.listen(button, 'click', () => { void this.capture() })
  }

  hide(): void { this.button.hidden = true }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.hide()
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler)
    this.cleanups.push(() => target.removeEventListener(type, handler))
  }

  private later(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const selected = this.host.enabled() ? this.current() : null
      if (selected) this.show(selected); else this.hide()
    }, 0)
  }

  private current(): Selected | null {
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0), element = pageOf(range.startContainer)
    if (!element || element !== pageOf(range.endContainer) || !this.scroll.contains(element) ||
      !inTextLayer(range.startContainer) || !inTextLayer(range.endContainer)) return null
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0.5 && rect.height > 0.5)
    const page = Number(element.dataset.pdfPage), quote = selection.toString()
    if (!rects.length || !Number.isInteger(page) || page < 1 || !quote.trim()) return null
    return { page, element, quote, first: rects[0]!, last: rects[rects.length - 1]! }
  }

  private show(selected: Selected): void {
    const width = window.innerWidth || 800, height = window.innerHeight || 600
    this.button.hidden = false
    const size = this.button.offsetWidth || 110
    this.button.style.left = `${Math.max(8, Math.min(width - size - 8, selected.last.right + 6))}px`
    this.button.style.top = `${Math.max(8, Math.min(height - 44, selected.last.bottom + 6))}px`
  }

  private async capture(): Promise<void> {
    const selected = this.current()
    this.hide()
    if (!selected || !this.host.enabled()) return
    const box = selected.element.getBoundingClientRect(), size = await this.host.pageSize(selected.page)
    if (!size || box.width <= 0 || box.height <= 0) return
    const point = (x: number, y: number): PdfPoint => ({ x: ((x - box.left) / box.width) * size.width, y: ((y - box.top) / box.height) * size.height })
    const capture: PdfSelectionCapture = { page: selected.page, quote: dehyphenate(selected.quote),
      start: point(selected.first.left + 1, selected.first.top + selected.first.height / 2),
      end: point(selected.last.right - 1, selected.last.top + selected.last.height / 2) }
    window.getSelection?.()?.removeAllRanges()
    this.host.comment(capture)
  }

  private click(event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || !this.host.enabled()) return
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
    if (selection && !selection.isCollapsed) return
    const element = pageOf(event.target as Node | null)
    const page = Number(element?.dataset.pdfPage)
    if (!element || !Number.isInteger(page) || page < 1) return
    const box = element.getBoundingClientRect(), x = event.clientX, y = event.clientY
    if (box.width <= 0 || box.height <= 0) return
    void this.host.pageSize(page).then(size => {
      if (size && this.host.enabled()) this.host.point(page, { x: ((x - box.left) / box.width) * size.width, y: ((y - box.top) / box.height) * size.height })
    }).catch(() => undefined)
  }
}
