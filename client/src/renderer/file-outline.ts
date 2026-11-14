export const MAX_OUTLINE_ITEMS = 300
export const MAX_OUTLINE_CHARACTERS = 1024 * 1024
export const MAX_OUTLINE_TITLE = 160
const MAX_ARGUMENT_CHARACTERS = 4096
const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 } as const
export type OutlineKind = keyof typeof LEVELS
export interface FileOutlineEntry {
  kind: OutlineKind; title: string; line: number; level: number; starred: boolean; parentIndex: number | null
}
interface Group { value: string; end: number }
interface Command { name: string; end: number }
interface Found { end: number; heading?: Pick<FileOutlineEntry, 'kind' | 'title' | 'level' | 'starred'> }
const IGNORED_ENVIRONMENTS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'LVerbatim',
  'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*', 'luacode', 'luacode*', 'pycode'])
const letter = (value: string | undefined): boolean => !!value && /[A-Za-z@]/.test(value)
function whitespace(source: string, start: number): number {
  let cursor = start
  while (cursor < source.length) {
    if (/\s/.test(source[cursor]!)) { cursor++; continue }
    if (source[cursor] !== '%') break
    const newline = source.indexOf('\n', cursor)
    cursor = newline < 0 ? source.length : newline
  }
  return cursor
}
function commandAt(source: string, start: number): Command {
  let end = start + 1
  while (end < source.length && letter(source[end])) end++
  return { name: source.slice(start + 1, end), end: end === start + 1 ? Math.min(source.length, end + 1) : end }
}

/** Read literal balanced arguments, dropping comments but retaining escaped percent/braces. No macro execution. */
function groupAt(source: string, start: number, opening: '{' | '['): Group | null {
  if (source[start] !== opening) return null
  const stack = [opening === '{' ? '}' : ']'], parts: string[] = []
  for (let cursor = start + 1; cursor < source.length && cursor - start <= MAX_ARGUMENT_CHARACTERS; cursor++) {
    const value = source[cursor]!
    if (value === '%') {
      const newline = source.indexOf('\n', cursor)
      if (newline < 0) return null
      cursor = newline; parts.push('\n'); continue
    }
    if (value === '\\') { parts.push(source.slice(cursor, cursor + 2)); cursor++; continue }
    if (value === '{' || value === '[' && stack.at(-1) === ']') {
      if (stack.length >= 32) return null
      stack.push(value === '{' ? '}' : ']'); parts.push(value); continue
    }
    if (value === stack.at(-1)) {
      stack.pop()
      if (!stack.length) return { value: parts.join(''), end: cursor + 1 }
      parts.push(value); continue
    }
    if (value === '}' && stack.at(-1) !== '}') return null
    parts.push(value)
  }
  return null
}
function environmentEnd(source: string, start: number, environment: string): number {
  let cursor = start
  for (;;) {
    const end = source.indexOf('\\end', cursor)
    if (end < 0) return source.length
    const command = commandAt(source, end)
    const group = command.name === 'end' ? groupAt(source, whitespace(source, command.end), '{') : null
    if (group?.value.trim() === environment) return group.end
    cursor = command.end
  }
}
function inlineEnd(source: string, start: number, optional: boolean): number {
  let cursor = source[start] === '*' ? start + 1 : start
  if (optional) {
    const group = groupAt(source, whitespace(source, cursor), '[')
    if (group) cursor = whitespace(source, group.end)
  }
  const delimiter = source[cursor]
  if (!delimiter || /\s/.test(delimiter)) return cursor
  const newline = source.indexOf('\n', cursor), end = source.indexOf(delimiter, cursor + 1)
  return end >= 0 && (newline < 0 || end < newline) ? end + 1 : newline < 0 ? source.length : newline
}
function titleOf(value: string): string {
  const source = value.replace(/\\(?:label|index)\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:textbf|textit|textrm|textsf|texttt|emph|mbox|protect)\b\s*/g, '')
  let title = ''
  for (let cursor = 0; cursor < source.length; cursor++) {
    const char = source[cursor]!
    if (char === '\\') {
      const command = commandAt(source, cursor), next = source[cursor + 1]
      title += command.name || (next && '%&#_${}'.includes(next) ? next : ' ')
      cursor = command.end - 1
    } else if (char !== '{' && char !== '}') title += char
  }
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_OUTLINE_TITLE)
}
function inspect(source: string, start: number): Found {
  const command = commandAt(source, start)
  if (command.name === 'verb' || command.name === 'lstinline') return { end: inlineEnd(source, command.end, command.name === 'lstinline') }
  if (command.name === 'begin') {
    const group = groupAt(source, whitespace(source, command.end), '{')
    const environment = group?.value.trim()
    return { end: group && environment && IGNORED_ENVIRONMENTS.has(environment) ? environmentEnd(source, group.end, environment) : group?.end ?? command.end }
  }
  const level = LEVELS[command.name as OutlineKind]
  if (typeof level !== 'number') return { end: command.end }
  let cursor = whitespace(source, command.end)
  const starred = source[cursor] === '*'
  if (starred) cursor = whitespace(source, cursor + 1)
  if (source[cursor] === '[') {
    const short = groupAt(source, cursor, '[')
    if (!short) return { end: command.end }
    cursor = whitespace(source, short.end)
  }
  const group = groupAt(source, cursor, '{')
  if (!group) return { end: command.end }
  const title = titleOf(group.value)
  return { end: group.end, ...(title ? { heading: { kind: command.name as OutlineKind, title, level, starred } } : {}) }
}

/** A bounded literal-source outline, not a TeX expansion engine or proof of rendered document structure. */
export function parseFileOutline(content: string): FileOutlineEntry[] {
  const source = content.slice(0, MAX_OUTLINE_CHARACTERS), entries: FileOutlineEntry[] = [], ancestors: number[] = []
  let cursor = 0, line = 1
  const advance = (end: number): void => { while (cursor < end) { if (source[cursor] === '\n') line++; cursor++ } }
  while (cursor < source.length && entries.length < MAX_OUTLINE_ITEMS) {
    if (source[cursor] === '%') {
      const newline = source.indexOf('\n', cursor)
      advance(newline < 0 ? source.length : newline); continue
    }
    if (source[cursor] !== '\\') { advance(cursor + 1); continue }
    const found = inspect(source, cursor), headingLine = line
    advance(Math.max(cursor + 1, found.end))
    if (!found.heading) continue
    while (ancestors.length && entries[ancestors.at(-1)!]!.level >= found.heading.level) ancestors.pop()
    const parentIndex = ancestors.at(-1) ?? null
    entries.push({ ...found.heading, line: headingLine, parentIndex }); ancestors.push(entries.length - 1)
  }
  return entries
}

export class FileOutline {
  private entries: FileOutlineEntry[] = []
  private generation = 0
  private closing = false
  private disposed = false
  constructor(private host: HTMLElement, private reveal: (line: number) => void) {
    host.setAttribute('data-file-outline', '')
    this.update('')
  }
  update(content: string): void {
    if (this.disposed) return
    this.entries = parseFileOutline(content); this.generation++; this.render()
  }
  setClosing(closing: boolean): void {
    if (this.disposed || this.closing === closing) return
    this.closing = closing; this.generation++; this.render()
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.generation++; this.entries = []; this.host.replaceChildren()
  }
  private render(): void {
    const generation = this.generation, rows: HTMLLIElement[] = [], childLists = new Map<number, HTMLOListElement>()
    this.host.replaceChildren()
    for (const entry of this.entries) {
      const row = document.createElement('li'), button = document.createElement('button')
      row.className = 'outline-item'; button.type = 'button'; button.className = 'outline-entry'; button.disabled = this.closing
      button.textContent = entry.title; button.title = `${entry.title} · 第 ${entry.line} 行`; button.dataset.outlineLine = String(entry.line)
      button.setAttribute('aria-label', `${entry.title}，第 ${entry.line} 行`)
      button.addEventListener('click', () => {
        if (!this.disposed && !this.closing && generation === this.generation) this.reveal(entry.line)
      })
      row.append(button)
      if (entry.parentIndex === null) this.host.append(row)
      else {
        let list = childLists.get(entry.parentIndex)
        if (!list) {
          list = document.createElement('ol'); list.className = 'outline-children'
          rows[entry.parentIndex]!.append(list); childLists.set(entry.parentIndex, list)
        }
        list.append(row)
      }
      rows.push(row)
    }
    if (!this.entries.length) {
      const empty = document.createElement('li'); empty.className = 'outline-empty'; empty.textContent = '当前文件暂无章节'; this.host.append(empty)
    }
  }
}
