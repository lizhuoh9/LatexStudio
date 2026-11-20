/// <reference lib="dom" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommentApi, CommentEvent, CommentSnapshot } from '../src/shared/comment-contracts'
import type { SyncTexData } from '../src/shared/synctex'
import type { PdfCommentInputHost } from '../src/renderer/pdf-selection'
import { setLocale, translate } from '../src/shared/i18n'

const captured = vi.hoisted(() => ({ host: null as PdfCommentInputHost | null }))
vi.mock('../src/renderer/pdf-selection', () => ({
  PdfCommentInput: class { constructor(_scroll: unknown, _button: unknown, host: PdfCommentInputHost) { captured.host = host } hide(): void {} dispose(): void {} },
  dehyphenate: (text: string) => text
}))
import { CommentsController, type CommentsHost } from '../src/renderer/comments'
import { CommentMarks } from '../src/renderer/pdf-comment-layer'
import { startDomLocalization } from '../src/renderer/i18n-dom'

class NodeMock {
  id = ''; className = ''; textContent = ''; hidden = false; value = ''; type = ''; dateTime = ''; maxLength = 0; rows = 0
  selectionStart = 0; selectionEnd = 0; parent: NodeMock | null = null; dataset: Record<string, string> = {}
  style: Record<string, string> = {}; attributes = new Map<string, string>(); children: NodeMock[] = []
  handlers = new Map<string, Set<(event: unknown) => void>>()
  classList = {
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
    add: (name: string): void => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim() },
    remove: (name: string): void => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' ') },
    toggle: (name: string, force?: boolean): boolean => { const on = force ?? !this.classList.contains(name); if (on) this.classList.add(name); else this.classList.remove(name); return on }
  }
  constructor(readonly tagName = 'DIV') {}
  append(...nodes: NodeMock[]): void { for (const node of nodes) { node.parent = this; this.children.push(node) } }
  replaceChildren(...nodes: NodeMock[]): void { this.children = []; this.append(...nodes) }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
  }
  removeEventListener(type: string, handler: (event: unknown) => void): void { this.handlers.get(type)?.delete(handler) }
  emit(type: string, event: unknown = { preventDefault: () => undefined }): void { for (const handler of this.handlers.get(type) ?? []) handler(event) }
  click(): void { this.emit('click') }
  focus(): void { state.active = this }
  scrollIntoView(): void {}
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end }
  contains(node: NodeMock | null): boolean { return !!node && (node === this || this.children.some(child => child.contains(node))) }
  matches(selector: string): boolean {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()))
    if (selector === '[data-thread]') return this.dataset.thread !== undefined
    const attribute = /^\[data-thread="([^"]+)"\]$/.exec(selector)
    if (attribute) return this.dataset.thread === attribute[1]
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1))
    return this.tagName.toLowerCase() === selector.toLowerCase()
  }
  closest(selector: string): NodeMock | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null }
  all(): NodeMock[] { return this.children.flatMap(child => [child, ...child.all()]) }
  querySelector(selector: string): NodeMock | null {
    if (selector.includes(',')) return this.all().find(node => node.matches(selector)) ?? null
    const [first, ...rest] = selector.split(' ')
    for (const node of this.all()) {
      if (!node.matches(first!)) continue
      if (!rest.length) return node
      const inner = node.querySelector(rest.join(' '))
      if (inner) return inner
    }
    return null
  }
  find(predicate: (node: NodeMock) => boolean): NodeMock | undefined { return this.all().find(predicate) }
  button(text: string): NodeMock {
    const found = this.find(node => node.tagName === 'BUTTON' && node.textContent === text)
    if (!found) throw new Error(`Missing button ${text}`)
    return found
  }
}
const state = { active: null as NodeMock | null, nodes: new Map<string, NodeMock>() }
function get(id: string): NodeMock {
  if (!state.nodes.has(id)) { const node = new NodeMock(id.includes('body') ? 'TEXTAREA' : 'DIV'); node.id = id; state.nodes.set(id, node) }
  return state.nodes.get(id)!
}

const alice = { kind: 'github', login: 'alice', id: 42 } as const
const anchor = { file: 'main.tex', line: 2, endLine: 2, quote: 'strong gains', before: 'Our method shows', after: 'over the', page: 1 }
const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const items = [
  { str: 'Our method shows strong gains over the', x: 72, y: 90, width: 380, height: 12 },
  { str: 'baseline in every experiment.', x: 72, y: 104, width: 290, height: 12 }
]
const synctex: SyncTexData = { files: ['main.tex'], nodes: [
  { file: 0, line: 2, page: 1, x: 72, y: 90, width: 380, height: 12, kind: 'leaf' },
  { file: 0, line: 3, page: 1, x: 72, y: 104, width: 290, height: 12, kind: 'leaf' }] }
let events: CommentEvent[]
let api: { [K in keyof CommentApi]: ReturnType<typeof vi.fn> }
let host: CommentsHost
let tasks: Promise<void>[]
let source: string
let identity: CommentSnapshot['identity']
const snapshot = (): CommentSnapshot => ({ events: [...events], unreadable: 0, identity })
async function settle(): Promise<void> { for (let i = 0; i < 30; i++) await Promise.resolve(); await Promise.all(tasks.splice(0)); for (let i = 0; i < 30; i++) await Promise.resolve() }
const cards = (): NodeMock[] => get('comment-list').children

beforeEach(() => {
  state.nodes.clear(); state.active = null; tasks = []; events = []; identity = { source: 'session', login: 'alice', id: 42 }
  source = '\\section{Results}\nOur method shows strong gains over the\nbaseline in every experiment.\n'
  const scroll = new NodeMock(); scroll.className = 'pdf-scroll'; scroll.append(get('pdf-pages'))
  vi.stubGlobal('document', { getElementById: get, createElement: (tag: string) => new NodeMock(tag.toUpperCase()), get activeElement() { return state.active } })
  api = {
    list: vi.fn(async () => snapshot()),
    create: vi.fn(async ({ anchor: value, body }) => { events.push({ v: 1, type: 'thread', id: idOf(events.length + 1), at: `2026-11-19T10:00:0${events.length}.000Z`, author: alice, anchor: value, body }); return snapshot() }),
    reply: vi.fn(async (thread, body) => { events.push({ v: 1, type: 'reply', id: idOf(events.length + 1), at: '2026-11-19T11:00:00.000Z', author: alice, thread, body }); return snapshot() }),
    setResolved: vi.fn(async (thread, resolved) => { events.push({ v: 1, type: resolved ? 'resolve' : 'reopen', id: idOf(events.length + 1), at: '2026-11-19T12:00:00.000Z', author: alice, thread }); return snapshot() })
  }
  host = {
    api: api as unknown as CommentApi,
    pdf: { setOverlay: vi.fn(), pageCount: 1, pageSize: vi.fn(async () => ({ width: 600, height: 800 })),
      pageText: vi.fn(async () => ({ width: 600, height: 800, items })), jumpTo: vi.fn(async () => undefined),
      reveal: vi.fn(async () => undefined) } as unknown as CommentsHost['pdf'],
    synctex: vi.fn(() => synctex), project: vi.fn(() => ({ id: 'p', name: 'Paper', root: '/p', files: [], defaultMain: 'main.tex' })),
    readSource: vi.fn(async () => source), revealSource: vi.fn(), notify: vi.fn(),
    run: vi.fn((_label: string, action: () => Promise<void>) => { tasks.push(action()) })
  }
})
afterEach(() => { vi.unstubAllGlobals(); setLocale('zh-CN') })

describe('comment workflow in the editor', () => {
  it('turns a PDF selection into a draft anchored by SyncTeX, posts it, and highlights it red', async () => {
    const comments = new CommentsController(host)
    expect(host.pdf.setOverlay).toHaveBeenCalledOnce()
    comments.projectChanged(); await settle()
    expect(api.list).toHaveBeenCalledOnce()
    captured.host!.comment({ page: 1, quote: 'strong  gains', start: { x: 200, y: 96 }, end: { x: 290, y: 96 } }); await settle()
    expect(get('comment-panel').hidden).toBe(false)
    expect(get('comment-compose').hidden).toBe(false)
    expect(get('comment-compose-quote').textContent).toBe('“strong gains”')
    expect(get('comment-compose-identity').textContent).toBe('将以 @alice 署名')
    get('comment-compose-body').value = 'Please cite the baseline.'
    get('comment-compose-submit').click(); await settle()
    expect(api.create).toHaveBeenCalledWith({ anchor: { ...anchor, before: 'Our method shows', after: 'over the baseline in every experiment.' }, body: 'Please cite the baseline.' })
    expect(get('comment-compose').hidden).toBe(true)
    expect(cards()).toHaveLength(1)
    expect(cards()[0]!.className).toBe('comment-thread is-open is-active')
    expect(cards()[0]!.find(node => node.className === 'comment-body')?.textContent).toBe('Please cite the baseline.')
    const provider = vi.mocked(host.pdf.setOverlay).mock.calls[0]![0] as unknown as (page: number) => NodeMock
    const layer = provider(1)
    expect(layer.children.map(node => node.className)).toEqual(['pdf-comment-mark is-open is-active'])
    expect(parseFloat(layer.children[0]!.style.left!)).toBeCloseTo((72 + (17 / 38) * 380) / 6, 3)
  })

  it('keeps a fixed comment only in the list, flashes its text when its card is selected, and reopening brings the red highlight back', async () => {
    events = [{ v: 1, type: 'thread', id: idOf(1), at: '2026-11-19T10:00:00.000Z', author: alice, anchor, body: 'typo' }]
    const comments = new CommentsController(host)
    comments.projectChanged(); await settle()
    const provider = vi.mocked(host.pdf.setOverlay).mock.calls[0]![0] as unknown as (page: number) => NodeMock
    expect(provider(1).children.map(node => node.className)).toEqual(['pdf-comment-mark is-open'])
    cards()[0]!.button('标记为已修改').click(); await settle()
    expect(api.setResolved).toHaveBeenCalledWith(idOf(1), true)
    expect(cards()[0]!.className).toContain('is-resolved')
    expect(cards()[0]!.find(node => node.className.includes('is-fixed'))?.textContent).toBe('已修改')
    expect(cards()[0]!.find(node => node.className === 'comment-resolved-note')?.textContent).toMatch(/^由 @alice 于 .+ 标记为已修改$/)
    expect(provider(1).children).toEqual([])
    get('comment-panel').hidden = true
    captured.host!.point(1, { x: 300, y: 95 })
    expect(get('comment-panel').hidden).toBe(true)
    cards()[0]!.find(node => node.className === 'comment-quote')!.click()
    expect(host.pdf.reveal).toHaveBeenCalledWith(1, [expect.objectContaining({ y: 90, height: 12 })])
    expect(cards()[0]!.className).toContain('is-active')
    expect(provider(1).children).toEqual([])
    cards()[0]!.button('重新打开').click(); await settle()
    expect(api.setResolved).toHaveBeenLastCalledWith(idOf(1), false)
    expect(cards()[0]!.className).toContain('is-open')
    expect(provider(1).children.map(node => node.className)).toEqual(['pdf-comment-mark is-open is-active'])
    cards()[0]!.button('回复').click()
    const input = cards()[0]!.querySelector('textarea')!
    input.value = 'Fixed in the latest draft.'; input.emit('input')
    cards()[0]!.button('发送').click(); await settle()
    expect(api.reply).toHaveBeenCalledWith(idOf(1), 'Fixed in the latest draft.')
    expect(cards()[0]!.find(node => node.className === 'comment-replies')?.children).toHaveLength(1)
    get('comment-panel').hidden = true
    captured.host!.point(1, { x: 300, y: 95 })
    expect(get('comment-panel').hidden).toBe(false)
    expect(cards()[0]!.className).toContain('is-active')
    captured.host!.point(1, { x: 10, y: 10 })
  })

  it('shows a lost position instead of guessing, and can jump to the old source line', async () => {
    events = [{ v: 1, type: 'thread', id: idOf(1), at: '2026-11-19T10:00:00.000Z', author: alice, anchor: { ...anchor, quote: 'a sentence that was rewritten entirely' }, body: 'unclear' }]
    const comments = new CommentsController(host)
    comments.projectChanged(); await settle()
    expect(cards()[0]!.className).toContain('is-stale')
    expect(cards()[0]!.find(node => node.className.includes('comment-badge is-stale'))?.textContent).toBe('位置已失效')
    cards()[0]!.find(node => node.className === 'comment-quote')!.click()
    expect(host.pdf.reveal).not.toHaveBeenCalled()
    expect(cards()[0]!.find(node => node.className === 'comment-location')?.textContent).toBe('原位置：main.tex 第 2 行附近')
    cards()[0]!.button('跳到源码').click()
    expect(host.revealSource).toHaveBeenCalledWith('main.tex', 2)
  })

  it('refreshes only on a full rescan, refuses unusable selections, and translates fixed labels but not user text', async () => {
    events = [{ v: 1, type: 'thread', id: idOf(1), at: '2026-11-19T10:00:00.000Z', author: { kind: 'local', device: 'c'.repeat(32) }, anchor, body: '已修改 位置已失效' }]
    const comments = new CommentsController(host)
    comments.projectChanged(); await settle()
    comments.filesChanged(['main.tex']); comments.filesChanged(['']); await settle()
    expect(api.list).toHaveBeenCalledTimes(2)
    captured.host!.comment({ page: 1, quote: 'x'.repeat(601), start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }); await settle()
    expect(host.notify).toHaveBeenLastCalledWith('选中的文字过长（上限 600 字），请缩短选择。')
    captured.host!.comment({ page: 1, quote: '— …', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }); await settle()
    expect(host.notify).toHaveBeenLastCalledWith('请选中包含文字的内容后再评论。')
    vi.mocked(host.synctex).mockReturnValue(null)
    captured.host!.comment({ page: 1, quote: 'strong gains', start: { x: 1, y: 1 }, end: { x: 2, y: 2 } }); await settle()
    expect(host.notify).toHaveBeenLastCalledWith('当前 PDF 没有源码位置信息，请重新编译后再评论。')
    const stopLocalization = startDomLocalization()
    setLocale('en')
    expect(get('comment-summary').textContent).toBe('Open 1 · Fixed 0')
    expect(cards()[0]!.button('Mark as fixed')).toBeDefined()
    expect(cards()[0]!.find(node => node.className === 'comment-author')?.textContent).toBe(`Not signed-in user · ${'c'.repeat(6)}`)
    expect(cards()[0]!.find(node => node.className === 'comment-body')?.textContent).toBe('已修改 位置已失效')
    setLocale('ko')
    expect(get('comment-summary').textContent).toBe('미해결 1 · 수정됨 0')
    stopLocalization()
  })

  it('never lets an older list replace the result of a newer write, and keeps keyboard focus on the action', async () => {
    events = [{ v: 1, type: 'thread', id: idOf(1), at: '2026-11-19T10:00:00.000Z', author: alice, anchor, body: 'typo' }]
    const comments = new CommentsController(host)
    comments.projectChanged(); await settle()
    const older = snapshot()
    let release: (value: CommentSnapshot) => void = () => undefined
    api.list.mockImplementationOnce(() => new Promise<CommentSnapshot>(resolve => { release = resolve }))
    comments.refresh()
    const resolve = cards()[0]!.button('标记为已修改')
    resolve.focus(); resolve.click(); await settle()
    expect(cards()[0]!.className).toContain('is-resolved')
    expect(state.active?.className).toBe('comment-reopen')
    expect(cards()[0]!.contains(state.active)).toBe(true)
    release(older); await settle()
    expect(cards()[0]!.className).toContain('is-resolved')
  })

  it('ignores selections while a new PDF is loading and keeps typed text when the selection changes', async () => {
    const comments = new CommentsController(host)
    comments.projectChanged(); await settle()
    const capture = { page: 1, quote: 'strong gains', start: { x: 200, y: 96 }, end: { x: 290, y: 96 } }
    comments.pdfChanging()
    captured.host!.comment(capture); await settle()
    expect(get('comment-compose').hidden).toBe(true)
    expect(host.notify).not.toHaveBeenCalled()
    comments.compiled(); await settle()
    captured.host!.comment(capture); await settle()
    get('comment-compose-body').value = 'half-written comment'
    captured.host!.comment({ ...capture, quote: 'baseline' }); await settle()
    expect(get('comment-compose-quote').textContent).toBe('“baseline”')
    expect(get('comment-compose-body').value).toBe('half-written comment')
    get('comment-compose-cancel').click()
    expect(get('comment-compose').hidden).toBe(true)
    expect(get('comment-compose-body').value).toBe('')
  })

  it('stays unavailable without a project or the desktop bridge', async () => {
    host.project = vi.fn(() => null)
    const comments = new CommentsController(host)
    comments.projectChanged(); await settle()
    expect(api.list).not.toHaveBeenCalled()
    expect(get('comment-status').textContent).toBe('打开论文项目后可使用评论。')
    expect(captured.host!.enabled()).toBe(false)
    const bare = new CommentsController({ ...host, api: undefined })
    void bare
    expect(get('comments-open').hidden).toBe(true)
  })
})

describe('comment highlights', () => {
  it('draws percentages of the page, keeps one container per page and hit-tests the smallest highlight', () => {
    const marks = new CommentMarks()
    const page = marks.provider(2) as unknown as NodeMock
    marks.set([
      { id: 'big', page: 2, pageWidth: 600, pageHeight: 800, rects: [{ x: 60, y: 80, width: 300, height: 40 }] },
      { id: 'small', page: 2, pageWidth: 600, pageHeight: 800, rects: [{ x: 90, y: 90, width: 30, height: 10 }] }
    ])
    expect(marks.provider(2)).toBe(page)
    expect(page.children.map(node => [node.className, node.style.left, node.style.top])).toEqual([
      ['pdf-comment-mark is-open', '10%', '10%'], ['pdf-comment-mark is-open', '15%', '11.25%']])
    expect(marks.at(2, 95, 95)).toBe('small')
    expect(marks.at(2, 300, 100)).toBe('big')
    expect(marks.at(1, 95, 95)).toBeNull()
    marks.setActive('big')
    expect(page.children[0]!.className).toBe('pdf-comment-mark is-open is-active')
    marks.clear()
    expect(page.children).toEqual([])
  })
})

describe('comment markup and catalog', () => {
  const markup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  it('adds one comment toggle beside the log toggle, a hidden panel inside the PDF column and a hidden add button', () => {
    expect(markup).toMatch(/<button id="log-open"[^>]*>日志<\/button><button id="comments-open" class="text-button" aria-controls="comment-panel" aria-expanded="false"/)
    expect(markup).toMatch(/<aside id="comment-panel" class="comment-panel" aria-labelledby="comment-title" hidden>/)
    expect(markup).toMatch(/<button id="pdf-comment-add"[^>]* hidden>添加评论<\/button>/)
    expect(markup.indexOf('id="comment-panel"')).toBeGreaterThan(markup.indexOf('class="pdf-scroll"'))
    expect(markup.indexOf('id="comment-panel"')).toBeLessThan(markup.indexOf('id="history-files"'))
  })
  it.each(['en', 'ko'] as const)('translates every fixed comment label into %s', locale => {
    for (const text of ['评论', '打开或收起评论', '关闭评论', '写下评论…', '评论内容', '发表评论', '评论列表', '添加评论', '为选中的文字添加评论',
      '已修改', '位置已失效', '编译后显示位置', '标记为已修改', '重新打开', '回复', '发送', '跳到源码', '写下回复…', '回复内容',
      '在 PDF 中显示此处', '打开论文项目后可使用评论。', '已自动合并双方的评论并同步到 GitHub。', '自动合并评论记录',
      '未解决 3 · 已修改 1', '将以 @alice 署名', '当前未登录，将以本机最近验证的账号 @alice 署名', '由 @bob 于 2026/11/19 10:00 标记为已修改',
      '2 条评论记录无法读取（可能来自更新的版本或已损坏），原文件已保留，未做修改。', '原位置：chapters/intro.tex 第 12 行附近', '未登录用户 · abcdef']) {
      expect(translate(text, locale), text).not.toMatch(/[\u3400-\u9fff]/)
    }
    expect(translate('原位置：chapters/intro.tex 第 12 行附近', locale)).toContain('chapters/intro.tex')
  })
})
