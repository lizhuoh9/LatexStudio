import type { PdfTextItem } from '../shared/comment-anchor'
import { characterEdges, spaceWeights } from '../shared/pdf-text-edges'

/** Character widths as the window can measure them. */
export interface GlyphSource {
  /** Whether the PDF's own font of this name has been loaded for drawing (PDF.js loads it when a page using it is painted). */
  loaded(font: string): boolean
  /** Width of one character in em for a CSS font list; null when it cannot be measured. */
  advance(fonts: string, character: string): number | null
  /** Fonts may have been loaded since the last look. */
  refresh?(): void
  /** The document went away: its fonts and their measurements are no longer valid. */
  reset?(): void
}

/** PDF.js names its fonts like `g_d0_f12`; anything else from a PDF is never put into a font list. */
const OWN_FONT = /^[A-Za-z0-9_]{1,64}$/
const GENERIC = new Set(['serif', 'sans-serif', 'monospace'])
const LIMITS = Object.freeze({ runCharacters: 4000, cachedWidths: 50_000, rescanMs: 250, sizePx: 100 })
/** Letter groups TeX sets as one narrower glyph when the font has it; PDF.js reports the letters separately. */
const LIGATURES: readonly (readonly [string, string])[] = [['ffi', '\uFB03'], ['ffl', '\uFB04'], ['ff', '\uFB00'], ['fi', '\uFB01'], ['fl', '\uFB02']]
/** A ligature narrower than this share of its letters' widths, or wider than them, is not believed. */
const LIGATURE_MIN_SHARE = 0.5
/** The PDF font's widths count as the run's real widths only when it has at least this share of the run's letters. */
const OWN_COVERAGE = 0.9

/** Measures with an off-screen canvas; every step degrades to "cannot measure" where there is no canvas. */
class CanvasGlyphs implements GlyphSource {
  private context: CanvasRenderingContext2D | null | undefined
  private font = ''
  private scanned = Number.NEGATIVE_INFINITY
  private readonly known = new Set<string>()
  private readonly widths = new Map<string, number>()

  loaded(font: string): boolean {
    if (this.known.has(font)) return true
    const now = performance.now() // monotonic: a wall-clock step back must not postpone the next look
    if (now - this.scanned < LIMITS.rescanMs) return false
    this.scanned = now
    try {
      document.fonts.forEach(face => { if (face.status === 'loaded') this.known.add(face.family.replace(/^["']|["']$/g, '')) })
    } catch { return false }
    return this.known.has(font)
  }

  advance(fonts: string, character: string): number | null {
    const key = `${fonts}\n${character}`, known = this.widths.get(key)
    if (known !== undefined) return known
    const context = this.canvas()
    if (!context) return null
    let width: number
    try {
      if (this.font !== fonts) { context.font = `${LIMITS.sizePx}px ${fonts}`; this.font = fonts }
      width = context.measureText(character).width / LIMITS.sizePx
    } catch { return null }
    if (!Number.isFinite(width)) return null
    if (this.widths.size >= LIMITS.cachedWidths) this.widths.clear()
    this.widths.set(key, width)
    return width
  }

  refresh(): void { this.scanned = Number.NEGATIVE_INFINITY }
  reset(): void { this.known.clear(); this.widths.clear(); this.font = ''; this.refresh() }

  private canvas(): CanvasRenderingContext2D | null {
    if (this.context === undefined) {
      try { this.context = document.createElement('canvas').getContext('2d') } catch { this.context = null }
    }
    return this.context ?? null
  }
}

/** `own`: the run's own font was loaded when it was measured, so measuring again cannot improve on it. */
interface Measured { own: boolean; edges: Float64Array }

/** Character boundaries of PDF text runs, measured with the PDF's own font when the window has it and with the
 * run's generic family until then. A run measured the second-best way is measured again once its font arrives.
 */
export class PdfTextMeasure {
  private readonly runs = new WeakMap<PdfTextItem, Measured>()

  constructor(private readonly glyphs: GlyphSource = new CanvasGlyphs()) {}

  /** `characters + 1` fractions of the run's width, or null when the run cannot be measured. */
  readonly edges = (item: PdfTextItem): ArrayLike<number> | null => {
    const own = item.font && OWN_FONT.test(item.font) && this.glyphs.loaded(item.font) ? item.font : null
    const known = this.runs.get(item)
    if (known && (known.own || !own)) return known.edges
    const edges = this.measure(item, own)
    // A measurement that failed is not remembered, so a passing canvas hiccup does not leave the run unmeasured.
    if (edges) this.runs.set(item, { own: Boolean(own), edges })
    return edges
  }

  fontsChanged(): void { this.glyphs.refresh?.() }
  reset(): void { this.glyphs.reset?.() }

  private measure(item: PdfTextItem, own: string | null): Float64Array | null {
    const characters = [...item.str]
    if (characters.length < 2 || characters.length > LIMITS.runCharacters) return null
    const family = item.family && GENERIC.has(item.family) ? item.family : 'sans-serif'
    const spaces = spaceWeights(characters), advances: number[] = []
    let letters = 0, covered = 0
    for (const [index, character] of characters.entries()) {
      // A character the PDF font lacks is drawn by the window in another font: measure it in the generic family.
      const inOwn = own ? this.ownAdvance(own, character) : null
      const advance = inOwn ?? this.glyphs.advance(family, character)
      if (advance === null) return null
      advances.push(advance)
      if (spaces[index] === 0) { letters++; if (inOwn !== null) covered++ }
    }
    const exact = own !== null && letters > 0 && covered >= letters * OWN_COVERAGE
    return characterEdges(own && exact ? this.withLigatures(own, characters, advances) : advances, spaces, item.ems ?? Number.NaN, exact)
  }

  /** Where the run's own font has a ligature glyph (a subset font only has it if the document uses it), its
   * letters together take the ligature's width instead of the sum of their own.
   */
  private withLigatures(own: string, characters: readonly string[], advances: readonly number[]): number[] {
    const widths = [...advances]
    for (let index = 0; index < characters.length; index++) {
      if (characters[index] !== 'f') continue
      for (const [letters, glyph] of LIGATURES) {
        if (![...letters].every((letter, offset) => characters[index + offset] === letter)) continue
        const together = this.ownAdvance(own, glyph)
        let apart = 0
        for (let offset = 0; offset < letters.length; offset++) apart += widths[index + offset]!
        if (together === null || !(apart > 0) || together > apart || together < apart * LIGATURE_MIN_SHARE) continue
        for (let offset = 0; offset < letters.length; offset++) widths[index + offset] = widths[index + offset]! * together / apart
        index += letters.length - 1
        break
      }
    }
    return widths
  }

  /** Width of a character only if the PDF's own font has it: then the fallback behind it makes no difference. */
  private ownAdvance(own: string, character: string): number | null {
    const serif = this.glyphs.advance(`"${own}", serif`, character), mono = this.glyphs.advance(`"${own}", monospace`, character)
    return serif !== null && mono !== null && serif > 0 && Math.abs(serif - mono) < 1e-6 ? serif : null
  }
}
