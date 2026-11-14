import { EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, foldGutter, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { latexIndentService } from '../vendor/ayakaleaf/latex-indent-service'
import { latexCompletions } from './latex-completions'

export class SourceEditor {
  private view: EditorView
  private loading = false
  private extensions: Extension[]

  constructor(parent: HTMLElement, changed: (content: string) => void, save: () => void) {
    this.extensions = [
      lineNumbers(), history(), drawSelection(), highlightActiveLine(), foldGutter(),
      bracketMatching(), closeBrackets(), StreamLanguage.define(stex),
      syntaxHighlighting(defaultHighlightStyle), latexIndentService(), highlightSelectionMatches(),
      autocompletion({ override: [latexCompletions] }), EditorView.lineWrapping,
      keymap.of([{ key: 'Mod-s', run: () => { save(); return true } }, indentWithTab,
        ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.loading) changed(update.state.doc.toString())
      }),
      EditorView.contentAttributes.of({ 'aria-label': '本地源文件编辑器', spellcheck: 'false' }),
      EditorView.theme({ '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Cascadia Code", monospace' },
        '.cm-content': { padding: '12px 0' }, '.cm-gutters': { backgroundColor: '#f7f8fa', border: 'none' },
        '&.cm-focused': { outline: 'none' } })
    ]
    this.view = new EditorView({ parent, state: this.state('', true) })
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
    if (command === 'search') { openSearchPanel(this.view); this.view.focus(); return }
    if (this.view.state.facet(EditorState.readOnly)) return
    if (command === 'undo' || command === 'redo') { (command === 'undo' ? undo : redo)(this.view); this.view.focus(); return }
    const { from, to } = this.view.state.selection.main
    const selected = this.view.state.sliceDoc(from, to), macro = command === 'bold' ? 'textbf' : 'textit'
    const start = from + macro.length + 2
    this.view.dispatch({ changes: { from, to, insert: `\\${macro}{${selected}}` },
      selection: { anchor: start, head: start + selected.length }, scrollIntoView: true })
    this.view.focus()
  }

  revealLine(line: number): void {
    if (!Number.isFinite(line) || !Number.isInteger(line) || line < 1) return
    const anchor = this.view.state.doc.line(Math.min(line, this.view.state.doc.lines)).from
    this.view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
      annotations: Transaction.addToHistory.of(false) })
    this.view.focus()
  }

  focus(): void { this.view.focus() }
  destroy(): void { this.view.destroy() }
}
