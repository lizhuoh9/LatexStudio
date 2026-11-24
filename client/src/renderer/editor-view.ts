import { Compartment, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, foldGutter, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { latexIndentService } from '../vendor/ayakaleaf/latex-indent-service'
import { latexCompletions } from './latex-completions'
import { subscribeLocale, translate } from '../shared/i18n'
import { editorPhrases } from './editor-phrases'
import { EDITOR_FONT_FAMILY } from './editor-font'
import { sourceSearch } from './editor-search-panel'

export interface EditorDoubleClickLocation {
  line: number
  word?: string
  columnFraction: number
}

interface SyncFlashTarget {
  lineFrom: number
  wordFrom?: number
  wordTo?: number
}

function extractWordToken(raw: string): string | undefined {
  const match = /[A-Za-z0-9\u4e00-\u9fff]+(?:[-_][A-Za-z0-9\u4e00-\u9fff]+)*/.exec(raw.trim())
  return match?.[0]
}

function findWordInNearbyLines(doc: EditorState['doc'], baseLine: number, word: string): { from: number; to: number; lineFrom: number } | null {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundary = new RegExp(`(?<![A-Za-z0-9_\\u4e00-\\u9fff])${escaped}(?![A-Za-z0-9_\\u4e00-\\u9fff])`)
  const boundaryInsensitive = new RegExp(boundary.source, 'i')
  const lower = word.toLowerCase()
  const offsets = [0, -1, 1, -2, 2, -3, 3]
  for (const offset of offsets) {
    const num = baseLine + offset
    if (num < 1 || num > doc.lines) continue
    const line = doc.line(num)
    const hit = boundary.exec(line.text) ?? boundaryInsensitive.exec(line.text)
    if (hit) return { from: line.from + hit.index, to: line.from + hit.index + hit[0].length, lineFrom: line.from }
  }
  for (const offset of offsets) {
    const num = baseLine + offset
    if (num < 1 || num > doc.lines) continue
    const line = doc.line(num)
    const idx = line.text.toLowerCase().indexOf(lower)
    if (idx >= 0) return { from: line.from + idx, to: line.from + idx + word.length, lineFrom: line.from }
  }
  return null
}

const flashLineEffect = StateEffect.define<SyncFlashTarget | null>()
const syncFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    if (transaction.docChanged) return Decoration.none
    let next = decorations
    for (const effect of transaction.effects) {
      if (!effect.is(flashLineEffect)) continue
      if (effect.value === null) { next = Decoration.none; continue }
      const specs = [Decoration.line({ class: 'cm-sync-flash' }).range(effect.value.lineFrom)]
      if (effect.value.wordFrom !== undefined && effect.value.wordTo !== undefined && effect.value.wordTo > effect.value.wordFrom) {
        specs.push(Decoration.mark({ class: 'cm-sync-word-flash' }).range(effect.value.wordFrom, effect.value.wordTo))
      }
      next = Decoration.set(specs, true)
    }
    return next
  },
  provide: field => EditorView.decorations.from(field)
})

export class SourceEditor {
  private view: EditorView
  private loading = false
  private language = new Compartment()
  private unsubscribeLocale: () => void
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private extensions: Extension[]

  constructor(parent: HTMLElement, changed: (content: string) => void, save: () => void,
    onDoubleClickLine?: (location: EditorDoubleClickLocation) => void) {
    this.extensions = [
      lineNumbers(), history(), drawSelection(), highlightActiveLine(), foldGutter(), syncFlashField,
      bracketMatching(), closeBrackets(), StreamLanguage.define(stex),
      syntaxHighlighting(defaultHighlightStyle), latexIndentService(), highlightSelectionMatches(), sourceSearch(),
      autocompletion({ override: [latexCompletions] }), EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-s', run: () => { save(); return true } }, indentWithTab,
        ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.loading) changed(update.state.doc.toString())
      }),
      EditorView.domEventHandlers({
        dblclick: (event, view) => {
          if (!onDoubleClickLine || this.loading) return
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
          const anchor = pos ?? view.state.selection.main.head
          const line = view.state.doc.lineAt(anchor)
          const wordRange = view.state.wordAt(anchor)
          const word = wordRange ? extractWordToken(view.state.sliceDoc(wordRange.from, wordRange.to)) : undefined
          const columnFraction = line.length > 0 ? Math.max(0, Math.min(1, (anchor - line.from) / line.length)) : 0.5
          onDoubleClickLine({ line: line.number, ...(word ? { word } : {}), columnFraction })
        }
      }),
      this.language.of(this.languageExtensions()),
      EditorView.theme({ '&': { height: '100%', fontSize: '13.5px', lineHeight: '1.65' },
        '.cm-scroller': { overflow: 'auto', fontFamily: EDITOR_FONT_FAMILY },
        '.cm-content': { padding: '16px 0' }, '.cm-gutters': { backgroundColor: '#fafbfe', borderRight: '1px solid #e9edf5', paddingRight: '4px' },
        '.cm-activeLine': { backgroundColor: 'rgba(59, 88, 235, 0.12)' },
        '.cm-line.cm-sync-flash': { backgroundColor: 'rgba(251, 191, 36, 0.42) !important', boxShadow: 'inset 4px 0 0 #ea580c', borderRadius: '2px' },
        '.cm-sync-word-flash': { backgroundColor: '#fbbf24 !important', color: '#111827 !important', boxShadow: '0 0 0 2px #d97706', borderRadius: '3px', fontWeight: '600' },
        '&.cm-focused': { outline: 'none' } })
    ]
    this.view = new EditorView({ parent, state: this.state('', true) })
    this.unsubscribeLocale = subscribeLocale(() => {
      this.view.dispatch({ effects: this.language.reconfigure(this.languageExtensions()), annotations: Transaction.addToHistory.of(false) })
    })
  }

  private languageExtensions(): Extension {
    return [EditorState.phrases.of(editorPhrases()),
      EditorView.contentAttributes.of({ 'aria-label': translate('本地源文件编辑器'), spellcheck: 'false' })]
  }

  private state(content: string, readOnly: boolean): EditorState {
    return EditorState.create({ doc: content,
      extensions: [...this.extensions, EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)] })
  }

  show(content: string, readOnly = false): void {
    this.loading = true
    try { this.view.setState(this.state(content, readOnly)) }
    finally { this.loading = false }
  }

  runCommand(command: 'undo' | 'redo' | 'bold' | 'italic' | 'search'): void {
    // The panel focuses its own field; focusing the text here would leave the user typing into the paper.
    if (command === 'search') { openSearchPanel(this.view); return }
    if (this.view.state.facet(EditorState.readOnly)) return
    if (command === 'undo' || command === 'redo') { (command === 'undo' ? undo : redo)(this.view); this.view.focus(); return }
    const { from, to } = this.view.state.selection.main
    const selected = this.view.state.sliceDoc(from, to), macro = command === 'bold' ? 'textbf' : 'textit'
    const start = from + macro.length + 2
    this.view.dispatch({ changes: { from, to, insert: `\\${macro}{${selected}}` },
      selection: { anchor: start, head: start + selected.length }, scrollIntoView: true })
    this.view.focus()
  }

  revealLine(line: number, word?: string): void {
    if (!Number.isFinite(line) || !Number.isInteger(line) || line < 1) return
    const clampedLine = Math.min(line, this.view.state.doc.lines)
    const fallbackLine = this.view.state.doc.line(clampedLine)
    const wordHit = word ? findWordInNearbyLines(this.view.state.doc, clampedLine, word) : null
    const targetFrom = wordHit ? wordHit.from : fallbackLine.from
    const targetTo = wordHit ? wordHit.to : fallbackLine.from
    const lineFrom = wordHit ? wordHit.lineFrom : fallbackLine.from
    if (this.flashTimer !== null) { clearTimeout(this.flashTimer); this.flashTimer = null }
    this.view.dispatch({
      selection: wordHit ? { anchor: targetFrom, head: targetTo } : { anchor: targetFrom },
      effects: [
        EditorView.scrollIntoView(targetFrom, { y: 'center' }),
        flashLineEffect.of(wordHit ? { lineFrom, wordFrom: wordHit.from, wordTo: wordHit.to } : { lineFrom })
      ],
      annotations: Transaction.addToHistory.of(false)
    })
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null
      this.view.dispatch({ effects: flashLineEffect.of(null), annotations: Transaction.addToHistory.of(false) })
    }, 4500)
    this.view.focus()
  }

  focus(): void { this.view.focus() }
  destroy(): void {
    if (this.flashTimer !== null) { clearTimeout(this.flashTimer); this.flashTimer = null }
    this.unsubscribeLocale(); this.view.destroy()
  }
}
