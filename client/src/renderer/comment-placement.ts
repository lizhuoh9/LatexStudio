import { locateInPdfPage, locateInSource, spanRects, type PdfPageIndex, type PdfTextRect, type SourceIndex } from '../shared/comment-anchor'
import type { CommentAnchor } from '../shared/comment-contracts'
import { forwardSync, type SyncTexData } from '../shared/synctex'
import type { Placement } from './comment-panel'

export interface IndexedPage { width: number; height: number; index: PdfPageIndex }
export interface PlacementSources {
  pageCount: number
  synctex: SyncTexData | null
  source(path: string): Promise<SourceIndex | null>
  page(page: number): Promise<IndexedPage | null>
}
export interface PlacedComment {
  placement: Placement
  mark: { page: number; pageWidth: number; pageHeight: number; rects: PdfTextRect[] } | null
  /** The mark's rects measured again (same text, same page); the result can differ once the page's fonts are loaded. */
  remeasure?: () => PdfTextRect[]
}

/** Where a comment's text is in the current PDF, or why it cannot be shown.
 * The source is searched first (nearest the stored line); SyncTeX then maps that line to a page, and the text is
 * looked up on that page and its neighbours. A partial (fuzzy) PDF match is accepted only while the source still
 * holds the text; otherwise only the exact text counts, so rewritten text reads as "position lost", never a guess.
 * `fuzzy` false limits both searches to exact text (the caller's work budget for very many comments).
 */
export async function placeComment(anchor: CommentAnchor, sources: PlacementSources, fuzzy = true): Promise<PlacedComment> {
  if (sources.pageCount < 1) return { placement: { state: 'pending' }, mark: null }
  const index = await sources.source(anchor.file)
  const span = index ? locateInSource(index, anchor, fuzzy) : null
  const line = span?.line ?? anchor.line
  const target = sources.synctex ? forwardSync(sources.synctex, anchor.file, line) : null
  const center = target?.page ?? anchor.page
  const pages = [center, center + 1, center - 1].filter(page => page >= 1 && page <= sources.pageCount)
  for (const exactOnly of span && fuzzy ? [true, false] : [true]) {
    for (const number of pages) {
      const page = await sources.page(number)
      if (!page) continue
      const found = locateInPdfPage(page.index, anchor, number === target?.page ? { x: target.x, y: target.y } : undefined, exactOnly)
      if (!found) continue
      const first = found.rects[0]!
      return { placement: { state: 'anchored', page: number, x: first.x, y: first.y, width: first.width, height: first.height },
        mark: { page: number, pageWidth: page.width, pageHeight: page.height, rects: found.rects },
        remeasure: () => spanRects(page.index, found.span) }
    }
  }
  return { placement: { state: 'stale', line }, mark: null }
}
