import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { findAllInPdfPage, indexPdfPage, type PdfTextItem } from '../src/shared/comment-anchor'
import { translate } from '../src/shared/i18n'
import { PDF_FIND_LIMITS, PdfFindModel, type PdfFindState } from '../src/renderer/pdf-find'
import type { PdfPageText } from '../src/renderer/pdf-view'

const CHAR = 6
/** One text item per line, 6pt per character, lines 14pt apart. */
function lines(...texts: string[]): PdfTextItem[] {
  return texts.map((str, index) => ({ str, x: 72, y: 100 + index * 14, width: str.length * CHAR, height: 10 }))
}
const page = (...texts: string[]): PdfPageText => ({ width: 600, height: 800, items: lines(...texts) })

function fixture(pages: (PdfPageText | null)[]) {
  const states: { state: PdfFindState; reveal: boolean }[] = []
  const source = { pageCount: pages.length, pageText: vi.fn(async (number: number) => pages[number - 1] ?? null) }
  const model = new PdfFindModel(source, (state, reveal) => { states.push({ state, reveal }) })
  return { model, source, states, last: () => states.at(-1)!.state }
}

describe('finding text on one PDF page', () => {
  it('returns every occurrence in reading order with a box around just the matched characters', () => {
    const found = findAllInPdfPage(indexPdfPage(lines('The model and the Model', 'remodel')), 'model', 50)
    expect(found).toHaveLength(3)
    expect(found[0]).toEqual([{ x: 72 + 4 * CHAR, y: 100, width: 5 * CHAR, height: 10 }])
    expect(found[1]![0]!.x).toBeCloseTo(72 + 18 * CHAR)
    expect(found[2]![0]!.y).toBe(114)
  })

  it('ignores case, accents, punctuation, spacing and a word split across lines', () => {
    const index = indexPdfPage(lines('A state-of-the-art résumé for docu-', 'ment handling.'))
    expect(findAllInPdfPage(index, 'State of the Art', 10)).toHaveLength(1)
    expect(findAllInPdfPage(index, 'resume', 10)).toHaveLength(1)
    const split = findAllInPdfPage(index, 'document', 10)
    expect(split).toHaveLength(1)
    expect(split[0]!.map(rect => rect.y)).toEqual([100, 114])
  })

  it('finds Chinese text and never reports overlapping occurrences', () => {
    expect(findAllInPdfPage(indexPdfPage(lines('本文提出一种方法，该方法有效。')), '方法', 10)).toHaveLength(2)
    expect(findAllInPdfPage(indexPdfPage(lines('aaaa')), 'aa', 10)).toHaveLength(2)
  })

  it('stops at the limit and finds nothing for a query without letters or digits', () => {
    const index = indexPdfPage(lines('x = x + x - x'))
    expect(findAllInPdfPage(index, 'x', 3)).toHaveLength(3)
    expect(findAllInPdfPage(index, ' = ', 10)).toEqual([])
    expect(findAllInPdfPage(index, '', 10)).toEqual([])
  })
})

describe('searching the whole PDF', () => {
  it('lists matches in page order but selects the first one at or after the page being read', async () => {
    const { model, states, last } = fixture([page('alpha beta'), page('gamma'), page('beta beta'), page('beta')])
    await model.search('beta', 3)
    expect(last().matches.map(match => match.page)).toEqual([1, 3, 3, 4])
    expect(last().current).toBe(1)
    expect(last().searching).toBe(false)
    const jumps = states.filter(entry => entry.reveal)
    expect(jumps).toHaveLength(1)
    expect(jumps[0]!.state.matches[jumps[0]!.state.current]!.page).toBe(3)
  })

  it('steps forwards and backwards with wrap-around and asks for each new match to be shown', async () => {
    const { model, states, last } = fixture([page('one two one'), page('one')])
    await model.search('one')
    expect(last().current).toBe(0)
    model.step(1); model.step(1); expect(last().current).toBe(2)
    model.step(1); expect(last().current).toBe(0)
    model.step(-1); expect(last().current).toBe(2)
    expect(states.at(-1)!.reveal).toBe(true)
  })

  it('reports no match without a jump, and does nothing when stepping through nothing', async () => {
    const { model, states, last } = fixture([page('alpha'), null])
    await model.search('omega')
    expect(last()).toMatchObject({ query: 'omega', matches: [], current: -1, searching: false })
    const count = states.length
    model.step(1)
    expect(states).toHaveLength(count)
    expect(states.some(entry => entry.reveal)).toBe(false)
  })

  it('does not read any page for a blank or punctuation-only query', async () => {
    const { model, source, last } = fixture([page('alpha')])
    await model.search('  ')
    await model.search('...')
    expect(source.pageText).not.toHaveBeenCalled()
    expect(last().matches).toEqual([])
  })

  it('lets a newer search replace one that is still reading pages', async () => {
    let release!: (value: PdfPageText) => void
    const slow = new Promise<PdfPageText>(resolve => { release = resolve })
    const pages = [page('alpha'), page('alpha beta')]
    const states: PdfFindState[] = []
    const source = { pageCount: 2, pageText: vi.fn((number: number) => number === 1 && source.pageText.mock.calls.length === 1 ? slow : Promise.resolve(pages[number - 1]!)) }
    const model = new PdfFindModel(source, state => { states.push(state) })
    const first = model.search('alpha')
    await model.search('beta')
    release(pages[0]!); await first
    expect(states.at(-1)).toMatchObject({ query: 'beta', searching: false })
    expect(states.at(-1)!.matches.map(match => match.page)).toEqual([2])
  })

  it('caps the number of collected matches and marks the result as partial', async () => {
    const dense = page(...Array.from({ length: 60 }, () => 'ab '.repeat(20)))
    const { model, source, last } = fixture([dense, dense, dense])
    await model.search('ab')
    expect(last().matches).toHaveLength(PDF_FIND_LIMITS.matches)
    expect(last().capped).toBe(true)
    expect(source.pageText).toHaveBeenCalledTimes(2)
  })

  it('looks the same words up again after the document changes, keeping the place but not jumping', async () => {
    const pages = [page('beta'), page('beta')]
    const { model, states, last } = fixture(pages)
    await model.search('beta')
    model.step(1)
    expect(last().matches[last().current]!.page).toBe(2)
    pages[0] = page('nothing here'); pages[1] = page('beta and beta')
    const before = states.length
    await model.refresh()
    expect(last().matches.map(match => match.page)).toEqual([2, 2])
    expect(last().current).toBe(0)
    expect(states.slice(before).some(entry => entry.reveal)).toBe(false)
    model.clear()
    expect(last()).toMatchObject({ query: '', matches: [], current: -1 })
  })
})

describe('search hits after their page has been painted', () => {
  it('measures the hits on that page again, moving the marks without jumping or losing the selection', async () => {
    // Arrange: equal character widths at first; once "painted", the line turns out to start with narrow letters.
    const first = page('iiii FSI and FSI'), second = page('FSI')
    let painted = false
    const narrow = (str: string): Float64Array => {
      const widths = [...str].map(ch => ch === 'i' ? 1 : 3), total = widths.reduce((sum, width) => sum + width, 0)
      return Float64Array.from([0, ...widths.map((_, index) => widths.slice(0, index + 1).reduce((sum, width) => sum + width, 0) / total)])
    }
    const states: { state: PdfFindState; reveal: boolean }[] = []
    const source = { pageCount: 2, pageText: vi.fn(async (number: number) => [first, second][number - 1] ?? null),
      textEdges: (item: PdfTextItem) => painted && item === first.items[0] ? narrow(item.str) : null }
    const model = new PdfFindModel(source, (state, reveal) => { states.push({ state, reveal }) })
    await model.search('FSI')
    model.step(1)
    const before = states.at(-1)!.state, count = states.length

    // Act + Assert: nothing to correct yet, and pages without hits are ignored.
    model.remeasure(1); model.remeasure(7)
    expect(states).toHaveLength(count)

    painted = true
    model.remeasure(1)
    const after = states.at(-1)!
    expect(states).toHaveLength(count + 1)
    expect(after.reveal).toBe(false)
    expect(after.state.current).toBe(1)
    expect(after.state.matches.map(match => match.page)).toEqual([1, 1, 2])
    expect(after.state.matches[0]!.rects[0]!.x).toBeCloseTo(72 + 96 * 7 / 40, 9) // four narrow letters and a space
    expect(after.state.matches[0]!.rects[0]!.x).toBeLessThan(before.matches[0]!.rects[0]!.x)
    expect(after.state.matches[2]).toBe(before.matches[2]) // the other page is untouched

    model.remeasure(1)
    expect(states).toHaveLength(count + 1) // already exact
    model.step(1)
    expect(states.at(-1)!.state.current).toBe(2)
  })
})

describe('PDF find markup and catalog', () => {
  const markup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  it('adds a find button to the PDF controls and a hidden find bar pinned inside the scrolling page area', () => {
    expect(markup).toMatch(/<div class="pdf-controls"><button id="pdf-find-open" class="icon-button"[^>]*aria-controls="pdf-find" aria-expanded="false">/)
    expect(markup).toMatch(/<div class="pdf-scroll"><div class="pdf-find-anchor"><div id="pdf-find" class="find-bar pdf-find" role="search"[^>]* hidden>/)
    for (const id of ['pdf-find-input', 'pdf-find-count', 'pdf-find-previous', 'pdf-find-next', 'pdf-find-close']) expect(markup).toContain(`id="${id}"`)
    expect(markup.indexOf('id="pdf-find"')).toBeLessThan(markup.indexOf('id="pdf-pages"'))
  })
  it.each(['en', 'ko'] as const)('translates every fixed find label into %s', locale => {
    for (const text of ['在 PDF 中查找', '在 PDF 中查找（Ctrl+F / ⌘F）', '上一处', '上一处（Shift+Enter）', '下一处', '下一处（Enter）',
      '关闭查找', '关闭查找（Esc）', '无结果']) {
      expect(markup + '无结果', text).toContain(text)
      expect(translate(text, locale), text).not.toMatch(/[㐀-鿿]/)
    }
  })
})
