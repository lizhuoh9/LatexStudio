import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, foldGutter, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { latexIndentService } from '../vendor/ayakaleaf/latex-indent-service'
import { latexCompletions } from './latex-completions'
import { subscribeLocale, translate } from '../shared/i18n'
import { editorPhrases } from './editor-phrases'

export class SourceEditor {
  private view: EditorView
  private loading = false
  private language = new Compartment()
  private unsubscribeLocale: () => void
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
      this.language.of(this.languageExtensions()),
      EditorView.theme({ '&': { height: '100%', fontSize: '13.5px', lineHeight: '1.65' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace' },
        '.cm-content': { padding: '16px 0' }, '.cm-gutters': { backgroundColor: '#fafbfe', borderRight: '1px solid #e9edf5', paddingRight: '4px' },
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
  destroy(): void { this.unsubscribeLocale(); this.view.destroy() }
}
