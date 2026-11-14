/// <reference lib="dom" />
import { readFileSync } from 'node:fs'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undoDepth } from '@codemirror/commands'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { FileOutline, MAX_OUTLINE_CHARACTERS, MAX_OUTLINE_ITEMS, MAX_OUTLINE_TITLE, parseFileOutline } from '../src/renderer/file-outline'
import { SourceEditor } from '../src/renderer/editor-view'

describe('bounded current-source LaTeX outline parser', () => {
  it('recognizes hierarchy, starred headings and optional short headings without replacing the actual title', () => {
    const content = String.raw`\part{Paper}
\chapter*{Background}
\section[Short {nested}]{The \textbf{Long} Title}
\subsection{Child}
\subsubsection*{Deep}
\section{Next}`
    const entries = parseFileOutline(content)
    expect(entries.map(entry => entry.title)).toEqual(['Paper', 'Background', 'The Long Title', 'Child', 'Deep', 'Next'])
    expect(entries.map(entry => entry.kind)).toEqual(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'section'])
    expect(entries.map(entry => entry.line)).toEqual([1, 2, 3, 4, 5, 6])
    expect(entries.map(entry => entry.parentIndex)).toEqual([null, 0, 1, 2, 3, 1])
    expect(entries.map(entry => entry.starred)).toEqual([false, true, false, false, true, false])
  })
  it('keeps same-line heading parents distinct instead of using line number as an identity', () => {
    const entries = parseFileOutline(String.raw`\section{A}\subsection{A1}\section{B}\subsection{B1}`)
    expect(entries.map(entry => entry.line)).toEqual([1, 1, 1, 1])
    expect(entries.map(entry => entry.parentIndex)).toEqual([null, 0, null, 2])
  })
  it('ignores unescaped percent comments, including comments between command and argument, with real line numbers', () => {
    const entries = parseFileOutline(String.raw`\section{A\% remains} % \section{Ignored}
\\% comment \section{Ignored}
\section % between command and body
{B % hide \section{Wrong}
 title}
\% \subsection{C}`)
    expect(entries.map(entry => entry.title)).toEqual(['A% remains', 'B title', 'C'])
    expect(entries.map(entry => entry.line)).toEqual([1, 3, 6])
  })
  it('reads nested/escaped braces and multiline titles while preserving following source positions', () => {
    const entries = parseFileOutline(String.raw`\section{
 A {nested} \{literal\}
}
\subsection[Short {with ] inside}]{Next}`)
    expect(entries.map(entry => entry.title)).toEqual(['A nested {literal}', 'Next'])
    expect(entries.map(entry => entry.line)).toEqual([1, 4])
  })
  it.each(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents*', 'luacode'])('ignores headings inside %s', environment => {
    const entries = parseFileOutline(String.raw`\section{Before}
\begin{${environment}}
\section{Not a heading}
\end{${environment}}
\section{After}`)
    expect(entries.map(entry => entry.title)).toEqual(['Before', 'After'])
    expect(entries.map(entry => entry.line)).toEqual([1, 5])
  })
  it('ignores the remainder of an unclosed verbatim/comment block', () => {
    expect(parseFileOutline(String.raw`\section{Before}\begin{comment}
\section{Hidden}`)).toHaveLength(1)
  })
  it('ignores inline verbatim/lstinline text and escaped or extended control names', () => {
    const entries = parseFileOutline(String.raw`\verb|\section{Hidden}| \section{Visible}
\lstinline[language=TeX]+\subsection{Hidden}+ \subsection{Visible child}
\\section{No} \sectional{No} \constructor{No}`)
    expect(entries.map(entry => entry.title)).toEqual(['Visible', 'Visible child'])
    expect(entries.map(entry => entry.line)).toEqual([1, 2])
  })
  it('does not fabricate empty, unfinished or excessively nested headings', () => {
    expect(parseFileOutline(String.raw`\section{} \subsection[unfinished \chapter{`)).toEqual([])
    expect(parseFileOutline('\\section{' + '{'.repeat(40) + 'Title' + '}'.repeat(41))).toEqual([])
  })
  it('bounds item count, title length and source scanned without reading another file or expanding macros', () => {
    const many = Array.from({ length: MAX_OUTLINE_ITEMS + 20 }, (_, index) => `\\section{Item ${index}}`).join('\n')
    expect(parseFileOutline(many)).toHaveLength(MAX_OUTLINE_ITEMS)
    expect(parseFileOutline(many).at(-1)?.line).toBe(MAX_OUTLINE_ITEMS)
    expect(parseFileOutline('\\section{' + 'x'.repeat(MAX_OUTLINE_TITLE + 30) + '}')[0]?.title).toHaveLength(MAX_OUTLINE_TITLE)
    expect(parseFileOutline('x'.repeat(MAX_OUTLINE_CHARACTERS) + String.raw`\section{Outside bound}`)).toEqual([])
    expect(parseFileOutline(String.raw`\input{other-file.tex}\include{chapter}`)).toEqual([])
  })
})

class NodeMock {
  className = ''; textContent = ''; title = ''; type = ''; disabled = false
  dataset: Record<string, string> = {}; attributes = new Map<string, string>()
  children: NodeMock[] = []; handlers: (() => void)[] = []
  constructor(readonly tagName: string) {}
  append(...nodes: NodeMock[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: NodeMock[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(_type: string, handler: () => void): void { this.handlers.push(handler) }
  click(): void { if (!this.disabled) for (const handler of this.handlers) handler() }
  set innerHTML(_value: string) { throw new Error('Outline must render text, not markup') }
}
const all = (node: NodeMock): NodeMock[] => node.children.flatMap(child => [child, ...all(child)])
const buttons = (host: NodeMock): NodeMock[] => all(host).filter(node => node.tagName === 'button')
let host: NodeMock, reveal: Mock<(line: number) => void>, outline: FileOutline | null
beforeEach(() => {
  host = new NodeMock('ol'); reveal = vi.fn(); outline = null
  vi.stubGlobal('document', { createElement: (tag: string) => new NodeMock(tag) })
})
afterEach(() => { outline?.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function mount(content: string): FileOutline {
  outline = new FileOutline(host as unknown as HTMLElement, reveal); outline.update(content); return outline
}

describe('native file outline rendering and lifecycle', () => {
  it('renders nested native lists and jumps to the actual 1-based source line only on a click', () => {
    mount(String.raw`% prefix
\section{Parent}
text
\subsection{Child}
\section{Sibling}`)
    expect(host.attributes.has('data-file-outline')).toBe(true); expect(host.children).toHaveLength(2)
    expect(host.children[0]?.children[1]?.tagName).toBe('ol')
    const entries = buttons(host); expect(entries.map(entry => entry.textContent)).toEqual(['Parent', 'Child', 'Sibling'])
    expect(entries.every(entry => entry.type === 'button' && !entry.attributes.has('role'))).toBe(true)
    expect(reveal).not.toHaveBeenCalled(); entries[1]!.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith(4)
  })
  it('uses textContent for hostile/Unicode headings and accessible source-line labels', () => {
    mount(String.raw`\section{<img src=x onerror=evil()> 论文<&>}`)
    const entry = buttons(host)[0]!
    expect(entry.textContent).toBe('<img src=x onerror=evil()> 论文<&>')
    expect(entry.attributes.get('aria-label')).toContain('第 1 行'); expect(entry.dataset.outlineLine).toBe('1')
    expect(reveal).not.toHaveBeenCalled()
  })
  it('invalidates detached buttons on content/file changes', () => {
    const panel = mount(String.raw`\section{Old}`), old = buttons(host)[0]!
    panel.update('\n' + String.raw`\section{New}`); old.click(); expect(reveal).not.toHaveBeenCalled()
    buttons(host)[0]!.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith(2)
  })
  it('blocks current and stale clicks during closing, then remounts usable controls on canceled close', () => {
    const panel = mount(String.raw`\section{Current}`), old = buttons(host)[0]!
    panel.setClosing(true); expect(buttons(host)[0]!.disabled).toBe(true)
    old.click(); buttons(host)[0]!.disabled = false; buttons(host)[0]!.click(); expect(reveal).not.toHaveBeenCalled()
    panel.setClosing(false); old.click(); expect(reveal).not.toHaveBeenCalled()
    buttons(host)[0]!.click(); expect(reveal).toHaveBeenCalledExactlyOnceWith(1)
  })
  it('clears on disposal and ignores queued clicks or late updates', () => {
    const panel = mount(String.raw`\section{Old}`), old = buttons(host)[0]!
    panel.dispose(); panel.dispose(); panel.update(String.raw`\section{Late}`); panel.setClosing(false); old.click()
    expect(host.children).toEqual([]); expect(reveal).not.toHaveBeenCalled()
  })
  it('has a bounded DOM and an empty state without a fake navigation action', () => {
    const panel = mount('ordinary text'); expect(host.children[0]?.textContent).toBe('当前文件暂无章节'); expect(buttons(host)).toEqual([])
    panel.update(Array.from({ length: MAX_OUTLINE_ITEMS + 2 }, (_, index) => `\\section{${index}}`).join('\n'))
    expect(buttons(host)).toHaveLength(MAX_OUTLINE_ITEMS)
  })
  it('keeps every dark-slate style scoped to its host without external assets or global editor rules', () => {
    const css = readFileSync('src/renderer/file-outline-style.css', 'utf8')
    expect(css).toContain('background: #243247'); expect(css).toContain(':focus-visible')
    expect(css).not.toMatch(/@import|url\(|\.workspace|\.cm-editor/)
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter(rule => rule.includes('{'))
    for (const rule of rules) expect(rule.slice(0, rule.indexOf('{')).trim().startsWith('[data-file-outline]')).toBe(true)
  })
})

describe('SourceEditor line reveal is selection-only', () => {
  function editor(doc = 'first\nsecond\nthird') {
    const initial = EditorState.create({ doc, extensions: [history(), EditorState.readOnly.of(true)] })
    const state = doc ? initial.update({ changes: { from: 0, insert: '!' } }).state : initial
    const view = { state, dispatch: vi.fn<(spec: TransactionSpec) => void>(), focus: vi.fn() }
    const instance = Object.create(SourceEditor.prototype) as SourceEditor
    Object.assign(instance, { view, loading: true })
    return { view, instance }
  }
  it('selects a 1-based line, scrolls and focuses without document/history changes, including read-only content', () => {
    const { view, instance } = editor(), scroll = vi.spyOn(EditorView, 'scrollIntoView')
    const beforeDepth = undoDepth(view.state), beforeText = view.state.doc.toString()
    instance.revealLine(2)
    const spec = view.dispatch.mock.calls[0]![0], next = view.state.update(spec)
    expect(spec.selection).toEqual({ anchor: view.state.doc.line(2).from })
    expect(scroll).toHaveBeenCalledWith(view.state.doc.line(2).from, { y: 'center' })
    expect(spec.changes).toBeUndefined(); expect(next.docChanged).toBe(false)
    expect(next.annotation(Transaction.addToHistory)).toBe(false)
    expect(next.state.doc.toString()).toBe(beforeText); expect(undoDepth(next.state)).toBe(beforeDepth)
    expect(view.focus).toHaveBeenCalledOnce()
  })
  it.each([NaN, Infinity, -Infinity, 0, -1, 1.5])('ignores invalid line %s without dispatch or focus', line => {
    const { view, instance } = editor(); instance.revealLine(line)
    expect(view.dispatch).not.toHaveBeenCalled(); expect(view.focus).not.toHaveBeenCalled()
  })
  it('clamps large positive integers to the last current line and supports an empty document', () => {
    const last = editor(); last.instance.revealLine(Number.MAX_SAFE_INTEGER)
    expect(last.view.dispatch.mock.calls[0]![0].selection).toEqual({ anchor: last.view.state.doc.line(last.view.state.doc.lines).from })
    const empty = editor(''); empty.instance.revealLine(1)
    expect(empty.view.dispatch.mock.calls[0]![0].selection).toEqual({ anchor: 0 })
  })
})
