import { indexPdfPage, indexSource, locateInPdfPage, quoteKey, type PdfPageIndex, type PdfTextRect, type SourceIndex } from '../shared/comment-anchor'
import { COMMENT_LIMITS, commentBody, commentSnippet, type CommentAnchor, type CommentApi, type CommentIdentity,
  type CommentSnapshot } from '../shared/comment-contracts'
import { buildThreads, type CommentThread } from '../shared/comment-threads'
import { inverseSync, type SyncTexData } from '../shared/synctex'
import type { ProjectInfo } from '../shared/workspace-contracts'
import { CommentPanel, type CommentPanelItem, type Placement } from './comment-panel'
import { placeComment, type IndexedPage, type PlacedComment, type PlacementSources } from './comment-placement'
import { element } from './dom'
import { readableError } from './editor-model'
import { CommentMarks } from './pdf-comment-layer'
import { PdfCommentInput, type PdfPoint, type PdfSelectionCapture } from './pdf-selection'
import type { PdfPageText, PdfPreview } from './pdf-view'
import type { RunAction } from './sync-panel'

export interface CommentsHost {
  api: CommentApi | undefined
  pdf: PdfPreview
  synctex(): SyncTexData | null
  project(): ProjectInfo | null
  /** Saved file text (what the PDF was compiled from), or null when it cannot be read. */
  readSource(path: string): Promise<string | null>
  revealSource(path: string, line: number): void
  notify(message: string): void
  run: RunAction
}

/** Work bounds for re-placing comments: hostile or huge comment logs must not freeze the window. */
const PLACEMENT = Object.freeze({ fuzzyThreads: 300, sourceFiles: 40, yieldEvery: 25 })
const pause = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })
const cached = <K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> => {
  let value = map.get(key)
  if (!value) { value = load(); map.set(key, value) }
  return value
}

/** The same comment with its highlight at newly measured rects; its place in the list follows the first rect. */
function moveTo(entry: PlacedComment, rects: PdfTextRect[]): PlacedComment {
  const first = rects[0], placement = entry.placement
  return { ...entry, mark: entry.mark ? { ...entry.mark, rects } : null,
    placement: first && placement.state === 'anchored' ? { ...placement, x: first.x, y: first.y, width: first.width, height: first.height } : placement }
}

/** PDF comments of the open paper: selection → draft → Main writes the event; threads, highlights and the panel
 * are rebuilt from Main's snapshot. Placement is recomputed after every compile and comment refresh.
 */
export class CommentsController {
  private readonly marks = new CommentMarks()
  private readonly panel: CommentPanel
  private readonly input: PdfCommentInput
  private readonly cleanups: (() => void)[] = []
  private readonly sources = new Map<string, { text: string; index: SourceIndex }>()
  private readonly pages = new WeakMap<PdfPageText, PdfPageIndex>()
  private threads: CommentThread[] = []
  private placed = new Map<string, PlacedComment>()
  private identity: CommentIdentity = { source: 'anonymous' }
  private unreadable = 0
  private draft: CommentAnchor | null = null
  private active: string | null = null
  private generation = 0
  private anchorRun = 0
  private requested = 0
  private applied = 0
  private pdfEpoch = 0
  /** The PDF (`pdfEpoch`) whose text `placed` was computed from; -1 while there is none. */
  private placedEpoch = -1
  private pdfPending = false
  private closing = false

  constructor(private readonly host: CommentsHost) {
    host.pdf.setOverlay(this.marks.provider)
    this.panel = new CommentPanel({
      submit: body => this.submit(body), cancel: () => { this.draft = null; this.render() },
      reply: (thread, body) => this.reply(thread, body), resolve: (thread, resolved) => this.resolve(thread, resolved),
      focus: thread => this.focus(thread, true), source: thread => this.source(thread)
    })
    this.input = new PdfCommentInput(element<HTMLElement>('pdf-pages').closest<HTMLElement>('.pdf-scroll')!, element<HTMLButtonElement>('pdf-comment-add'), {
      pageSize: page => host.pdf.pageSize(page), enabled: () => this.usable(),
      comment: capture => { void this.begin(capture).catch(error => host.notify(readableError(error))) },
      point: (page, at) => this.point(page, at)
    })
    element('comments-open').hidden = !host.api
    this.listen('comments-open', () => this.setOpen(Boolean(element('comment-panel').hidden)))
    this.listen('comment-close', () => { this.setOpen(false); element('comments-open').focus() })
    // Only for the PDF the highlights were placed on: while a new PDF is loading, or before its comments have
    // been placed again, the old positions must not be painted onto the new pages.
    this.cleanups.push(host.pdf.onPageRendered(page => {
      if (!this.pdfPending && this.placedEpoch === this.pdfEpoch && this.remeasured(page)) this.paintMarks()
    }))
    this.observeLayout()
    this.render()
  }

  /** Below ~560px the PDF column stacks the list under the PDF (a view-only class on the preview panel). */
  private observeLayout(): void {
    const preview = element('comment-panel').parentElement
    if (!preview || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => preview.classList.toggle('comments-stacked', preview.clientWidth < 560))
    observer.observe(preview)
    this.cleanups.push(() => observer.disconnect())
  }

  projectChanged(): void {
    this.generation++; this.anchorRun++
    this.threads = []; this.placed = new Map(); this.placedEpoch = -1; this.draft = null; this.active = null; this.unreadable = 0
    this.sources.clear(); this.marks.clear(); this.render()
    this.refresh()
  }

  /** The PDF is about to be replaced: old highlights would sit on the wrong text, and a selection made now would
   * be read against the new SyncTeX. Both wait until `compiled()`.
   */
  pdfChanging(): void { this.pdfEpoch++; this.pdfPending = true; this.anchorRun++; this.marks.clear(); this.input.hide() }
  /** Called when the new PDF is shown, or failed to show (then whatever is visible is re-placed). */
  compiled(): void { this.pdfPending = false; void this.reanchor() }
  filesChanged(paths: readonly string[]): void { if (paths.includes('')) this.refresh() }
  setClosing(closing: boolean): void { this.closing = closing; if (closing) this.input.hide() }

  dispose(): void {
    this.input.dispose(); this.panel.dispose()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.host.pdf.setOverlay(null)
  }

  refresh(): void {
    const api = this.host.api, generation = this.generation
    if (!api || !this.host.project()) { this.render(); return }
    const sequence = ++this.requested
    void api.list().then(snapshot => { if (generation === this.generation) this.apply(snapshot, sequence) },
      error => { if (generation === this.generation) this.host.notify(readableError(error)) })
  }

  private listen(id: string, handler: () => void): void {
    const node = element(id)
    node.addEventListener('click', handler)
    this.cleanups.push(() => node.removeEventListener('click', handler))
  }

  private usable(): boolean { return Boolean(this.host.api && this.host.project()) && !this.closing }

  /** Snapshots are applied in request order; a slower older read never replaces a newer write's result. */
  private apply(snapshot: CommentSnapshot, sequence: number): boolean {
    if (sequence <= this.applied) return false
    this.applied = sequence
    this.threads = buildThreads(snapshot.events)
    this.identity = snapshot.identity; this.unreadable = snapshot.unreadable
    if (this.active && !this.threads.some(thread => thread.id === this.active)) this.active = null
    this.render()
    void this.reanchor()
    return true
  }

  private context(): PlacementSources {
    const pdf = this.host.pdf, reads = new Map<string, Promise<SourceIndex | null>>(), pages = new Map<number, Promise<IndexedPage | null>>()
    return {
      pageCount: this.pdfPending ? 0 : pdf.pageCount, synctex: this.host.synctex(),
      // `reads` does not hold this path yet while its loader runs, so `>=` admits at most `sourceFiles` files.
      source: path => cached(reads, path, async () => reads.size >= PLACEMENT.sourceFiles ? null : this.sourceIndex(path)),
      page: number => cached(pages, number, async () => {
        const text = await pdf.pageText(number)
        if (!text) return null
        let index = this.pages.get(text)
        if (!index) { index = indexPdfPage(text.items, pdf.textEdges); this.pages.set(text, index) }
        return { width: text.width, height: text.height, index }
      })
    }
  }

  private async sourceIndex(path: string): Promise<SourceIndex | null> {
    const text = await this.host.readSource(path)
    if (text === null) { this.sources.delete(path); return null }
    const known = this.sources.get(path)
    if (known?.text === text) return known.index
    const index = indexSource(text)
    this.sources.set(path, { text, index })
    return index
  }

  private async reanchor(): Promise<void> {
    const run = ++this.anchorRun, generation = this.generation, epoch = this.pdfEpoch, context = this.context(), placed = new Map<string, PlacedComment>()
    for (const [position, thread] of this.threads.entries()) {
      if (position && position % PLACEMENT.yieldEvery === 0) await pause()
      if (run !== this.anchorRun || generation !== this.generation) return
      const result = await placeComment(thread.anchor, context, position < PLACEMENT.fuzzyThreads)
        .catch((): PlacedComment => ({ placement: { state: 'pending' }, mark: null }))
      if (run !== this.anchorRun || generation !== this.generation) return
      placed.set(thread.id, result)
    }
    this.placed = placed; this.placedEpoch = epoch
    this.remeasured() // a page may have been painted (its fonts loaded) while the comments were being placed
    this.paintMarks()
    this.render()
  }

  /** Measures the highlights on one page (or all) again and reports whether any moved. A page that has just been
   * painted has its fonts loaded, so a first measurement made with a stand-in font can be corrected. Which text
   * each comment sits on does not change.
   */
  private remeasured(page?: number): boolean {
    let moved = false
    const placed = new Map<string, PlacedComment>()
    for (const [id, entry] of this.placed) {
      const rects = entry.mark && (page === undefined || entry.mark.page === page) ? entry.remeasure?.() : undefined
      const same = !rects || !entry.mark || (rects.length === entry.mark.rects.length && rects.every((rect, index) => {
        const old = entry.mark!.rects[index]!
        return rect.x === old.x && rect.y === old.y && rect.width === old.width && rect.height === old.height
      }))
      placed.set(id, same ? entry : moveTo(entry, rects!))
      moved ||= !same
    }
    if (moved) this.placed = placed
    return moved
  }

  /** Only open comments stay highlighted on the page; a fixed comment lives in the list and flashes when opened. */
  private paintMarks(): void {
    this.marks.set(this.threads.flatMap(thread => {
      const mark = this.placed.get(thread.id)?.mark
      return mark && !thread.resolved ? [{ id: thread.id, ...mark }] : []
    }))
    this.marks.setActive(this.active)
  }

  private items(): CommentPanelItem[] {
    const placement = (thread: CommentThread): Placement => this.placed.get(thread.id)?.placement ?? { state: 'pending' }
    const position = (item: CommentPanelItem): number[] => item.placement.state === 'anchored'
      ? [0, item.placement.page, item.placement.y, item.placement.x] : [1, Date.parse(item.thread.at), 0, 0]
    const sort = (a: CommentPanelItem, b: CommentPanelItem): number => {
      const left = position(a), right = position(b)
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!
      return 0
    }
    const items = this.threads.map(thread => ({ thread, placement: placement(thread) }))
    return [...items.filter(item => !item.thread.resolved).sort(sort), ...items.filter(item => item.thread.resolved).sort(sort)]
  }

  private render(): void {
    this.panel.render({ available: this.usable(), items: this.items(), identity: this.identity,
      unreadable: this.unreadable, draft: this.draft, active: this.active })
  }

  private setOpen(open: boolean): void {
    if (this.closing) return
    element('comment-panel').hidden = !open
    element('comments-open').setAttribute('aria-expanded', String(open))
    if (open) this.refresh()
  }

  /** Turns a PDF selection into a draft: SyncTeX gives the source file and lines, the page text gives context. */
  private async begin(capture: PdfSelectionCapture): Promise<void> {
    const synctex = this.host.synctex(), generation = this.generation, epoch = this.pdfEpoch
    if (this.pdfPending) return
    if (!synctex) { this.host.notify('当前 PDF 没有源码位置信息，请重新编译后再评论。'); return }
    const quote = commentSnippet(capture.quote, Number.MAX_SAFE_INTEGER) ?? ''
    if (!quoteKey(quote)) { this.host.notify('请选中包含文字的内容后再评论。'); return }
    if (quote.length > COMMENT_LIMITS.quote) { this.host.notify('选中的文字过长（上限 600 字），请缩短选择。'); return }
    const start = inverseSync(synctex, capture.page, capture.start.x, capture.start.y)
    const end = inverseSync(synctex, capture.page, capture.end.x, capture.end.y)
    if (!start) { this.host.notify('无法确定选中文字对应的源文件位置，请换一处选择或重新编译。'); return }
    const text = await this.host.pdf.pageText(capture.page)
    const found = text ? locateInPdfPage(indexPdfPage(text.items, this.host.pdf.textEdges), { quote, before: '', after: '' }, capture.start, true) : null
    if (generation !== this.generation || epoch !== this.pdfEpoch || this.closing) return
    // The page's own text keeps word breaks across lines even where the text layer's selection string glues them.
    const readable = commentSnippet(found?.text ?? '', COMMENT_LIMITS.quote)
    this.draft = { file: start.file, line: start.line, endLine: end?.file === start.file ? Math.max(start.line, end.line) : start.line,
      quote: readable && quoteKey(readable) === quoteKey(quote) ? readable : quote,
      before: commentSnippet(found?.before ?? '', COMMENT_LIMITS.context) ?? '',
      after: commentSnippet(found?.after ?? '', COMMENT_LIMITS.context) ?? '', page: capture.page }
    this.setOpen(true)
    this.render()
    this.panel.focusComposer()
  }

  /** Runs one write as an ordinary action and applies its snapshot unless the project changed meanwhile. If a
   * read requested later already landed, that read may predate this write, so the list is read once more.
   */
  private write(label: string, action: (api: CommentApi) => Promise<CommentSnapshot>, done: () => void = () => undefined): void {
    const api = this.host.api, generation = this.generation
    if (!api || !this.usable()) return
    this.host.run(label, async () => {
      const sequence = ++this.requested, snapshot = await action(api)
      if (generation !== this.generation) return
      if (!this.apply(snapshot, sequence)) this.refresh()
      done()
    })
  }

  private submit(body: string): void {
    const anchor = this.draft
    if (!anchor) return
    if (!commentBody(body)) { this.host.notify('评论内容不能为空，且不能超过 4000 字。'); return }
    const known = new Set(this.threads.map(thread => thread.id))
    this.write('发表评论', api => api.create({ anchor, body }), () => {
      if (this.draft === anchor) this.draft = null
      this.active = this.threads.find(thread => !known.has(thread.id))?.id ?? this.active
      this.render()
    })
  }

  private reply(thread: string, body: string): void {
    if (!commentBody(body)) { this.host.notify('回复内容不能为空，且不能超过 4000 字。'); return }
    this.write('回复评论', api => api.reply(thread, body), () => { this.panel.clearReply(thread); this.render() })
  }

  private resolve(thread: string, resolved: boolean): void {
    this.write('标记评论', api => api.setResolved(thread, resolved))
  }

  /** Selecting a card (open or fixed) scrolls to its text and flashes every line temporarily; a lost position has
   * nothing to show and keeps its "position lost" note.
   */
  private focus(thread: string, reveal: boolean): void {
    this.active = thread
    this.marks.setActive(thread)
    this.render()
    const mark = this.placed.get(thread)?.mark
    if (reveal && mark) void this.host.pdf.reveal(mark.page, mark.rects).catch(error => this.host.notify(readableError(error)))
  }

  private source(thread: string): void {
    const found = this.threads.find(item => item.id === thread), placement = this.placed.get(thread)?.placement
    if (found && placement?.state === 'stale') this.host.revealSource(found.anchor.file, placement.line)
  }

  private point(page: number, at: PdfPoint): void {
    const thread = this.marks.at(page, at.x, at.y)
    if (!thread) return
    this.setOpen(true)
    this.focus(thread, false)
  }
}
