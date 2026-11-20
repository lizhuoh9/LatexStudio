import type { CommentAnchor, CommentAuthor, CommentIdentity } from '../shared/comment-contracts'
import type { CommentThread } from '../shared/comment-threads'
import { intlLocale, translate } from '../shared/i18n'
import { element } from './dom'
import { uiAttribute, uiFormattedText, uiText } from './i18n-dom'

export type Placement =
  | { state: 'anchored'; page: number; x: number; y: number; width: number; height: number }
  | { state: 'stale'; line: number }
  | { state: 'pending' }
export interface CommentPanelItem { thread: CommentThread; placement: Placement }
export interface CommentPanelState {
  available: boolean
  items: CommentPanelItem[]
  identity: CommentIdentity
  unreadable: number
  draft: CommentAnchor | null
  active: string | null
}
export interface CommentPanelActions {
  submit(body: string): void
  cancel(): void
  reply(thread: string, body: string): void
  resolve(thread: string, resolved: boolean): void
  focus(thread: string): void
  source(thread: string): void
}

interface FocusedControl { thread: string; selector: string; start: number; end: number }
/** Cards drawn at once; a huge (possibly hostile) comment log must not build tens of thousands of DOM nodes. */
const MAX_CARDS = 500
const time = (at: string): string => {
  try { return new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(at)) } catch { return at }
}
/** Display name only. A GitHub login is shown as written; a device signature is a fixed label plus a short id. */
export function authorName(author: CommentAuthor): string {
  return author.kind === 'github' ? `@${author.login}` : translate(`未登录用户 · ${author.device.slice(0, 6)}`)
}
function create<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}
function label<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, source: string): HTMLElementTagNameMap[K] {
  const node = create(tag, className); uiText(node, source); return node
}
function action(className: string, source: string, handler: () => void, locked = true): HTMLButtonElement {
  const node = label('button', className, source)
  node.type = 'button'
  if (locked) node.setAttribute('data-lock', '')
  node.addEventListener('click', handler)
  return node
}

/** The comment list beside the PDF. Comment text, quotes and names are user content: shown literally, never translated. */
export class CommentPanel {
  private readonly list = element<HTMLOListElement>('comment-list')
  private readonly body = element<HTMLTextAreaElement>('comment-compose-body')
  private readonly replyDrafts = new Map<string, string>()
  private readonly replying = new Set<string>()
  private readonly cleanups: (() => void)[] = []
  private draft: CommentAnchor | null = null
  private active: string | null = null

  constructor(private readonly actions: CommentPanelActions) {
    this.listen(element('comment-compose-submit'), 'click', () => this.actions.submit(this.body.value))
    this.listen(element('comment-compose-cancel'), 'click', () => this.actions.cancel())
    this.listen(this.body, 'keydown', event => {
      const key = event as KeyboardEvent
      if (key.key === 'Escape') { key.preventDefault(); this.actions.cancel() }
      if (key.key === 'Enter' && (key.ctrlKey || key.metaKey)) { key.preventDefault(); this.actions.submit(this.body.value) }
    })
  }

  render(state: CommentPanelState): void {
    this.summary(state)
    this.composer(state)
    const focused = this.focusedControl()
    const shown = state.items.slice(0, MAX_CARDS)
    this.list.replaceChildren(...shown.map(item => this.card(item, state.active === item.thread.id)))
    if (focused) this.restoreFocus(focused)
    if (state.active && state.active !== this.active) {
      this.list.querySelector<HTMLElement>(`[data-thread="${state.active}"]`)?.scrollIntoView?.({ block: 'nearest' })
    }
    this.active = state.active
  }

  focusComposer(): void { this.body.focus() }
  clearReply(thread: string): void { this.replyDrafts.delete(thread); this.replying.delete(thread) }
  dispose(): void { for (const cleanup of this.cleanups.splice(0)) cleanup() }

  private listen(node: HTMLElement, type: string, handler: (event: Event) => void): void {
    node.addEventListener(type, handler)
    this.cleanups.push(() => node.removeEventListener(type, handler))
  }

  private summary(state: CommentPanelState): void {
    const open = state.items.filter(item => !item.thread.resolved).length
    uiText(element('comment-summary'), `未解决 ${open} · 已修改 ${state.items.length - open}`)
    element('comment-count').textContent = open ? String(open) : ''
    const status = element('comment-status')
    const message = !state.available ? '打开论文项目后可使用评论。'
      : state.unreadable ? `${state.unreadable} 条评论记录无法读取（可能来自更新的版本或已损坏），原文件已保留，未做修改。`
        : state.items.length > MAX_CARDS ? '评论较多，列表只显示前 500 条。'
          : !state.items.length && !state.draft ? '在 PDF 中选中文字，再点“添加评论”即可添加。评论保存在项目文件夹里，同步后合作者可见。' : ''
    uiText(status, message)
    status.hidden = !message
  }

  private composer(state: CommentPanelState): void {
    element('comment-compose').hidden = !state.draft
    // Typed text survives choosing a different selection; it is cleared only when the draft ends.
    if (!state.draft && this.draft) this.body.value = ''
    this.draft = state.draft
    if (!state.draft) return
    element('comment-compose-quote').textContent = `“${state.draft.quote}”`
    const identity = state.identity
    uiText(element('comment-compose-identity'), identity.source === 'session' ? `将以 @${identity.login} 署名`
      : identity.source === 'device' ? `当前未登录，将以本机最近验证的账号 @${identity.login} 署名`
        : '当前未登录，将署名为“未登录用户”；登录 GitHub 后发表的评论使用账号署名。')
  }

  private card(item: CommentPanelItem, active: boolean): HTMLLIElement {
    const { thread, placement } = item
    const resolved = thread.resolved !== null, stale = placement.state === 'stale'
    const card = create('li', `comment-thread ${resolved ? 'is-resolved' : 'is-open'}${stale ? ' is-stale' : ''}${active ? ' is-active' : ''}`)
    card.dataset.thread = thread.id
    const quote = create('button', 'comment-quote')
    quote.type = 'button'; quote.textContent = `“${thread.anchor.quote}”`
    uiAttribute(quote, 'title', stale ? '原文已找不到，无法在 PDF 中显示' : '在 PDF 中显示此处')
    quote.addEventListener('click', () => this.actions.focus(thread.id))
    const badges = [resolved ? label('span', 'comment-badge is-fixed', '已修改') : null,
      stale ? label('span', 'comment-badge is-stale', '位置已失效') : null,
      placement.state === 'pending' ? label('span', 'comment-badge', '编译后显示位置') : null]
    const text = create('p', 'comment-body'); text.textContent = thread.body
    card.append(quote, this.meta(thread.author, thread.at, badges), text)
    if (stale) {
      const where = create('p', 'comment-location')
      uiText(where, `原位置：${thread.anchor.file} 第 ${placement.line} 行附近`)
      card.append(where)
    }
    if (thread.replies.length) {
      const replies = create('ol', 'comment-replies')
      for (const reply of thread.replies) {
        const row = create('li'), body = create('p', 'comment-body'); body.textContent = reply.body
        row.append(this.meta(reply.author, reply.at, []), body); replies.append(row)
      }
      card.append(replies)
    }
    if (thread.resolved) {
      const note = create('p', 'comment-resolved-note'), by = thread.resolved
      uiFormattedText(note, () => translate(`由 ${authorName(by.author)} 于 ${time(by.at)} 标记为已修改`))
      card.append(note)
    }
    card.append(this.actionRow(thread, stale))
    if (this.replying.has(thread.id)) card.append(this.replyForm(thread.id))
    return card
  }

  private meta(author: CommentAuthor, at: string, badges: (HTMLElement | null)[]): HTMLDivElement {
    const meta = create('div', 'comment-meta'), who = create('strong', 'comment-author'), when = create('time')
    if (author.kind === 'github') who.textContent = `@${author.login}`
    else uiFormattedText(who, () => authorName(author))
    when.dateTime = at; uiFormattedText(when, () => time(at))
    meta.append(who, when, ...badges.filter((badge): badge is HTMLElement => badge !== null))
    return meta
  }

  private actionRow(thread: CommentThread, stale: boolean): HTMLDivElement {
    const row = create('div', 'comment-actions'), resolved = thread.resolved !== null
    row.append(action(resolved ? 'comment-reopen' : 'comment-resolve', resolved ? '重新打开' : '标记为已修改',
      () => this.actions.resolve(thread.id, !resolved)))
    row.append(action('comment-reply-toggle', '回复', () => {
      if (this.replying.has(thread.id)) this.replying.delete(thread.id); else this.replying.add(thread.id)
      const card = this.list.querySelector<HTMLElement>(`[data-thread="${thread.id}"]`)
      card?.querySelector('.comment-reply-form')?.remove()
      if (card && this.replying.has(thread.id)) { card.append(this.replyForm(thread.id)); card.querySelector('textarea')?.focus() }
    }, false))
    if (stale) row.append(action('comment-source', '跳到源码', () => this.actions.source(thread.id), false))
    return row
  }

  private replyForm(thread: string): HTMLDivElement {
    const form = create('div', 'comment-reply-form'), input = create('textarea')
    input.maxLength = 4000; input.rows = 2; input.value = this.replyDrafts.get(thread) ?? ''
    uiAttribute(input, 'placeholder', '写下回复…'); uiAttribute(input, 'aria-label', '回复内容')
    input.addEventListener('input', () => this.replyDrafts.set(thread, input.value))
    const send = (): void => this.actions.reply(thread, input.value)
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send() }
      if (event.key === 'Escape') { event.preventDefault(); this.clearReply(thread); form.remove() }
    })
    const buttons = create('div', 'button-row')
    buttons.append(action('secondary', '取消', () => { this.clearReply(thread); form.remove() }, false), action('', '发送', send))
    form.append(input, buttons)
    return form
  }

  /** The focused control inside a card (reply box or button), so a re-render can put keyboard focus back. */
  private focusedControl(): FocusedControl | null {
    const active = document.activeElement as HTMLElement | null
    if (!active || !this.list.contains(active)) return null
    const thread = active.closest?.<HTMLElement>('[data-thread]')?.dataset.thread
    if (!thread) return null
    if (active.tagName === 'TEXTAREA') {
      const input = active as HTMLTextAreaElement
      return { thread, selector: 'textarea', start: input.selectionStart, end: input.selectionEnd }
    }
    const role = active.className.split(/\s+/).find(name => name.startsWith('comment-'))
    return role ? { thread, selector: `.${role}`, start: 0, end: 0 } : { thread, selector: '.comment-quote', start: 0, end: 0 }
  }

  private restoreFocus(focused: FocusedControl): void {
    const card = this.list.querySelector<HTMLElement>(`[data-thread="${focused.thread}"]`)
    // A resolve button turns into reopen (and back): keep focus on the same action slot.
    const target = card?.querySelector<HTMLElement>(focused.selector) ??
      (focused.selector === '.comment-resolve' || focused.selector === '.comment-reopen' ? card?.querySelector<HTMLElement>('.comment-resolve, .comment-reopen') : null) ??
      card?.querySelector<HTMLElement>('.comment-quote')
    if (!target) return
    target.focus()
    if (focused.selector === 'textarea') (target as HTMLTextAreaElement).setSelectionRange?.(focused.start, focused.end)
  }
}

