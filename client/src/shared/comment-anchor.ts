/** Finding a comment's selected text again after the paper changes or is recompiled.
 * Text is compared on a folded key: letters and digits only, case-, accent- and width-insensitive, so line breaks,
 * hyphenation, punctuation, ligatures and TeX spacing do not matter. Han/Kana characters are words of their own.
 * When the exact text is gone, a token-level local alignment accepts a span that still contains most of it.
 */
export interface PdfTextItem { str: string; x: number; y: number; width: number; height: number }
export interface PdfTextRect { x: number; y: number; width: number; height: number }
export interface QuoteContext { quote: string; before: string; after: string }
export interface SourceSpan { line: number; endLine: number }
/** `text` is the matched span as the page reads (separate lines and gaps joined by a space). */
export interface PdfMatch { rects: PdfTextRect[]; exact: boolean; text: string; before: string; after: string }

interface Span { start: number; end: number }
interface Scan { key: string; tokens: Span[] }
interface SourceScan extends Scan { lines: Int32Array }
export interface PdfPageIndex extends Scan { items: PdfTextItem[]; item: Int32Array; char: Int32Array; lengths: number[]; plain: string; plainAt: Int32Array }

const ALNUM = /[\p{L}\p{N}]/u
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const MAX_FUZZY_TOKENS = 120, MAX_OCCURRENCES = 100_000, MAX_SEEDS = 40, WINDOW_LINES = 150, CONTEXT_KEY = 24, CONTEXT_TEXT = 160

const folded = new Map<string, string>()
function fold(ch: string): string {
  if (ch.charCodeAt(0) < 128) return ch.toLowerCase()
  let value = folded.get(ch)
  if (value === undefined) {
    value = ch.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').normalize('NFC')
    if (folded.size < 50_000) folded.set(ch, value)
  }
  return value
}

/** Appends the folded letters/digits of one code point; returns whether a word is still open after it.
 * A code point that folds to nothing (a combining mark) neither adds text nor ends the word. `onKey` runs once
 * per UTF-16 unit added, so arrays indexed like the key stay aligned for characters outside the BMP too.
 */
function push(scan: Scan, ch: string, open: boolean, onKey: () => void): boolean {
  let continued = open
  for (const part of fold(ch)) {
    if (!ALNUM.test(part)) { continued = false; continue }
    const cjk = CJK.test(part)
    if (!continued || cjk) scan.tokens.push({ start: scan.key.length, end: scan.key.length })
    scan.key += part
    scan.tokens[scan.tokens.length - 1]!.end = scan.key.length
    for (let unit = 0; unit < part.length; unit++) onKey()
    continued = !cjk
  }
  return continued
}

export function quoteKey(text: string): string {
  const scan: Scan = { key: '', tokens: [] }
  let open = false
  for (const ch of text) open = push(scan, ch, open, () => undefined)
  return scan.key
}

function quoteTokens(text: string): string[] {
  const scan: Scan = { key: '', tokens: [] }
  let open = false
  for (const ch of text) open = push(scan, ch, open, () => undefined)
  return scan.tokens.slice(0, MAX_FUZZY_TOKENS).map(token => scan.key.slice(token.start, token.end))
}

const ARGUMENT_COMMANDS = /\\(?:label|ref|eqref|pageref|autoref|[cC]ref|cite[a-zA-Z]*|nocite|includegraphics|input|include|begin|end|usepackage|documentclass|bibliography|bibliographystyle|[hv]space|href)\*?(?:\[[^\]\n]*\])*\{[^}\n]*\}/g

/** Rough LaTeX-to-text for matching only: comments, labels/references and command names are dropped. */
export function stripLatexLine(line: string): string {
  return line.replace(/(^|[^\\])%.*$/, '$1').replace(ARGUMENT_COMMANDS, ' ')
    .replace(/\\['"^`~=.uvHckrtbd]\s*\{?([A-Za-z])\}?/g, '$1').replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/\\./g, ' ')
}

/** A source file prepared once for locating many comments in it. */
export interface SourceIndex extends SourceScan { words: string[]; counts: Map<string, number> }

export function indexSource(source: string): SourceIndex {
  const scan: Scan = { key: '', tokens: [] }, lines: number[] = []
  source.split(/\r\n?|\n/).forEach((raw, index) => {
    let open = false
    for (const ch of stripLatexLine(raw)) open = push(scan, ch, open, () => { lines.push(index + 1) })
  })
  const words = scan.tokens.map(token => scan.key.slice(token.start, token.end)), counts = new Map<string, number>()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  return { ...scan, lines: Int32Array.from(lines), words, counts }
}

/** Lines of the current source that hold the anchored text, preferring the occurrence nearest the stored line.
 * With `fuzzy` false only the exact text counts (used to bound work when there are very many comments).
 */
export function locateInSource(source: string | SourceIndex, anchor: QuoteContext & SourceSpan, fuzzy = true): SourceSpan | null {
  const key = quoteKey(anchor.quote)
  if (!key) return null
  const scan = typeof source === 'string' ? indexSource(source) : source
  const exact = bestOccurrence(scan.key, key, anchor, start => Math.abs(scan.lines[start]! - anchor.line))
  if (exact !== null) return { line: scan.lines[exact]!, endLine: scan.lines[exact + key.length - 1]! }
  if (!fuzzy) return null
  const tokens = quoteTokens(anchor.quote), words = scan.words
  const near = tokenWindow(scan, anchor.line)
  const found = alignWithin(tokens, words, [near, ...seedWindows(tokens, words, scan.counts)], index => Math.abs(scan.lines[scan.tokens[index]!.start]! - anchor.line))
  if (!found) return null
  return { line: scan.lines[scan.tokens[found.start]!.start]!, endLine: scan.lines[scan.tokens[found.end - 1]!.end - 1]! }
}

function tokenWindow(scan: SourceScan, line: number): Span {
  let start = scan.tokens.length, end = 0
  scan.tokens.forEach((token, index) => {
    if (Math.abs(scan.lines[token.start]! - line) > WINDOW_LINES) return
    start = Math.min(start, index); end = Math.max(end, index + 1)
  })
  return start < end ? { start, end } : { start: 0, end: 0 }
}

/** Windows around occurrences of the quote's rarest words (long words, or single Han/Kana characters), so text
 * that moved far can still be found.
 */
function seedWindows(quote: string[], words: string[], counts: Map<string, number>): Span[] {
  const seeds = [...new Set(quote)].filter(word => (word.length >= 3 || CJK.test(word)) && counts.has(word))
    .sort((a, b) => counts.get(a)! - counts.get(b)!).slice(0, 3)
  const spans: Span[] = []
  words.forEach((word, index) => {
    if (spans.length < MAX_SEEDS && seeds.includes(word)) {
      spans.push({ start: Math.max(0, index - quote.length * 2), end: Math.min(words.length, index + quote.length * 2) })
    }
  })
  return spans
}

/** Exact folded-key occurrence with the best context match, then the smallest distance. */
function bestOccurrence(text: string, key: string, context: QuoteContext, distance: (start: number) => number): number | null {
  const before = quoteKey(context.before).slice(-CONTEXT_KEY), after = quoteKey(context.after).slice(0, CONTEXT_KEY)
  let best: { start: number; score: number } | null = null
  for (let start = text.indexOf(key), count = 0; start >= 0 && count < MAX_OCCURRENCES; start = text.indexOf(key, start + 1), count++) {
    const left = before && text.slice(Math.max(0, start - before.length), start) === before ? 1 : 0
    const right = after && text.slice(start + key.length, start + key.length + after.length) === after ? 1 : 0
    const score = distance(start) - (left + right) * 1_000_000
    if (!best || score < best.score) best = { start, score }
  }
  return best?.start ?? null
}

export function requiredMatches(tokens: number): number { return tokens <= 2 ? tokens : Math.max(3, Math.ceil(tokens * 0.6)) }

interface Alignment extends Span { matches: number; score: number }

/** Smith-Waterman over tokens (+3 match, -1 mismatch or gap) inside each window; best score, then nearest.
 * A match needs most of the quote's words AND a span not much longer than the quote, so scattered common words
 * (single Han characters especially) cannot add up to a match.
 */
function alignWithin(quote: string[], words: string[], windows: Span[], distance: (index: number) => number): Alignment | null {
  if (quote.length < 3) return null
  const needed = requiredMatches(quote.length), longest = Math.ceil(quote.length * 1.5) + 2
  let best: Alignment | null = null
  for (const window of windows) {
    const found = align(quote, words, window)
    if (!found || found.matches < needed || found.end - found.start > longest) continue
    if (!best || found.score > best.score || (found.score === best.score && distance(found.start) < distance(best.start))) best = found
  }
  return best
}

interface Column { score: Int32Array; matches: Int32Array; start: Int32Array }
const column = (size: number): Column => ({ score: new Int32Array(size), matches: new Int32Array(size), start: new Int32Array(size) })

function align(quote: string[], words: string[], window: Span): Alignment | null {
  const m = quote.length
  let previous = column(m + 1), current = column(m + 1)
  let best: Alignment | null = null
  for (let j = window.start; j < window.end; j++) {
    current.score.fill(0); current.matches.fill(0); current.start.fill(0)
    for (let i = 1; i <= m; i++) {
      const hit = quote[i - 1] === words[j]
      const diagonal = previous.score[i - 1]! + (hit ? 3 : -1), up = current.score[i - 1]! - 1, left = previous.score[i]! - 1
      const score = Math.max(0, diagonal, up, left)
      if (score === 0) continue
      current.score[i] = score
      if (score === diagonal) {
        const fresh = previous.score[i - 1] === 0
        current.matches[i] = (fresh ? 0 : previous.matches[i - 1]!) + (hit ? 1 : 0)
        current.start[i] = fresh ? j : previous.start[i - 1]!
      } else if (score === up) { current.matches[i] = current.matches[i - 1]!; current.start[i] = current.start[i - 1]! }
      else { current.matches[i] = previous.matches[i]!; current.start[i] = previous.start[i]! }
      if (!best || score > best.score) best = { start: current.start[i]!, end: j + 1, matches: current.matches[i]!, score }
    }
    const swap = previous; previous = current; current = swap
  }
  return best
}

/** Builds the folded key of one PDF page with, per key character, the text item and character it came from. */
export function indexPdfPage(items: readonly PdfTextItem[]): PdfPageIndex {
  const scan: Scan = { key: '', tokens: [] }, item: number[] = [], char: number[] = [], lengths: number[] = [], plainAt: number[] = []
  let plain = '', wordOpen = false
  items.forEach((entry, index) => {
    const previous = items[index - 1]
    const separate = !previous || Math.abs(entry.y - previous.y) > Math.max(entry.height, 1) * 0.5 ||
      entry.x - (previous.x + previous.width) > Math.max(entry.height, 1) * 0.15
    if (separate && plain) plain += ' '
    // A word continues into this item only if the previous item ended inside a word ("docu" + "ment").
    let open = !separate && wordOpen, offset = 0
    for (const ch of entry.str) {
      const at = plain.length
      open = push(scan, ch, open, () => { item.push(index); char.push(offset); plainAt.push(at) })
      plain += ch; offset++
    }
    wordOpen = open
    lengths.push(offset)
  })
  return { ...scan, items: [...items], item: Int32Array.from(item), char: Int32Array.from(char), lengths, plain, plainAt: Int32Array.from(plainAt) }
}

/** Finds the anchored text on one page: exact first (best context, nearest the hint), else — unless `exactOnly` —
 * a local alignment that still contains most of the words.
 */
export function locateInPdfPage(page: PdfPageIndex, context: QuoteContext, hint?: { x: number; y: number }, exactOnly = false): PdfMatch | null {
  const key = quoteKey(context.quote)
  if (!key) return null
  const distance = (keyIndex: number): number => {
    const entry = page.items[page.item[keyIndex]!]
    return entry && hint ? Math.abs(entry.y - hint.y) * 4 + Math.abs(entry.x - hint.x) : 0
  }
  const exact = bestOccurrence(page.key, key, context, distance)
  if (exact !== null) return match(page, exact, exact + key.length, true)
  if (exactOnly) return null
  const words = page.tokens.map(token => page.key.slice(token.start, token.end))
  const found = alignWithin(quoteTokens(context.quote), words, [{ start: 0, end: words.length }], index => distance(page.tokens[index]!.start))
  return found ? match(page, page.tokens[found.start]!.start, page.tokens[found.end - 1]!.end, false) : null
}

/** Every occurrence of the query on one page in reading order, one rect list (PDF points) per occurrence.
 * Uses the folded key, so case, accents, punctuation, spacing, line breaks and hyphenation do not matter;
 * occurrences never overlap. A query without letters or digits finds nothing.
 */
export function findAllInPdfPage(page: PdfPageIndex, query: string, limit: number): PdfTextRect[][] {
  const key = quoteKey(query), found: PdfTextRect[][] = []
  if (!key) return found
  for (let start = page.key.indexOf(key); start >= 0 && found.length < limit; start = page.key.indexOf(key, start + key.length)) {
    found.push(match(page, start, start + key.length, true).rects)
  }
  return found
}

function match(page: PdfPageIndex, start: number, end: number, exact: boolean): PdfMatch {
  const ranges = new Map<number, { first: number; last: number }>()
  for (let k = start; k < end; k++) {
    const index = page.item[k]!, offset = page.char[k]!, range = ranges.get(index)
    ranges.set(index, range ? { first: Math.min(range.first, offset), last: Math.max(range.last, offset) } : { first: offset, last: offset })
  }
  const rects = [...ranges].map(([index, range]) => {
    const entry = page.items[index]!, length = Math.max(1, page.lengths[index]!)
    return { x: entry.x + (range.first / length) * entry.width, y: entry.y,
      width: Math.max(1, ((range.last + 1 - range.first) / length) * entry.width), height: Math.max(1, entry.height) }
  })
  const from = page.plainAt[start]!, last = page.plainAt[end - 1]!
  const to = last + ((page.plain.codePointAt(last) ?? 0) > 0xffff ? 2 : 1)
  const before = wellFormed(page.plain.slice(Math.max(0, from - CONTEXT_TEXT), from)).replace(/\s+/g, ' ').trim()
  const after = wellFormed(page.plain.slice(to, to + CONTEXT_TEXT)).replace(/\s+/g, ' ').trim()
  const text = wellFormed(page.plain.slice(from, to)).replace(/\s+/g, ' ').trim()
  return { rects: mergeRects(rects), exact, text, before, after }
}

/** Drops a surrogate half left by slicing through a character outside the BMP. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

function mergeRects(rects: PdfTextRect[]): PdfTextRect[] {
  const merged: PdfTextRect[] = []
  for (const rect of rects) {
    const last = merged.at(-1)
    if (last && Math.abs(last.y - rect.y) < Math.max(last.height, rect.height) * 0.5 && rect.x <= last.x + last.width + rect.height) {
      const right = Math.max(last.x + last.width, rect.x + rect.width), bottom = Math.max(last.y + last.height, rect.y + rect.height)
      last.x = Math.min(last.x, rect.x); last.y = Math.min(last.y, rect.y)
      last.width = right - last.x; last.height = bottom - last.y
    } else merged.push({ ...rect })
  }
  return merged
}
