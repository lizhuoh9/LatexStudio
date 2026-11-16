/// <reference types="vite/client" />
import './history-comparison-style.css'
import { uiText } from './i18n-dom'

type Kind = 'same' | 'added' | 'removed'
export interface HistoryLine { kind: Kind; text: string; oldLine: number | null; newLine: number | null }
export interface HistoryComparisonResult { added: number; removed: number; truncated: boolean; initial: boolean }
const MAX_CHARS = 120_000, MAX_LINES = 1200
function bounded(value: string): { lines: string[]; truncated: boolean } {
  const lines = value ? value.slice(0, MAX_CHARS).split('\n') : []
  return { lines: lines.slice(0, MAX_LINES), truncated: value.length > MAX_CHARS || lines.length > MAX_LINES }
}

/** Bounded LCS alignment is display-only; no diff output can be used as a restore patch. */
export function historyLines(before: string | null, after: string): HistoryComparisonResult & { rows: HistoryLine[] } {
  const left = bounded(before ?? ''), right = bounded(after)
  const rows: HistoryLine[] = [], initial = before === null
  if (initial) {
    right.lines.forEach((text, index) => rows.push({ kind: 'same', text, oldLine: null, newLine: index + 1 }))
    return { rows, added: 0, removed: 0, initial, truncated: right.truncated }
  }
  const a = left.lines, b = right.lines
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  let aEnd = a.length, bEnd = b.length
  while (aEnd > prefix && bEnd > prefix && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd-- }
  for (let p = 0; p < prefix; p++) rows.push({ kind: 'same', text: a[p]!, oldLine: p + 1, newLine: p + 1 })
  const midA = aEnd - prefix, midB = bEnd - prefix, width = midB + 1
  const lengths = new Uint16Array((midA + 1) * width)
  for (let i = midA - 1; i >= 0; i--) for (let j = midB - 1; j >= 0; j--) {
    lengths[i * width + j] = a[prefix + i] === b[prefix + j] ? 1 + lengths[(i + 1) * width + j + 1]! :
      Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
  }
  let i = 0, j = 0, added = 0, removed = 0
  while (i < midA || j < midB) {
    if (i < midA && j < midB && a[prefix + i] === b[prefix + j]) {
      rows.push({ kind: 'same', text: a[prefix + i]!, oldLine: prefix + i + 1, newLine: prefix + j + 1 }); i++; j++
    } else if (i < midA && (j === midB || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
      rows.push({ kind: 'removed', text: a[prefix + i]!, oldLine: prefix + ++i, newLine: null }); removed++
    } else {
      rows.push({ kind: 'added', text: b[prefix + j]!, oldLine: null, newLine: prefix + ++j }); added++
    }
  }
  for (let s = 0; s < a.length - aEnd; s++) rows.push({ kind: 'same', text: a[aEnd + s]!, oldLine: aEnd + s + 1, newLine: bEnd + s + 1 })
  return { rows, added, removed, initial, truncated: left.truncated || right.truncated }
}

export class HistoryComparison {
  private changes: HTMLElement[] = []
  private current = -1
  private disposed = false
  constructor(private host: HTMLElement) { host.dataset.historyComparison = 'true' }
  show(before: string | null, after: string): HistoryComparisonResult {
    const result = historyLines(before, after)
    if (this.disposed) return result
    this.clear()
    let changed = false
    const nodes = result.rows.map(line => {
      const row = this.line(line), isChange = line.kind !== 'same'
      if (isChange && !changed) {
        row.dataset.historyChange = String(this.changes.length); row.tabIndex = -1; this.changes.push(row)
      }
      changed = isChange
      return row
    })
    this.host.replaceChildren(...nodes)
    this.host.dataset.truncated = String(result.truncated)
    if (!nodes.length) this.message('此版本的文件为空。')
    if (result.truncated) this.message('文件较长，仅显示前 120000 字符 / 1200 行；不是完整比较。')
    if (this.changes.length) { this.current = 0; this.reveal(false) }
    else this.host.scrollTop = 0
    return result
  }
  private line(line: HistoryLine): HTMLElement {
    const row = document.createElement('div'); row.className = 'history-line history-line-' + line.kind
    row.dataset.oldLine = line.oldLine === null ? '' : String(line.oldLine)
    row.dataset.newLine = line.newLine === null ? '' : String(line.newLine)
    const values = [line.oldLine === null ? '' : String(line.oldLine), line.newLine === null ? '' : String(line.newLine),
      line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ', line.text || ' ']
    values.forEach((value, index) => {
      const span = document.createElement(index === 3 ? 'code' : 'span')
      span.className = ['history-old-number', 'history-new-number', 'history-line-mark', 'history-line-text'][index]!
      span.textContent = value; row.append(span)
    })
    return row
  }
  private message(message: string): void {
    const node = document.createElement('p'); node.className = 'history-source-message'; uiText(node, message); this.host.append(node)
  }
  private reveal(focus: boolean): void {
    const node = this.changes[this.current]
    if (!node) return
    for (const other of this.changes) other.removeAttribute('aria-current')
    node.setAttribute('aria-current', 'true'); node.scrollIntoView({ block: 'center', inline: 'nearest' })
    if (focus) node.focus({ preventScroll: true })
  }
  move(direction: number): void {
    if (this.disposed || !Number.isFinite(direction) || !direction || !this.changes.length) return
    this.current = (this.current + (direction > 0 ? 1 : -1) + this.changes.length) % this.changes.length
    this.reveal(true)
  }
  clear(): void { this.changes = []; this.current = -1; this.host.replaceChildren() }
  dispose(): void { this.disposed = true; this.clear() }
}
