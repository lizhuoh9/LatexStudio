/** Where the characters of one PDF text run sit inside it.
 * PDF.js reports a run (often a whole justified line) with ONE width, not a width per character, so a search hit
 * or comment highlight inside the run has to be placed from character widths measured separately.
 */

/** A word space in a justified line is rarely narrower or wider than this (em); outside it the widths are not trusted. */
export const SPACE_EM = Object.freeze({ min: 0.05, max: 3 })

/** TeX sets the space after a sentence wider than the others on the line, and lets it stretch more (unless the
 * document turns that off with French spacing). These are typical ratios to an ordinary space on the same line.
 */
const SENTENCE_SPACE = 1.6, COLON_SPACE = 1.3
const CLOSER = /[)\]'"\u2019\u201d]/, SENTENCE_END = /[.?!]/, UPPERCASE = /\p{Lu}/u, SPACE = /\s/u

/** Per character: 0 for anything but a space, else how wide that space is expected to be relative to an ordinary
 * one. As in TeX, closing brackets and quotes between the punctuation and the space do not count, and a full stop
 * or colon after a capital letter ("FSI. ", "UniFSI: ") gets an ordinary space.
 */
export function spaceWeights(characters: readonly string[]): number[] {
  const before = (index: number): number => { let at = index - 1; while (at >= 0 && CLOSER.test(characters[at]!)) at--; return at }
  return characters.map((character, index) => {
    if (!SPACE.test(character)) return 0
    const mark = before(index), punctuation = mark >= 0 ? characters[mark]! : ''
    if (punctuation !== ':' && !SENTENCE_END.test(punctuation)) return 1
    const letter = before(mark)
    if (letter >= 0 && UPPERCASE.test(characters[letter]!)) return 1
    return punctuation === ':' ? COLON_SPACE : SENTENCE_SPACE
  })
}

/** Character boundaries of one run as fractions of its width: `advances.length + 1` values rising from 0 to 1.
 * `advances` are measured widths per character (em), `spaces` the result of `spaceWeights` for the same characters,
 * `run` is the run's real width (em).
 * With `exact` (the widths are the run's own font's) letters keep their width and the spaces share what is left
 * in proportion to their weights, which is how a justified line is set. Otherwise, or when that would leave an
 * implausible space, all widths are scaled to fit the run. Null when nothing usable was measured.
 */
export function characterEdges(advances: ArrayLike<number>, spaces: ArrayLike<number>, run: number, exact: boolean): Float64Array | null {
  const count = advances.length
  if (count < 1 || spaces.length !== count) return null
  const widths = new Float64Array(count)
  let letters = 0, weight = 0
  for (let index = 0; index < count; index++) {
    const advance = advances[index]!
    widths[index] = Number.isFinite(advance) && advance > 0 ? advance : 0
    if (spaces[index]! > 0) weight += spaces[index]!; else letters += widths[index]!
  }
  const space = exact && weight > 0 && letters > 0 && Number.isFinite(run) ? (run - letters) / weight : Number.NaN
  if (space >= SPACE_EM.min && space <= SPACE_EM.max) for (let index = 0; index < count; index++) if (spaces[index]! > 0) widths[index] = space * spaces[index]!
  let total = 0
  for (const width of widths) total += width
  if (!(total > 0)) return null
  const edges = new Float64Array(count + 1)
  for (let index = 0, at = 0; index < count; index++) { at += widths[index]!; edges[index + 1] = Math.min(1, at / total) }
  edges[count] = 1
  return edges
}
