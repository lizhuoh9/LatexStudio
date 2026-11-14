/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileIcon, fileIconKind } from '../src/renderer/file-icons'
interface VectorNode {
  namespace: string; tag: string; attributes: Map<string, string>; children: VectorNode[]
  setAttribute(name: string, value: string): void
  append(...children: VectorNode[]): void
}
function node(namespace: string, tag: string): VectorNode {
  if (!['svg', 'path'].includes(tag)) throw new Error('Only local path artwork is permitted')
  return { namespace, tag, attributes: new Map(), children: [],
    setAttribute(name, value) { this.attributes.set(name, value) }, append(...children) { this.children.push(...children) } }
}
beforeEach(() => vi.stubGlobal('document', { createElementNS: node }))
afterEach(() => vi.unstubAllGlobals())
describe('original display-only file icon classification', () => {
  it.each([
    ['paper.TEX', 'tex'], ['journal.cls', 'tex'], ['package.sty', 'tex'],
    ['refs.bib', 'bibliography'], ['journal.bst', 'bibliography'], ['notes.MD', 'markdown'], ['notes.markdown', 'markdown'],
    ['article.PDF', 'pdf'], ['plot.png', 'image'], ['plot.JPEG', 'image'], ['diagram.svg', 'image'], ['figure.eps', 'image'],
    ['script.py', 'code'], ['script.ts', 'code'], ['settings.json', 'code'], ['settings.YAML', 'code'], ['settings.toml', 'code'],
    ['note.txt', 'file'], ['LICENSE', 'file'], ['tex', 'file'], ['archive.pdf.zip', 'file']
  ])('classifies %s without opening or rewriting it', (name, expected) => { expect(fileIconKind(name)).toBe(expected) })
  it('gives directories priority even when their names look like file extensions', () => {
    expect(fileIconKind('chapter.pdf', true)).toBe('folder')
    expect(fileIconKind('chapter.tex', true)).toBe('folder')
  })
  it('never embeds the filename, remote asset or event attributes into SVG artwork', () => {
    const svg = createFileIcon('<svg onload=evil()>论文.pdf') as unknown as VectorNode
    const all = [svg, ...svg.children], attributes = all.flatMap(item => [...item.attributes.entries()])
    expect(all.every(item => item.namespace === 'http://www.w3.org/2000/svg')).toBe(true)
    expect(attributes.some(([name]) => /^(?:on|href|src|xlink:)/i.test(name))).toBe(false)
    expect(JSON.stringify(attributes)).not.toContain('evil')
    expect(JSON.stringify(attributes)).not.toContain('论文')
    expect(svg.attributes.get('data-file-icon')).toBe('pdf')
    expect(svg.attributes.get('aria-hidden')).toBe('true')
    expect(svg.attributes.get('focusable')).toBe('false')
  })
  it('uses geometric paths rather than text fonts or undifferentiated sheet silhouettes', () => {
    const names = ['main.tex', 'refs.bib', 'notes.md', 'article.pdf', 'plot.png', 'build.json', 'plain.txt']
    const drawings = names.map(name => {
      const svg = createFileIcon(name) as unknown as VectorNode
      expect(svg.children.every(item => item.tag === 'path')).toBe(true)
      return svg.children.map(item => item.attributes.get('d')).join('|')
    })
    expect(new Set(drawings).size).toBe(names.length)
  })
})
