import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { environments, snippet, snippetNoIndent } from '../src/vendor/ayakaleaf/environments'
import { latexIndentService } from '../src/vendor/ayakaleaf/latex-indent-service'
import { adaptSnippet, latexCompletions } from '../src/renderer/latex-completions'

describe('pinned AyakaLeaf LaTeX source integration', () => {
  it('reuses actual upstream environment templates rather than only CM dependencies', () => {
    expect(environments.size).toBe(23)
    expect(environments.get('figure')).toContain('\\includegraphics[width=0.5\\linewidth]')
    expect(environments.get('table')).toContain('\\begin{tabular}')
    expect(snippet('align')).toBe('\\begin{align}\n\t$1\n\\end{align}')
    expect(snippetNoIndent('document')).toBe('\\begin{document}\n$1\n\\end{document}')
  })
  it('installs the upstream independent indentation extension', () => {
    expect(EditorState.create({ extensions: [latexIndentService()] }).doc.length).toBe(0)
  })
  it('adapts bare upstream tabstops without changing named placeholders', () => {
    expect(adaptSnippet('line $1 ${2:Caption} $3')).toBe('line ${1} ${2:Caption} ${3}')
  })
  it('offers upstream environment snippets inside a begin command', () => {
    const state = EditorState.create({ doc: '\\begin{fi' })
    const result = latexCompletions(new CompletionContext(state, state.doc.length, false))
    expect(result?.from).toBe(0)
    expect(result?.options.some((option) => option.label === '\\begin{figure}')).toBe(true)
  })
  it('does not spontaneously offer environment templates in ordinary prose', () => {
    const state = EditorState.create({ doc: 'plain text' })
    expect(latexCompletions(new CompletionContext(state, state.doc.length, false))).toBeNull()
  })
})
