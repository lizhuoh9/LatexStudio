import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView, runScopeHandlers, type Panel, type ViewUpdate } from '@codemirror/view'
import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, SearchQuery, setSearchQuery } from '@codemirror/search'
import './find-bar-style.css'

/** Matches counted for the "3 / 17" indicator; beyond this the total reads "999+". */
export const SOURCE_SEARCH_LIMIT = 999
export interface MatchSpan { from: number; to: number }
export interface MatchList { spans: readonly MatchSpan[]; capped: boolean }
export interface SearchFields { search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }

/** `literal` is always on: LaTeX source is full of backslashes, and CodeMirror would otherwise read the `\n`,
 * `\t` and `\r` at the start of `\newcommand`, `\textbf` or `\ref` as a line break, tab or carriage return.
 */
export function sourceQuery(fields: SearchFields): SearchQuery { return new SearchQuery({ ...fields, literal: true }) }

export function listMatches(state: EditorState, query: SearchQuery, limit = SOURCE_SEARCH_LIMIT): MatchList {
  const spans: MatchSpan[] = []
  if (!query.search || !query.valid) return { spans, capped: false }
  const cursor = query.getCursor(state)
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    if (spans.length >= limit) return { spans, capped: true }
    spans.push({ from: step.value.from, to: step.value.to })
  }
  return { spans, capped: false }
}

/** Position of the selected text among the matches, or -1 when the selection is not exactly one of them. */
export function matchIndex(spans: readonly MatchSpan[], selection: MatchSpan): number {
  return spans.findIndex(span => span.from === selection.from && span.to === selection.to)
}

/** First match at or after `from`, wrapping to the start of the document. */
export function nearestMatch(state: EditorState, query: SearchQuery, from: number): MatchSpan | null {
  if (!query.search || !query.valid) return null
  const forward = query.getCursor(state, from).next()
  const hit = forward.done ? query.getCursor(state).next() : forward
  return hit.done ? null : { from: hit.value.from, to: hit.value.to }
}

const ICONS = {
  search: ['M7 2.75a4.25 4.25 0 1 0 0 8.5a4.25 4.25 0 0 0 0-8.5z', 'M10.1 10.1L13.25 13.25'],
  replace: ['M3 5.5h8.5M9 3l2.5 2.5L9 8', 'M13 10.5H4.5M7 8l-2.5 2.5L7 13'],
  previous: ['M3.75 9.75L8 5.5l4.25 4.25'],
  next: ['M3.75 6.25L8 10.5l4.25-4.25'],
  expand: ['M6.25 3.75L10.5 8l-4.25 4.25'],
  close: ['M4 4l8 8M12 4l-8 8']
} as const
const SVG = 'http://www.w3.org/2000/svg'

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true')
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, 'path')
    for (const [key, value] of [['d', d], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.6'],
      ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']] as const) path.setAttribute(key, value)
    svg.append(path)
  }
  return svg
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = className; made.append(...children)
  return made
}

function control(className: string, run: () => void, ...children: (Node | string)[]): HTMLButtonElement {
  const made = node('button', className, ...children)
  made.type = 'button'
  made.addEventListener('click', run)
  return made
}

function field(name: string, leading: Node): HTMLInputElement {
  const input = node('input', 'find-input')
  input.type = 'text'; input.name = name; input.autocomplete = 'off'; input.spellcheck = false
  input.setAttribute('autocapitalize', 'off')
  node('label', 'find-field', leading, input)
  return input
}

/** The replace row is collapsed until asked for, and stays as the user left it for the rest of the session. */
let replaceExpanded = false

/** Find/replace bar for the source editor, shown above the text. It only drives CodeMirror's own search state,
 * so highlights, Enter/F3 navigation, replace and undo history stay the editor's.
 */
class SourceSearchPanel implements Panel {
  readonly top = true
  readonly dom: HTMLElement
  private readonly searchInput = field('search', icon('search'))
  private readonly replaceInput = field('replace', icon('replace'))
  private readonly count = node('span', 'find-count')
  private readonly caseToggle = this.toggle('Aa')
  private readonly wordToggle = this.toggle('ab')
  private readonly regexpToggle = this.toggle('.*')
  private readonly expand = control('find-button find-expand', () => this.setExpanded(!replaceExpanded), icon('expand'))
  private readonly previous = control('find-button', () => { this.commit(false); findPrevious(this.view) }, icon('previous'))
  private readonly next = control('find-button', () => { this.commit(false); findNext(this.view) }, icon('next'))
  private readonly close = control('find-button', () => { closeSearchPanel(this.view); this.view.focus() }, icon('close'))
  private readonly replaceOne = control('find-action', () => { this.commit(false); replaceNext(this.view) })
  private readonly replaceEvery = control('find-action', () => { this.commit(false); replaceAll(this.view) })
  private readonly replaceRow: HTMLElement
  private matches: MatchList

  constructor(private readonly view: EditorView) {
    this.searchInput.setAttribute('main-field', 'true')
    this.count.setAttribute('role', 'status'); this.count.setAttribute('aria-live', 'polite')
    this.wordToggle.classList.add('find-toggle-word')
    const searchField = this.searchInput.parentElement!
    searchField.append(this.count, node('span', 'find-options', this.caseToggle, this.wordToggle, this.regexpToggle))
    this.replaceRow = node('div', 'find-row find-replace-row', this.replaceInput.parentElement!, this.replaceOne, this.replaceEvery)
    this.dom = node('div', 'find-bar source-find',
      node('div', 'find-row', this.expand, searchField, this.previous, this.next, this.close), this.replaceRow)
    this.dom.setAttribute('role', 'search')
    this.dom.addEventListener('keydown', event => this.keydown(event))
    this.searchInput.addEventListener('input', () => this.commit(true))
    this.replaceInput.addEventListener('input', () => this.commit(false))
    const query = getSearchQuery(view.state)
    this.matches = listMatches(view.state, query)
    this.fill(query); this.relabel(); this.setExpanded(replaceExpanded); this.render(view.state)
  }

  mount(): void { this.searchInput.focus(); this.searchInput.select() }

  update(update: ViewUpdate): void {
    const queryChanged = update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setSearchQuery)))
    const query = getSearchQuery(update.state)
    if (queryChanged) this.fill(query)
    if (queryChanged || update.docChanged) this.matches = listMatches(update.state, query)
    if (update.startState.facet(EditorState.phrases) !== update.state.facet(EditorState.phrases)) this.relabel()
    if (queryChanged || update.docChanged || update.selectionSet || update.startState.readOnly !== update.state.readOnly) this.render(update.state)
  }

  private toggle(glyph: string): HTMLButtonElement {
    const made = control('find-button find-toggle', () => {
      made.setAttribute('aria-pressed', String(made.getAttribute('aria-pressed') !== 'true'))
      this.commit(true); this.searchInput.focus()
    }, glyph)
    made.setAttribute('aria-pressed', 'false')
    return made
  }

  private fields(): SearchFields {
    const pressed = (button: HTMLButtonElement): boolean => button.getAttribute('aria-pressed') === 'true'
    return { search: this.searchInput.value, replace: this.replaceInput.value, caseSensitive: pressed(this.caseToggle),
      wholeWord: pressed(this.wordToggle), regexp: pressed(this.regexpToggle) }
  }

  /** Stores the fields as the editor's search query; `jump` also selects the nearest match so typing shows it at once. */
  private commit(jump: boolean): void {
    const query = sourceQuery(this.fields())
    if (!query.eq(getSearchQuery(this.view.state))) this.view.dispatch({ effects: setSearchQuery.of(query) })
    const hit = jump ? nearestMatch(this.view.state, query, this.view.state.selection.main.from) : null
    if (hit) this.view.dispatch({ selection: EditorSelection.single(hit.from, hit.to), effects: EditorView.scrollIntoView(hit.from, { y: 'center' }) })
  }

  /** Copies a query set elsewhere (opening with selected text, a shortcut) into the fields without moving the caret. */
  private fill(query: SearchQuery): void {
    if (this.searchInput.value !== query.search) this.searchInput.value = query.search
    if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace
    this.caseToggle.setAttribute('aria-pressed', String(query.caseSensitive))
    this.wordToggle.setAttribute('aria-pressed', String(query.wholeWord))
    this.regexpToggle.setAttribute('aria-pressed', String(query.regexp))
  }

  private setExpanded(expanded: boolean): void {
    replaceExpanded = expanded
    this.expand.setAttribute('aria-expanded', String(expanded))
    this.render(this.view.state)
  }

  private render(state: EditorState): void {
    const query = getSearchQuery(state), total = this.matches.spans.length, phrase = (key: string): string => state.phrase(key)
    const invalid = Boolean(query.search) && !query.valid, missing = Boolean(query.search) && query.valid && total === 0
    const index = matchIndex(this.matches.spans, state.selection.main)
    this.count.textContent = invalid ? phrase('Invalid pattern') : missing ? phrase('No results')
      : total ? `${index < 0 ? '–' : index + 1} / ${total}${this.matches.capped ? '+' : ''}` : ''
    this.searchInput.parentElement!.classList.toggle('is-missing', invalid || missing)
    this.previous.disabled = this.next.disabled = total === 0
    this.expand.hidden = state.readOnly
    this.replaceRow.hidden = state.readOnly || !replaceExpanded
    this.replaceOne.disabled = this.replaceEvery.disabled = total === 0
  }

  private relabel(): void {
    const phrase = (key: string): string => this.view.state.phrase(key)
    const name = (target: HTMLElement, key: string, hint = ''): void => {
      target.setAttribute('aria-label', phrase(key)); target.title = phrase(key) + hint
    }
    this.dom.setAttribute('aria-label', phrase('Find'))
    this.searchInput.placeholder = phrase('Find'); this.searchInput.setAttribute('aria-label', phrase('Find'))
    this.replaceInput.placeholder = phrase('Replace'); this.replaceInput.setAttribute('aria-label', phrase('Replace'))
    name(this.caseToggle, 'Match case'); name(this.wordToggle, 'Whole word'); name(this.regexpToggle, 'Regular expression')
    name(this.previous, 'Previous match', ' (Shift+Enter)'); name(this.next, 'Next match', ' (Enter)')
    name(this.close, 'Close', ' (Esc)'); name(this.expand, 'Show or hide replace')
    this.replaceOne.textContent = phrase('Replace'); this.replaceEvery.textContent = phrase('Replace all')
    this.render(this.view.state)
  }

  private keydown(event: KeyboardEvent): void {
    // While an input method is composing, Enter and Esc belong to its candidate list, not to the bar.
    if (event.isComposing) return
    if (runScopeHandlers(this.view, event, 'search-panel')) { event.preventDefault(); return }
    if (event.key !== 'Enter') return
    if (event.target === this.searchInput) { event.preventDefault(); this.commit(false); (event.shiftKey ? findPrevious : findNext)(this.view) }
    else if (event.target === this.replaceInput) { event.preventDefault(); this.commit(false); replaceNext(this.view) }
  }
}

const searchTheme = EditorView.theme({
  '.cm-panels': { backgroundColor: 'transparent', color: 'inherit' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid #e3e8f2' },
  '.cm-searchMatch': { backgroundColor: 'rgba(250, 204, 21, 0.42)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(249, 115, 22, 0.5)', boxShadow: '0 0 0 1px #ea580c' }
})

/** Replaces CodeMirror's default search panel; `searchKeymap` (Ctrl/Cmd+F, F3, Esc…) keeps working unchanged. */
export function sourceSearch(): Extension {
  return [search({ top: true, literal: true, createPanel: view => new SourceSearchPanel(view) }), searchTheme]
}
