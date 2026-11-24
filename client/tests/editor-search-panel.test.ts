import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { listMatches, matchIndex, nearestMatch, sourceQuery, type SearchFields } from '../src/renderer/editor-search-panel'
import { editorPhrases } from '../src/renderer/editor-phrases'
import { setLocale } from '../src/shared/i18n'

const fields = (search: string, extra: Partial<SearchFields> = {}): SearchFields =>
  ({ search, replace: '', caseSensitive: false, wholeWord: false, regexp: false, ...extra })
const state = (doc: string): EditorState => EditorState.create({ doc })

describe('source find bar queries', () => {
  it.each(['\\newcommand', '\\textbf', '\\ref', '\\\\'])('finds the LaTeX command %s as typed, not as an escape sequence', command => {
    // Arrange
    const doc = state(`intro ${command}{x} and again ${command}{y}`)

    // Act
    const found = listMatches(doc, sourceQuery(fields(command)))

    // Assert
    expect(found.spans).toHaveLength(2)
    expect(doc.sliceDoc(found.spans[0]!.from, found.spans[0]!.to)).toBe(command)
  })

  it('honours case, whole-word and regular-expression options', () => {
    const doc = state('Figure figure figures FIGURE')
    expect(listMatches(doc, sourceQuery(fields('figure'))).spans).toHaveLength(4)
    expect(listMatches(doc, sourceQuery(fields('figure', { caseSensitive: true }))).spans).toHaveLength(2)
    expect(listMatches(doc, sourceQuery(fields('figure', { wholeWord: true }))).spans).toHaveLength(3)
    expect(listMatches(doc, sourceQuery(fields('fig\\w+s', { regexp: true }))).spans).toHaveLength(1)
  })

  it('reports nothing for an empty or invalid pattern instead of throwing', () => {
    const doc = state('a (b) c')
    expect(listMatches(doc, sourceQuery(fields(''))).spans).toEqual([])
    expect(listMatches(doc, sourceQuery(fields('(', { regexp: true }))).spans).toEqual([])
    expect(nearestMatch(doc, sourceQuery(fields('(', { regexp: true })), 0)).toBeNull()
    expect(listMatches(doc, sourceQuery(fields('('))).spans).toEqual([{ from: 2, to: 3 }])
  })

  it('stops counting at the limit and says so', () => {
    const found = listMatches(state('ab '.repeat(50)), sourceQuery(fields('ab')), 20)
    expect(found.spans).toHaveLength(20)
    expect(found.capped).toBe(true)
    expect(listMatches(state('ab '.repeat(20)), sourceQuery(fields('ab')), 20).capped).toBe(false)
  })

  it('numbers the selected match and ignores a selection that is not a match', () => {
    const { spans } = listMatches(state('x1 x2 x3'), sourceQuery(fields('x')))
    expect(matchIndex(spans, { from: 3, to: 4 })).toBe(1)
    expect(matchIndex(spans, { from: 3, to: 5 })).toBe(-1)
    expect(matchIndex([], { from: 0, to: 0 })).toBe(-1)
  })

  it('picks the first match at or after the caret and wraps to the start', () => {
    const doc = state('cat dog cat'), query = sourceQuery(fields('cat'))
    expect(nearestMatch(doc, query, 0)).toEqual({ from: 0, to: 3 })
    expect(nearestMatch(doc, query, 1)).toEqual({ from: 8, to: 11 })
    expect(nearestMatch(doc, query, 9)).toEqual({ from: 0, to: 3 })
    expect(nearestMatch(doc, sourceQuery(fields('bird')), 0)).toBeNull()
  })
})

describe('find bar phrases', () => {
  const labels = ['Find', 'Replace', 'Replace all', 'Match case', 'Whole word', 'Regular expression', 'Previous match',
    'Next match', 'Close', 'Show or hide replace', 'No results', 'Invalid pattern']
  it.each(['zh-CN', 'ko'] as const)('has every label in %s', locale => {
    setLocale(locale)
    try {
      const phrases = editorPhrases()
      for (const label of labels) { expect(phrases[label], label).toBeTruthy(); expect(phrases[label]).not.toBe(label) }
    } finally { setLocale('zh-CN') }
  })
})
