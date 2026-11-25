import { afterEach, describe, expect, it, vi } from 'vitest'
import { findAllInPdfPage, indexPdfPage, locateInPdfPage, type PdfTextItem } from '../src/shared/comment-anchor'
import { characterEdges, spaceWeights } from '../src/shared/pdf-text-edges'
import { PdfTextMeasure, type GlyphSource } from '../src/renderer/pdf-text-measure'

/** Narrow and wide letters as in a proportional font (em); a space measures 0.25 in the stand-in font. */
const WIDTHS: Record<string, number> = { i: 0.25, I: 0.35, l: 0.25, F: 0.65, S: 0.55, U: 0.75, n: 0.55, W: 1, m: 0.85, a: 0.5, ' ': 0.25 }
const advances = (text: string): number[] => [...text].map(ch => WIDTHS[ch] ?? 0.5)
const stretch = (text: string): number[] => [...text].map(ch => ch === ' ' ? 1 : 0)
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

describe('character boundaries inside one PDF text run', () => {
  it('keeps letter widths and gives the rest of a justified line to its spaces when the widths are the font\'s own', () => {
    // Arrange: the line is 2em wider than its letters, so each of its two spaces is 1em (stretched).
    const text = 'UniFSI a FSI', letters = sum(advances(text.replaceAll(' ', ''))), run = letters + 2

    // Act
    const edges = characterEdges(advances(text), stretch(text), run, true)!

    // Assert
    expect(edges).toHaveLength(text.length + 1)
    expect(edges[0]).toBe(0)
    expect(edges[text.length]).toBeCloseTo(1, 12)
    expect(edges[3]! * run).toBeCloseTo(0.75 + 0.55 + 0.25, 12) // "Uni" keeps its own width
    expect((edges[7]! - edges[6]!) * run).toBeCloseTo(1, 12) // the first space absorbs the stretch
    expect((edges[12]! - edges[9]!) * run).toBeCloseTo(0.65 + 0.55 + 0.35, 12) // the last "FSI"
  })

  it('scales everything to the run when the widths come from a stand-in font', () => {
    const text = 'Wi i', run = 6
    const edges = characterEdges(advances(text), stretch(text), run, false)!
    const total = sum(advances(text))
    expect(edges[1]).toBeCloseTo(1 / total, 12)
    expect(edges[2]).toBeCloseTo(1.25 / total, 12)
    expect(edges[4]).toBeCloseTo(1, 12)
  })

  it('falls back to scaling when the own-font widths would leave an implausible space', () => {
    const text = 'Wi i'
    const squeezed = characterEdges(advances(text), stretch(text), 1.5, true)! // letters alone are 1.5em: no room for a space
    const loose = characterEdges(advances(text), stretch(text), 40, true)!
    const scaled = characterEdges(advances(text), stretch(text), 1.5, false)!
    expect([...squeezed]).toEqual([...scaled])
    expect([...loose]).toEqual([...scaled])
  })

  it('never goes backwards and tolerates unusable measurements', () => {
    const edges = characterEdges([0.5, Number.NaN, -3, 0.5], [0, 0, 0, 0], 2, false)!
    expect([...edges]).toEqual([0, 0.5, 0.5, 0.5, 1])
    expect(characterEdges([0, 0], [0, 0], 2, true)).toBeNull()
    expect(characterEdges([], [], 2, true)).toBeNull()
    expect(characterEdges([0.5, 0.5], [0], 2, true)).toBeNull()
  })

  it('gives the space after a sentence a larger share of the slack than the other spaces on the line', () => {
    // Arrange: three letters of 0.5em and two spaces, the first after a full stop; 1.3em is left for the spaces.
    const text = 'a. a a', weights = spaceWeights([...text]), run = 2 + 1.3

    // Act
    const edges = characterEdges(advances(text), weights, run, true)!

    // Assert: 1.3em split 1.6 : 1.
    expect(weights).toEqual([0, 0, 1.6, 0, 1, 0])
    expect((edges[3]! - edges[2]!) * run).toBeCloseTo(0.8, 12)
    expect((edges[5]! - edges[4]!) * run).toBeCloseTo(0.5, 12)
  })
})

describe('which spaces TeX sets wider', () => {
  const weights = (text: string): number[] => spaceWeights([...text]).filter(weight => weight > 0)

  it('widens the space after a sentence, also behind closing brackets and quotes', () => {
    expect(weights('end. Next')).toEqual([1.6])
    expect(weights('why? Because! Yes')).toEqual([1.6, 1.6])
    expect(weights('(see below.) Next')).toEqual([1, 1.6])
    expect(weights('he said “stop.” Then')).toEqual([1, 1, 1.6])
    expect(weights('as follows: first')).toEqual([1, 1.3])
    expect(weights('UniFSI: A solver')).toEqual([1, 1])
  })

  it('keeps an ordinary space after a capital letter and full stop, after commas and between words', () => {
    expect(weights('interaction (FSI). We present')).toEqual([1, 1, 1])
    expect(weights('by D. Knuth, and others')).toEqual([1, 1, 1, 1])
    expect(weights('a b\u00a0c')).toEqual([1, 1])
    expect(weights('. leading')).toEqual([1.6])
    expect(spaceWeights([])).toEqual([])
  })
})

describe('highlight position of a match inside a long line', () => {
  const line = 'iiiiiiii FSI WWWWWWWW FSI'
  const item: PdfTextItem = { str: line, x: 100, y: 50, width: 200, height: 10 }
  const edgesOf = (text: string) => characterEdges(advances(text), stretch(text), sum(advances(text)), false)!

  it('uses the supplied character boundaries instead of assuming every character is equally wide', () => {
    // Arrange
    const edges = edgesOf(line), measure = vi.fn(() => edges)

    // Act
    const [first, second] = findAllInPdfPage(indexPdfPage([item], measure), 'fsi', 10)

    // Assert: the first hit starts after eight narrow letters and a space, not at 9/25 of the line.
    const total = sum(advances(line))
    expect(first![0]!.x).toBeCloseTo(100 + 200 * (8 * 0.25 + 0.25) / total, 9)
    expect(first![0]!.width).toBeCloseTo(200 * (0.65 + 0.55 + 0.35) / total, 9)
    expect(second![0]!.x + second![0]!.width).toBeCloseTo(300, 9)
    expect(first![0]!.x).toBeLessThan(100 + 200 * 9 / 25 - 20)
  })

  it('places a comment the same way', () => {
    const found = locateInPdfPage(indexPdfPage([item], () => edgesOf(line)), { quote: 'WWWWWWWW', before: '', after: '' })!
    const total = sum(advances(line))
    expect(found.rects[0]!.width).toBeCloseTo(200 * 8 / total, 9)
  })

  it('assumes equal widths when no boundaries are available or they do not fit the text', () => {
    const equal = findAllInPdfPage(indexPdfPage([item]), 'fsi', 10)
    for (const measure of [() => null, () => new Float64Array(5), () => { throw new Error('measurement failed') }]) {
      expect(findAllInPdfPage(indexPdfPage([item], measure), 'fsi', 10)).toEqual(equal)
    }
    expect(equal[0]![0]!.x).toBeCloseTo(100 + 200 * 9 / 25, 9)
  })

  it('counts a character outside the BMP as one boundary step', () => {
    const text = '𠮷𠮷 FSI', wide: PdfTextItem = { str: text, x: 0, y: 0, width: 60, height: 10 }
    const edges = Float64Array.from([0, 0.3, 0.6, 0.7, 0.8, 0.9, 1])
    const [hit] = findAllInPdfPage(indexPdfPage([wide], () => edges), 'FSI', 5)
    expect(hit![0]!.x).toBeCloseTo(42, 9)
    expect(hit![0]!.width).toBeCloseTo(18, 9)
  })
})

describe('measuring a run with the fonts that are available', () => {
  function glyphs(loaded: Set<string>): GlyphSource & { advance: ReturnType<typeof vi.fn> } {
    return { loaded: font => loaded.has(font), reset: vi.fn(), refresh: vi.fn(),
      // The PDF's own font is twice as wide as the stand-in for capitals, so the two give different boundaries.
      advance: vi.fn((fonts: string, ch: string) => (WIDTHS[ch] ?? 0.5) * (fonts.startsWith('"g_d0_f1"') && /[A-Z]/.test(ch) ? 2 : 1)) }
  }
  const run = (str: string, extra: Partial<PdfTextItem> = {}): PdfTextItem => ({ str, x: 0, y: 0, width: 100, height: 10, ...extra })

  it('measures with the PDF\'s own font once it is loaded, and with the generic family before that', () => {
    // Arrange
    const loaded = new Set<string>(), source = glyphs(loaded), measure = new PdfTextMeasure(source)
    const item = run('ii FSI', { font: 'g_d0_f1', family: 'serif', ems: 4.35 })

    // Act
    const before = Array.from(measure.edges(item)!)
    measure.edges(item)
    const calls = source.advance.mock.calls.length
    loaded.add('g_d0_f1')
    const after = Array.from(measure.edges(item)!)
    measure.edges(item)

    // Assert
    expect(source.advance.mock.calls[0]![0]).toBe('serif')
    expect(calls).toBe(6) // measured once, then remembered
    expect(source.advance.mock.calls.slice(6).map(call => call[0])).toEqual(Array.from({ length: 6 }, () => ['"g_d0_f1", serif', '"g_d0_f1", monospace']).flat())
    expect(source.advance.mock.calls.length).toBe(18) // measured once more with the real font, then remembered
    expect(after[3]! - after[2]!).toBeCloseTo((4.35 - 0.5 - 3.1) / 4.35, 12) // the space takes what the letters leave
    expect(after).not.toEqual(before)
  })

  it('counts the letters of a ligature as wide as the ligature glyph when the PDF font has one', () => {
    // Arrange: every letter is 0.5em; font f1 has an "ffi" glyph of 0.9em, font f2 has none (the fallback answers).
    const widths = (fonts: string, ch: string): number => {
      if (ch < '\uFB00' || ch > '\uFB04') return 0.5
      if (ch === '\uFB03' && fonts.startsWith('"g_d0_f1"')) return 0.9
      return fonts.endsWith('monospace') ? 0.6 : 0.8 // not in the PDF font: each fallback answers differently
    }
    const source: GlyphSource = { loaded: () => true, advance: vi.fn(widths) }
    const measure = new PdfTextMeasure(source)

    // Act
    const withGlyph = measure.edges(run('office x', { font: 'g_d0_f1', family: 'serif', ems: 5 }))!
    const without = measure.edges(run('office x', { font: 'g_d0_f2', family: 'serif', ems: 5 }))!

    // Assert: "o" + "ffi" (0.9) + "ce" + "x" = 2.9em of letters, so the space is 2.1em; without the glyph 3.5 and 1.5.
    expect((withGlyph[4]! - withGlyph[1]!) * 5).toBeCloseTo(0.9, 12)
    expect((withGlyph[7]! - withGlyph[6]!) * 5).toBeCloseTo(2.1, 12)
    expect((without[4]! - without[1]!) * 5).toBeCloseTo(1.5, 12)
    expect((without[7]! - without[6]!) * 5).toBeCloseTo(1.5, 12)
  })

  it('does not trust the PDF font for a run whose characters it mostly lacks', () => {
    // Arrange: the "own" font has none of these letters, so the window draws them in whatever fallback follows it.
    const advance = vi.fn((fonts: string, ch: string) => (WIDTHS[ch] ?? 0.5) * (fonts.endsWith('monospace') ? 1.2 : 1))
    const text = 'ii FSI', item = run(text, { font: 'g_d0_f1', family: 'serif', ems: 9 })

    // Act
    const edges = Array.from(new PdfTextMeasure({ loaded: () => true, advance }).edges(item)!)

    // Assert: widths from the generic family, scaled to the run; the 9em run does not stretch the space to 6.95em.
    expect(edges).toEqual(Array.from(characterEdges(advances(text), stretch(text), 9, false)!))
    expect(advance.mock.calls.some(call => call[0] === 'serif')).toBe(true)
  })

  it('never passes a font or family name from the PDF into the font list unchecked', () => {
    const source = glyphs(new Set(['x", serif; }', 'g_d0_f1'])), measure = new PdfTextMeasure(source)
    measure.edges(run('ab', { font: 'x", serif; }', family: 'Comic Sans MS, "evil"' }))
    expect(source.advance.mock.calls.map(call => call[0])).toEqual(['sans-serif', 'sans-serif'])
  })

  it('gives no boundaries for a single character, an oversized run or a failed measurement', () => {
    const source = glyphs(new Set()), measure = new PdfTextMeasure(source)
    expect(measure.edges(run('a'))).toBeNull()
    expect(measure.edges(run('a'.repeat(5000)))).toBeNull()
    expect(source.advance).not.toHaveBeenCalled()
    source.advance.mockReturnValue(null)
    expect(measure.edges(run('ab'))).toBeNull()
  })

  it('works without a browser canvas by reporting that it cannot measure', () => {
    expect(new PdfTextMeasure().edges(run('no canvas here'))).toBeNull()
  })
})

describe('measuring with the window canvas and the fonts PDF.js has loaded', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  /** A window whose canvas knows one PDF font, g_d0_f1: it has the letters (capitals twice as wide as the generic
   * ones) but no space, so a space is measured in whatever family follows it in the font list.
   */
  function browser(faces: { family: string; status: string }[]) {
    const clock = { now: 1000 }, asked: string[] = []
    const context = { font: '', measureText: vi.fn((character: string) => {
      asked.push(context.font)
      const own = context.font.includes('"g_d0_f1"') && /[A-Za-z]/.test(character)
      const em = own ? (WIDTHS[character] ?? 0.5) * (/[A-Z]/.test(character) ? 2 : 1) : context.font.endsWith('monospace') ? 0.6 : WIDTHS[character] ?? 0.5
      return { width: em * 100 }
    }) }
    const getContext = vi.fn((): typeof context | null => context)
    vi.stubGlobal('document', { fonts: { forEach: (visit: (face: { family: string; status: string }) => void) => { faces.forEach(visit) } }, createElement: () => ({ getContext }) })
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
    return { clock, asked, context, getContext }
  }
  const line = (): PdfTextItem => ({ str: 'ii FSI', x: 0, y: 0, width: 100, height: 10, font: 'g_d0_f1', family: 'serif', ems: 4.35 })
  const ownSpace = (4.35 - 0.5 - 3.1) / 4.35

  it('uses a PDF font once the window lists it as loaded, looking again at most every quarter of a second', () => {
    // Arrange: PDF.js has registered the font (the family name may come back quoted) but it is still loading.
    const faces = [{ family: '"g_d0_f1"', status: 'loading' }], { clock, asked } = browser(faces)
    const measure = new PdfTextMeasure(), item = line()

    // Act
    const generic = Array.from(measure.edges(item)!)
    faces[0]!.status = 'loaded'
    const tooSoon = Array.from(measure.edges(item)!)
    clock.now += 300
    const own = Array.from(measure.edges(item)!)

    // Assert
    expect(asked.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => '100px serif')) // i, space, F, S, I: once each
    expect(tooSoon).toEqual(generic)
    expect(own).not.toEqual(generic)
    expect(own[3]! - own[2]!).toBeCloseTo(ownSpace, 12)
    expect(asked).toContain('100px "g_d0_f1", serif')
    expect(asked).toContain('100px "g_d0_f1", monospace')
  })

  it('looks again at once after a page has been painted, and forgets the fonts with their document', () => {
    const faces = [{ family: 'g_d0_f1', status: 'loading' }], { asked } = browser(faces)
    const measure = new PdfTextMeasure(), item = line()
    const generic = Array.from(measure.edges(item)!)
    faces[0]!.status = 'loaded'
    measure.fontsChanged()
    const own = Array.from(measure.edges(item)!)
    expect(own[3]! - own[2]!).toBeCloseTo(ownSpace, 12)
    faces.length = 0
    measure.reset()
    const count = asked.length
    expect(Array.from(measure.edges(line())!)).toEqual(generic)
    expect(new Set(asked.slice(count))).toEqual(new Set(['100px serif']))
  })

  it('measures each character of a font only once, however many runs use it', () => {
    const { context } = browser([{ family: 'g_d0_f1', status: 'loaded' }]), measure = new PdfTextMeasure()
    measure.edges(line())
    const calls = context.measureText.mock.calls.length
    expect(Array.from(measure.edges(line())!)).toHaveLength(7)
    expect(context.measureText.mock.calls.length).toBe(calls)
    expect(calls).toBe(2 * 5 + 1) // i, F, S, I and the space with either fallback behind the font, then the space in the generic family
  })

  it('does not remember a failed measurement, so the run is measured once the canvas works again', () => {
    const { context, getContext } = browser([]), measure = new PdfTextMeasure(), item = line()
    context.measureText.mockImplementationOnce(() => { throw new Error('canvas lost') })
    expect(measure.edges(item)).toBeNull()
    expect(measure.edges(item)).toHaveLength(7)
    getContext.mockReturnValue(null)
    expect(new PdfTextMeasure().edges(line())).toBeNull() // a window without a 2D context cannot measure at all
  })

  it('falls back to the generic family when the list of loaded fonts cannot be read', () => {
    const { asked } = browser([])
    vi.stubGlobal('document', { ...document, fonts: { forEach: () => { throw new Error('fonts unavailable') } } })
    expect(new PdfTextMeasure().edges(line())).toHaveLength(7)
    expect(new Set(asked)).toEqual(new Set(['100px serif']))
  })
})
