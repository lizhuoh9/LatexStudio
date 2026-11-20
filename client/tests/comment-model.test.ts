import { describe, expect, it } from 'vitest'
import { commentBody, parseCommentEvent, serializeCommentEvent, type CommentEvent } from '../src/shared/comment-contracts'
import { buildThreads } from '../src/shared/comment-threads'
import { indexPdfPage, locateInPdfPage, locateInSource, quoteKey, stripLatexLine, type PdfTextItem } from '../src/shared/comment-anchor'

const alice = { kind: 'github', login: 'alice', id: 42 } as const
const bob = { kind: 'github', login: 'bob-lab', id: 7 } as const
const anchor = { file: 'chapters/intro.tex', line: 3, endLine: 4, quote: 'strong gains', before: 'show', after: 'over', page: 1 }
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const thread = (n: number, at: string, author = alice): CommentEvent => ({ v: 1, type: 'thread', id: id(n), at, author, anchor, body: `body ${n}` })

describe('stored comment events', () => {
  it('round-trips each event type through one fixed-order JSON line', () => {
    const events: CommentEvent[] = [
      thread(1, '2026-11-19T10:00:00.000Z'),
      { v: 1, type: 'reply', id: id(2), at: '2026-11-19T10:01:00.000Z', author: bob, thread: id(1), body: '同意\n第二行' },
      { v: 1, type: 'resolve', id: id(3), at: '2026-11-19T10:02:00.000Z', author: { kind: 'local', device: 'a'.repeat(32) }, thread: id(1) },
      { v: 1, type: 'reopen', id: id(4), at: '2026-11-19T10:03:00.000Z', author: bob, thread: id(1) }
    ]
    for (const event of events) {
      const line = serializeCommentEvent(event)
      expect(line).not.toContain('\n')
      expect(Object.keys(JSON.parse(line)).slice(0, 5)).toEqual(['v', 'type', 'id', 'at', 'author'])
      expect(parseCommentEvent(JSON.parse(line))).toEqual(event)
    }
  })

  it.each([
    ['an unknown key', { ...thread(1, '2026-11-19T10:00:00.000Z'), extra: true }],
    ['a newer format', { ...thread(1, '2026-11-19T10:00:00.000Z'), v: 2 }],
    ['a non-UUID id', { ...thread(1, '2026-11-19T10:00:00.000Z'), id: 'abc' }],
    ['an impossible time', thread(1, '2026-02-30T10:00:00.000Z')],
    ['an invalid login', { ...thread(1, '2026-11-19T10:00:00.000Z'), author: { kind: 'github', login: '-bad', id: 1 } }],
    ['a zero account id', { ...thread(1, '2026-11-19T10:00:00.000Z'), author: { kind: 'github', login: 'ok', id: 0 } }],
    ['an absolute source path', { ...thread(1, '2026-11-19T10:00:00.000Z'), anchor: { ...anchor, file: '/etc/passwd' } }],
    ['a parent-directory path', { ...thread(1, '2026-11-19T10:00:00.000Z'), anchor: { ...anchor, file: '../x.tex' } }],
    ['an inverted line span', { ...thread(1, '2026-11-19T10:00:00.000Z'), anchor: { ...anchor, endLine: 2 } }],
    ['an empty quote', { ...thread(1, '2026-11-19T10:00:00.000Z'), anchor: { ...anchor, quote: '  ' } }],
    ['a control character', { ...thread(1, '2026-11-19T10:00:00.000Z'), body: 'a\u0007b' }],
    ['an untrimmed body', { ...thread(1, '2026-11-19T10:00:00.000Z'), body: ' padded ' }],
    ['a reply without thread', { v: 1, type: 'reply', id: id(2), at: '2026-11-19T10:01:00.000Z', author: bob, body: 'x' }]
  ])('rejects %s instead of guessing', (_name, value) => {
    expect(parseCommentEvent(JSON.parse(JSON.stringify(value)))).toBeNull()
  })

  it('normalizes and bounds bodies', () => {
    expect(commentBody('  line one\r\nline two  ')).toBe('line one\nline two')
    expect(commentBody('   ')).toBeNull()
    expect(commentBody('x'.repeat(4001))).toBeNull()
    expect(commentBody('tab\there')).toBeNull()
  })
})

describe('thread folding', () => {
  it('attaches replies written on a device with an earlier clock and applies the latest state change', () => {
    const threads = buildThreads([
      { v: 1, type: 'reply', id: id(5), at: '2026-11-19T09:00:00.000Z', author: bob, thread: id(1), body: 'skewed clock' },
      { v: 1, type: 'resolve', id: id(6), at: '2026-11-19T11:00:00.000Z', author: bob, thread: id(1) },
      thread(1, '2026-11-19T10:00:00.000Z'),
      { v: 1, type: 'reopen', id: id(7), at: '2026-11-19T12:00:00.000Z', author: alice, thread: id(1) },
      { v: 1, type: 'resolve', id: id(8), at: '2026-11-19T13:00:00.000Z', author: alice, thread: id(1) },
      { v: 1, type: 'reply', id: id(9), at: '2026-11-19T13:00:00.000Z', author: alice, thread: id(99), body: 'orphan' }
    ])
    expect(threads).toHaveLength(1)
    expect(threads[0]!.replies.map(reply => reply.body)).toEqual(['skewed clock'])
    expect(threads[0]!.resolved).toEqual({ at: '2026-11-19T13:00:00.000Z', author: alice })
  })

  it('keeps the first copy of a duplicated event and orders threads by time', () => {
    const copy = { ...thread(2, '2026-11-19T08:00:00.000Z'), body: 'later copy' } as CommentEvent
    const threads = buildThreads([thread(1, '2026-11-19T10:00:00.000Z'), thread(2, '2026-11-19T08:00:00.000Z'), copy])
    expect(threads.map(item => [item.id, item.body])).toEqual([[id(2), 'body 2'], [id(1), 'body 1']])
  })

  it('reopening leaves the thread open', () => {
    const threads = buildThreads([thread(1, '2026-11-19T10:00:00.000Z'),
      { v: 1, type: 'resolve', id: id(2), at: '2026-11-19T10:01:00.000Z', author: bob, thread: id(1) },
      { v: 1, type: 'reopen', id: id(3), at: '2026-11-19T10:02:00.000Z', author: bob, thread: id(1) }])
    expect(threads[0]!.resolved).toBeNull()
  })
})

describe('finding the commented text in the source', () => {
  const source = ['\\section{Results}', 'Our method shows strong gains over the baseline. % strong gains in a comment',
    'Earlier work \\cite{smith2020} reported strong gains on small data.', '', 'In Figure~\\ref{fig:a} we see strong gains over the baseline again.'].join('\n')

  it('folds case, accents, width, ligatures and punctuation', () => {
    expect(quoteKey('Ｆﬁne  Café — re-use')).toBe('ffinecafereuse')
    expect(quoteKey('这是“测试”。')).toBe('这是测试')
  })

  it('drops TeX comments, references and command names but keeps argument text', () => {
    expect(stripLatexLine('Results \\textbf{strong} \\cite[p.~2]{smith} 50\\% done % hidden')).not.toMatch(/hidden|smith|textbf/)
    expect(stripLatexLine('caf\\\'e na\\"ive')).toBe('cafe naive')
  })

  it('prefers the occurrence nearest the stored line and uses context to break ties', () => {
    expect(locateInSource(source, { ...anchor, quote: 'strong gains', before: '', after: '', line: 5, endLine: 5 })).toEqual({ line: 5, endLine: 5 })
    expect(locateInSource(source, { ...anchor, quote: 'strong gains', before: 'Our method shows', after: '', line: 5, endLine: 5 })).toEqual({ line: 2, endLine: 2 })
  })

  it('follows text that moved far away and text split over lines', () => {
    const moved = `${'filler line\n'.repeat(400)}${source}`
    expect(locateInSource(moved, { ...anchor, quote: 'Our method shows strong', before: '', after: '', line: 2, endLine: 2 })).toEqual({ line: 402, endLine: 402 })
    const split = 'We observe a\nconsiderable improvement here.'
    expect(locateInSource(split, { ...anchor, quote: 'a considerable improvement', before: '', after: '', line: 9, endLine: 9 })).toEqual({ line: 1, endLine: 2 })
  })

  it('accepts generated text such as a citation number when most words still match', () => {
    const found = locateInSource(source, { ...anchor, quote: 'Earlier work [3] reported strong gains', before: '', after: '', line: 3, endLine: 3 })
    expect(found).toEqual({ line: 3, endLine: 3 })
  })

  it('reports the anchor as lost when the sentence was rewritten', () => {
    expect(locateInSource(source, { ...anchor, quote: 'a completely different claim about robustness', before: '', after: '', line: 2, endLine: 2 })).toBeNull()
    expect(locateInSource(source, { ...anchor, quote: '— …', before: '', after: '', line: 2, endLine: 2 })).toBeNull()
  })
})

describe('finding the commented text on a PDF page', () => {
  const items: PdfTextItem[] = [
    { str: 'Our method shows strong gains over the', x: 72, y: 100, width: 380, height: 10 },
    { str: 'baseline. Later we see strong', x: 72, y: 114, width: 290, height: 10 },
    { str: 'gains over the baseline again.', x: 72, y: 128, width: 300, height: 10 }
  ]
  const page = indexPdfPage(items)

  it('highlights only the matched characters, nearest to the hint', () => {
    const near = locateInPdfPage(page, { quote: 'strong gains', before: '', after: '' }, { x: 72, y: 100 })!
    expect(near.exact).toBe(true)
    expect(near.rects).toHaveLength(1)
    expect(near.rects[0]!.y).toBe(100)
    expect(near.rects[0]!.x).toBeCloseTo(72 + (17 / 38) * 380, 5)
    expect(near.before).toBe('Our method shows')
    const far = locateInPdfPage(page, { quote: 'strong gains', before: '', after: '' }, { x: 72, y: 128 })!
    expect(far.rects.map(rect => rect.y)).toEqual([114, 128])
  })

  it('uses stored context before distance', () => {
    const found = locateInPdfPage(page, { quote: 'strong gains', before: 'Later we see', after: '' }, { x: 72, y: 100 })!
    expect(found.rects[0]!.y).toBe(114)
  })

  it('falls back to a partial match and gives up when too little remains', () => {
    const partial = locateInPdfPage(page, { quote: 'Our method shows huge gains over', before: '', after: '' })
    expect(partial?.exact).toBe(false)
    expect(locateInPdfPage(page, { quote: 'nothing like this sentence at all', before: '', after: '' })).toBeNull()
  })

  it('joins a word split across text items on the same line', () => {
    const split = indexPdfPage([{ str: 'docu', x: 10, y: 10, width: 20, height: 10 }, { str: 'ment ready', x: 30, y: 10, width: 50, height: 10 }])
    expect(locateInPdfPage(split, { quote: 'document ready', before: '', after: '' })?.rects).toHaveLength(1)
  })

  it('returns the matched span as the page reads it, with a space where lines break', () => {
    const found = locateInPdfPage(page, { quote: 'strong gains over thebaseline', before: '', after: '' }, { x: 72, y: 100 })!
    expect(found.text).toBe('strong gains over the baseline')
    expect(found.rects.map(rect => rect.y)).toEqual([100, 114])
  })

  it('keeps words apart when a text item ends with a space', () => {
    const page = indexPdfPage([{ str: 'alpha ', x: 0, y: 0, width: 30, height: 10 }, { str: 'beta gamma delta', x: 30, y: 0, width: 80, height: 10 }])
    expect(locateInPdfPage(page, { quote: 'alpha beta gamma epsilon', before: '', after: '' })?.exact).toBe(false)
  })
})

describe('positions after characters outside the BMP and scattered matches', () => {
  it('keeps source lines and PDF character offsets aligned after astral characters', () => {
    expect(locateInSource('前言𠮷𠮷\n第二行\n这里有需要评论的句子。', { ...anchor, quote: '需要评论的句子', before: '', after: '', line: 1, endLine: 1 }))
      .toEqual({ line: 3, endLine: 3 })
    const page = indexPdfPage([{ str: '𠮷𠮷 then target words here', x: 0, y: 0, width: 250, height: 10 }])
    const found = locateInPdfPage(page, { quote: 'target words', before: '', after: '' })!
    expect(found.rects[0]!.x).toBeCloseTo((8 / 25) * 250, 5)
    expect(found.before).toBe('𠮷𠮷 then')
    expect(found.after).toBe('here')
  })

  it('does not add up common characters spread over a long span', () => {
    const scattered = '甲天地乙天地丙天地丁天地戊天地己天地庚'
    expect(locateInSource(scattered, { ...anchor, quote: '甲乙丙丁戊己庚辛壬癸', before: '', after: '', line: 1, endLine: 1 })).toBeNull()
    expect(locateInSource('甲乙丙丁戊己庚改写后', { ...anchor, quote: '甲乙丙丁戊己庚辛壬癸', before: '', after: '', line: 1, endLine: 1 })).toEqual({ line: 1, endLine: 1 })
  })

  it('finds the occurrence nearest the stored line even after many earlier repeats', () => {
    const source = `${'is a\n'.repeat(600)}target line is a here`
    expect(locateInSource(source, { ...anchor, quote: 'is a', before: 'target line', after: '', line: 601, endLine: 601 })).toEqual({ line: 601, endLine: 601 })
  })
})
