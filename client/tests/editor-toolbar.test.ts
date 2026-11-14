import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { history } from '@codemirror/commands'
import { describe, expect, it, vi } from 'vitest'
import { SourceEditor } from '../src/renderer/editor-view'
function fixture(readOnly = false) {
  let state = EditorState.create({ doc: 'selected text', selection: { anchor: 0, head: 8 }, extensions: [history(), EditorState.readOnly.of(readOnly)] })
  const focus = vi.fn(), editor = Object.create(SourceEditor.prototype) as SourceEditor
  const dispatch = (...specs: (TransactionSpec | Transaction)[]): void => { state = specs[0] instanceof Transaction ? specs[0].state : state.update(...specs as TransactionSpec[]).state }
  Object.defineProperty(editor, 'view', { value: { get state() { return state }, dispatch, focus } })
  return { editor, focus, state: () => state }
}
describe('editor toolbar uses the current CodeMirror document, not a second draft store', () => {
  it.each([['bold', 'textbf'], ['italic', 'textit']] as const)('wraps the selected source for %s', (command, macro) => {
    const item = fixture(); item.editor.runCommand(command)
    expect(item.state().doc.toString()).toBe(`\\${macro}{selected} text`)
    expect(item.state().sliceDoc(item.state().selection.main.from, item.state().selection.main.to)).toBe('selected')
    expect(item.focus).toHaveBeenCalledOnce()
  })
  it('uses the actual undo/redo history for source edits', () => {
    const item = fixture(); item.editor.runCommand('bold'); item.editor.runCommand('undo')
    expect(item.state().doc.toString()).toBe('selected text')
    item.editor.runCommand('redo'); expect(item.state().doc.toString()).toBe('\\textbf{selected} text')
  })
  it.each(['bold', 'italic', 'undo', 'redo'] as const)('does not mutate a read-only buffer through %s', command => {
    const item = fixture(true); item.editor.runCommand(command)
    expect(item.state().doc.toString()).toBe('selected text'); expect(item.focus).not.toHaveBeenCalled()
  })
})
