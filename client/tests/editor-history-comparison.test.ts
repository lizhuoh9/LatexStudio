/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoryComparison, historyLines } from '../src/renderer/history-comparison'

class Node {
  dataset: Record<string, string> = {}; className = ''; textContent = ''; tabIndex = 0; scrollTop = 0
  children: Node[] = []; attributes = new Map<string, string>(); focus = vi.fn(); scrollIntoView = vi.fn()
  append(...nodes: Node[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: Node[]): void { this.children = nodes }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value) }
  removeAttribute(key: string): void { this.attributes.delete(key) }
}
afterEach(() => vi.unstubAllGlobals())
function view(): { host: Node; comparison: HistoryComparison } {
  vi.stubGlobal('document', { createElement: () => new Node() })
  const host = new Node(); return { host, comparison: new HistoryComparison(host as unknown as HTMLElement) }
}
describe('official-reference read-only History source comparison', () => {
  it('aligns insertions/deletions and numbers each original side independently', () => {
    const result = historyLines('a\nb\nc\nd', 'a\nnew\nc\nd')
    expect(result.added).toBe(1); expect(result.removed).toBe(1)
    expect(result.rows.map(row => [row.kind, row.text, row.oldLine, row.newLine])).toEqual([
      ['same', 'a', 1, 1], ['removed', 'b', 2, null], ['added', 'new', null, 2], ['same', 'c', 3, 3], ['same', 'd', 4, 4]])
  })
  it('does not color a first snapshot as a document full of additions', () => {
    const result = historyLines(null, 'first\nsecond')
    expect(result.initial).toBe(true); expect(result.added + result.removed).toBe(0)
    expect(result.rows.every(row => row.kind === 'same' && row.oldLine === null)).toBe(true)
    expect(result.rows).toHaveLength(2)
  })
  it('keeps unchanged source context with a single edit, without false whole-file replacement', () => {
    const lines = Array.from({ length: 504 }, (_, i) => 'line-' + i), edited = [...lines]; edited[250] = 'changed'
    const result = historyLines(lines.join('\n'), edited.join('\n'))
    expect(result.added).toBe(1); expect(result.removed).toBe(1); expect(result.rows).toHaveLength(505)
    expect(result.rows.filter(row => row.kind === 'same')).toHaveLength(503)
  })
  it('aligns long additions and repeated lines using bounded LCS rather than a tiny lookahead', () => {
    const result = historyLines('head\ntail', ['head', ...Array(100).fill('insert'), 'tail'].join('\n'))
    expect(result.removed).toBe(0); expect(result.added).toBe(100)
    expect(historyLines('x\nx\ny', 'x\ny').removed).toBe(1)
  })
  it('handles empty files, deletions, unchanged text and HTML-looking source as text', () => {
    expect(historyLines('', '').rows).toEqual([])
    expect(historyLines('old', '').removed).toBe(1)
    expect(historyLines('', 'new').added).toBe(1)
    const { host, comparison } = view(); comparison.show('', '<img src=x onerror=alert(1)>')
    expect(host.children[0]?.children[3]?.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(host.children[0]).not.toHaveProperty('innerHTML')
  })
  it('caps line count and characters, disclosing truncated comparisons', () => {
    const { host, comparison } = view()
    const result = comparison.show('line\n'.repeat(5000), 'x'.repeat(200000))
    expect(result.truncated).toBe(true); expect(host.dataset.truncated).toBe('true')
    expect(host.children.length).toBeLessThanOrEqual(2402)
    expect(host.children.at(-1)?.textContent).toContain('不是完整比较')
  })
  it('jumps between changed blocks without mixing unchanged gaps into the change count', () => {
    const { host, comparison } = view()
    comparison.show('a\nb\nc\nd\ne', 'new\nb\nc\nd\nlast')
    const changes = host.children.filter(node => node.dataset.historyChange !== undefined)
    expect(changes).toHaveLength(2); expect(changes[0]?.attributes.get('aria-current')).toBe('true')
    comparison.move(1); expect(changes[1]?.focus).toHaveBeenCalledOnce()
    expect(changes[1]?.attributes.get('aria-current')).toBe('true')
    comparison.move(1); expect(changes[0]?.focus).toHaveBeenCalledOnce()
    comparison.move(-1); expect(changes[1]?.focus).toHaveBeenCalledTimes(2)
  })
  it('drops navigation targets after clear/dispose and never edits source or loads remote content', () => {
    const { host, comparison } = view(); comparison.show('a', 'b'); const old = host.children[0]!
    comparison.clear(); comparison.move(1); expect(host.children).toEqual([]); expect(old.focus).not.toHaveBeenCalled()
    comparison.dispose(); comparison.show('a', 'b'); expect(host.children).toEqual([])
  })
})
