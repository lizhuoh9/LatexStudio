import type { PdfTextRect } from '../shared/comment-anchor'

export interface CommentMark {
  id: string
  page: number
  /** Page size in PDF points when the rects were computed; rects are drawn as fractions of it. */
  pageWidth: number
  pageHeight: number
  rects: PdfTextRect[]
}

/** Red highlights of open comments, drawn under the selectable text layer. Fixed comments are not drawn here:
 * they stay in the list and only flash (temporarily) when their card is selected.
 * One stable container per page, so updating highlights never replaces the text layer or the user's selection.
 * The layer ignores the pointer; clicks are hit-tested from the PDF view instead.
 */
export class CommentMarks {
  private readonly containers = new Map<number, HTMLDivElement>()
  private marks: CommentMark[] = []
  private active: string | null = null

  readonly provider = (page: number): HTMLElement => {
    let container = this.containers.get(page)
    if (!container) {
      container = document.createElement('div')
      container.className = 'pdf-comment-layer'
      container.setAttribute('aria-hidden', 'true')
      this.containers.set(page, container)
      this.paint(page)
    }
    return container
  }

  set(marks: readonly CommentMark[]): void {
    const pages = new Set([...this.marks.map(mark => mark.page), ...marks.map(mark => mark.page)])
    this.marks = [...marks]
    for (const page of pages) this.paint(page)
  }

  setActive(id: string | null): void {
    if (this.active === id) return
    const pages = new Set(this.marks.filter(mark => mark.id === id || mark.id === this.active).map(mark => mark.page))
    this.active = id
    for (const page of pages) this.paint(page)
  }

  /** The comment under a page point (PDF points), preferring the smallest highlight when several overlap. */
  at(page: number, x: number, y: number): string | null {
    let best: { id: string; area: number } | null = null
    for (const mark of this.marks) {
      if (mark.page !== page) continue
      for (const rect of mark.rects) {
        const pad = Math.max(1, rect.height * 0.15)
        if (x < rect.x - pad || x > rect.x + rect.width + pad || y < rect.y - pad || y > rect.y + rect.height + pad) continue
        const area = rect.width * rect.height
        if (!best || area < best.area) best = { id: mark.id, area }
      }
    }
    return best?.id ?? null
  }

  clear(): void { this.set([]); this.active = null }

  private paint(page: number): void {
    const container = this.containers.get(page)
    if (!container) return
    const nodes: HTMLElement[] = []
    for (const mark of this.marks) {
      if (mark.page !== page || mark.pageWidth <= 0 || mark.pageHeight <= 0) continue
      for (const rect of mark.rects) {
        const node = document.createElement('div')
        node.className = `pdf-comment-mark is-open${mark.id === this.active ? ' is-active' : ''}`
        node.style.left = `${(rect.x / mark.pageWidth) * 100}%`
        node.style.top = `${(rect.y / mark.pageHeight) * 100}%`
        node.style.width = `${(rect.width / mark.pageWidth) * 100}%`
        node.style.height = `${(rect.height / mark.pageHeight) * 100}%`
        nodes.push(node)
      }
    }
    container.replaceChildren(...nodes)
  }
}
