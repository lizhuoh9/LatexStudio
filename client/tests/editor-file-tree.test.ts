/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ProjectFile } from '../src/shared/workspace-contracts'
import { renderFiles } from '../src/renderer/file-tree'

class NodeMock {
  id = ''; className = ''; textContent = ''; title = ''; type = ''; disabled = false; hidden = false
  dataset: Record<string, string> = {}; attributes = new Map<string, string>()
  children: NodeMock[] = []; handlers: (() => void)[] = []
  constructor(readonly tagName: string, readonly namespaceURI?: string) {}
  append(...nodes: NodeMock[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: NodeMock[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener(_name: string, handler: () => void): void { this.handlers.push(handler) }
  click(): void { if (!this.disabled) for (const handler of this.handlers) handler() }
  set innerHTML(_value: string) { throw new Error('File tree must use textContent, not markup') }
}
let tree: NodeMock, count: NodeMock
const open = vi.fn()
const file = (path: string, size = 12, kind: ProjectFile['kind'] = 'text'): ProjectFile => ({ path, size, kind })
const folder = (path: string): ProjectFile => file(path, 0, 'directory')
function all(parent = tree): NodeMock[] { return parent.children.flatMap(child => [child, ...all(child)]) }
function entry(path: string): NodeMock {
  const found = all().find(node => node.tagName === 'button' && node.title === path)
  if (!found) throw new Error(`Missing entry: ${path}`)
  return found
}
function children(path: string): NodeMock {
  const id = entry(path).attributes.get('aria-controls'), found = all().find(node => node.id === id)
  if (!found) throw new Error(`Missing child list: ${path}`)
  return found
}
const rows = (): string[] => tree.children.map(item => item.children[0]?.title ?? '')
const label = (path: string): string | undefined => entry(path).children.find(node => node.className === 'file-label')?.textContent
const size = (path: string): string | undefined => entry(path).children.find(node => node.tagName === 'small')?.textContent
const icon = (path: string): NodeMock | undefined => entry(path).children.find(node => node.tagName === 'svg')
beforeEach(() => {
  tree = new NodeMock('ul'); count = new NodeMock('span'); open.mockClear()
  vi.stubGlobal('document', { createElement: (tag: string) => new NodeMock(tag),
    createElementNS: (namespace: string, tag: string) => new NodeMock(tag, namespace),
    getElementById: (id: string) => id === 'file-tree' ? tree : id === 'file-count' ? count : null })
})
afterEach(() => vi.unstubAllGlobals())

describe('real directory and file lists', () => {
  it('keeps the original three-argument call and flat files functional', () => {
    renderFiles([file('z.tex'), file('main.tex')], '', open)
    expect(rows()).toEqual(['main.tex', 'z.tex']); expect(count.textContent).toBe('2 个文件')
    expect(label('main.tex')).toBe('main.tex')
    expect(open).not.toHaveBeenCalled()
  })
  it('infers nested directories without repeating full paths as file names', () => {
    renderFiles([file('chapters/section/intro.tex'), file('main.tex')], '', open, 'paper-a')
    expect(rows()).toEqual(['chapters', 'main.tex'])
    expect(children('chapters').tagName).toBe('ul')
    expect(children('chapters').children[0]?.children[0]).toBe(entry('chapters/section'))
    expect(children('chapters/section').children[0]?.children[0]).toBe(entry('chapters/section/intro.tex'))
    expect(label('chapters/section/intro.tex')).toBe('intro.tex')
    expect(entry('chapters/section/intro.tex').title).toBe('chapters/section/intro.tex')
    expect(count.textContent).toBe('2 个文件 · 2 个文件夹')
  })
  it('sorts folders before files at every level without mutating backend data', () => {
    const files = [file('z.tex'), file('a.tex'), file('z-dir/z.tex'), file('z-dir/a/b.tex'), file('a-dir/z.tex')]
    renderFiles(files, '', open)
    expect(rows()).toEqual(['a-dir', 'z-dir', 'a.tex', 'z.tex'])
    expect(children('z-dir').children.map(row => row.children[0]?.title)).toEqual(['z-dir/a', 'z-dir/z.tex'])
    expect(files[0]?.path).toBe('z.tex')
  })
  it('shows explicit empty directories and does not count them as files', () => {
    renderFiles([folder('empty'), folder('deep/empty')], '', open)
    expect(rows()).toEqual(['deep', 'empty'])
    expect(entry('empty').className).toBe('directory-entry')
    expect(children('empty').children[0]?.textContent).toBe('空文件夹')
    expect(children('deep/empty').children[0]?.textContent).toBe('空文件夹')
    expect(count.textContent).toBe('0 个文件 · 3 个文件夹')
  })
  it('merges explicit and inferred directories without duplicate rows', () => {
    renderFiles([file('chapters/intro.tex'), folder('chapters')], '', open)
    expect(all().filter(node => node.title === 'chapters')).toHaveLength(1)
    expect(children('chapters').children).toHaveLength(1)
  })
  it('keeps binary/text names and accurate bounded size labels', () => {
    renderFiles([file('zero.tex', 0), file('image.pdf', 1024, 'binary'), file('large.tex', 1025)], '', open)
    expect(size('zero.tex')).toBe('0 B')
    expect(size('image.pdf')).toBe('1 KB')
    expect(size('large.tex')).toBe('2 KB')
  })
  it('marks only the current file, not its directory, as the current page', () => {
    renderFiles([file('chapters/intro.tex'), file('main.tex')], 'chapters/intro.tex', open)
    expect(entry('chapters/intro.tex').attributes.get('aria-current')).toBe('page')
    expect(entry('main.tex').attributes.get('aria-current')).toBe('false')
    expect(entry('chapters').attributes.has('aria-current')).toBe(false)
  })
  it('opens only an explicitly clicked file and never auto opens a directory', () => {
    renderFiles([file('chapters/intro.tex')], '', open)
    expect(open).not.toHaveBeenCalled(); entry('chapters').click(); expect(open).not.toHaveBeenCalled()
    entry('chapters/intro.tex').click(); expect(open).toHaveBeenCalledExactlyOnceWith('chapters/intro.tex')
  })
  it('renders a helpful empty list without a fake file action', () => {
    renderFiles([], '', open)
    expect(tree.children).toHaveLength(1); expect(tree.children[0]?.className).toBe('empty')
    expect(count.textContent).toBe('0 个文件'); expect(all().filter(node => node.tagName === 'button')).toHaveLength(0)
  })
})

describe('distinct local vector icons', () => {
  it('renders meaningful filetype shapes before labels without changing labels, sizes or click paths', () => {
    const files = ['paper.tex', 'refs.bib', 'notes.md', 'paper.PDF', 'plot.png', 'build.json', 'note.txt'].map(path => file(path))
    renderFiles([...files, folder('chapters')], 'paper.tex', open)
    const kinds = ['tex', 'bibliography', 'markdown', 'pdf', 'image', 'code', 'file']
    for (const [index, file] of files.entries()) {
      expect(icon(file.path)?.attributes.get('data-file-icon')).toBe(kinds[index])
      expect(label(file.path)).toBe(file.path); expect(size(file.path)).toBe('12 B')
      entry(file.path).click(); expect(open).toHaveBeenLastCalledWith(file.path)
    }
    expect(icon('chapters')?.attributes.get('data-file-icon')).toBe('folder')
    const drawings = files.map(file => icon(file.path)?.children.map(shape => shape.attributes.get('d')).join('|'))
    expect(new Set(drawings).size).toBe(files.length)
  })
  it('keeps SVG decoration out of button names and keyboard order', () => {
    renderFiles([file('paper.tex'), folder('chapters')], '', open)
    for (const path of ['paper.tex', 'chapters']) {
      const svg = icon(path)!
      expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
      expect(svg.attributes.get('aria-hidden')).toBe('true'); expect(svg.attributes.get('focusable')).toBe('false')
      expect(svg.attributes.get('viewBox')).toBe('0 0 20 20'); expect(svg.textContent).toBe('')
      expect(svg.handlers).toHaveLength(0); expect(svg.children.every(node => node.tagName === 'path')).toBe(true)
    }
  })
  it('shows closed/open folder artwork through the existing disclosure state, not a second click handler', () => {
    renderFiles([folder('chapters')], '', open)
    const svg = icon('chapters')!, shapes = svg.children.map(node => node.attributes.get('class'))
    expect(shapes).toEqual(['folder-closed-shape', 'folder-open-shape'])
    entry('chapters').click(); expect(entry('chapters').attributes.get('aria-expanded')).toBe('false')
    expect(icon('chapters')).toBe(svg); expect(open).not.toHaveBeenCalled()
    const css = readFileSync('src/renderer/file-tree-style.css', 'utf8')
    expect(css).toContain('.file-entry::before { content: none; display: none; }')
    expect(css).toContain('[aria-expanded="true"] .folder-closed-shape { display: none; }')
    expect(css).toContain(':not([aria-expanded="true"]) .folder-open-shape { display: none; }')
    expect(css).toContain('pointer-events: none')
  })
})

describe('directory disclosure state and native controls', () => {
  const files = [file('chapters/nested/intro.tex'), file('appendix/note.tex'), file('main.tex')]
  it('defaults directories to expanded and links their real child lists', () => {
    renderFiles(files, '', open, 'paper-a')
    expect(entry('chapters').attributes.get('aria-expanded')).toBe('true')
    expect(children('chapters').hidden).toBe(false)
    expect(children('chapters/nested').hidden).toBe(false)
    expect(new Set(all().filter(node => node.id).map(node => node.id)).size).toBe(3)
  })
  it('toggles only the chosen directory and keeps aria-expanded and hidden consistent', () => {
    renderFiles(files, '', open, 'paper-a'); entry('chapters').click()
    expect(children('chapters').hidden).toBe(true); expect(entry('chapters').attributes.get('aria-expanded')).toBe('false')
    expect(children('appendix').hidden).toBe(false); entry('chapters').click()
    expect(children('chapters').hidden).toBe(false); expect(entry('chapters').attributes.get('aria-expanded')).toBe('true')
  })
  it('preserves user collapse across refreshes even when the same active file is inside', () => {
    const active = 'chapters/nested/intro.tex'
    renderFiles(files, active, open, 'paper-a'); entry('chapters').click()
    renderFiles([...files], active, open, 'paper-a'); expect(children('chapters').hidden).toBe(true)
  })
  it('reveals only a newly active file ancestry and retains unrelated collapsed folders', () => {
    renderFiles(files, 'main.tex', open, 'paper-a'); entry('chapters').click(); entry('chapters/nested').click(); entry('appendix').click()
    renderFiles(files, 'chapters/nested/intro.tex', open, 'paper-a')
    expect(children('chapters').hidden).toBe(false); expect(children('chapters/nested').hidden).toBe(false)
    expect(children('appendix').hidden).toBe(true)
  })
  it('resets disclosure state at project-key boundaries without opening a file', () => {
    renderFiles(files, '', open, 'paper-a'); entry('chapters').click()
    renderFiles(files, '', open, 'paper-b'); expect(children('chapters').hidden).toBe(false)
    renderFiles(files, '', open, 'paper-a'); expect(children('chapters').hidden).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('does not leak state to a newly mounted file list', () => {
    renderFiles(files, '', open, 'paper-a'); entry('chapters').click(); tree = new NodeMock('ul')
    renderFiles(files, '', open, 'paper-a'); expect(children('chapters').hidden).toBe(false)
  })
  it('drops removed directory state so a later recreated directory defaults open', () => {
    renderFiles(files, '', open, 'paper-a'); entry('chapters').click()
    renderFiles([file('main.tex')], '', open, 'paper-a')
    renderFiles(files, '', open, 'paper-a'); expect(children('chapters').hidden).toBe(false)
  })
  it('uses native focusable buttons with locks for both files and directories, without fake ARIA tree roles', () => {
    renderFiles(files, '', open)
    const buttons = all().filter(node => node.tagName === 'button')
    for (const button of buttons) {
      expect(button.type).toBe('button'); expect(button.dataset.lock).toBe('')
      expect(button.attributes.has('tabindex')).toBe(false); expect(button.attributes.has('role')).toBe(false)
    }
    entry('chapters').disabled = true; entry('chapters').click(); expect(children('chapters').hidden).toBe(false)
    entry('main.tex').disabled = true; entry('main.tex').click(); expect(open).not.toHaveBeenCalled()
  })
  it('uses textContent for hostile or Unicode names without constructing markup', () => {
    renderFiles([file('<img onerror=alert(1)>/论文<&>.tex')], '', open)
    expect(label('<img onerror=alert(1)>')).toBe('<img onerror=alert(1)>')
    expect(label('<img onerror=alert(1)>/论文<&>.tex')).toBe('论文<&>.tex')
  })
  it('keeps nested styling scoped and disclosure visibility explicit', () => {
    const css = readFileSync('src/renderer/file-tree-style.css', 'utf8')
    expect(css).toContain('#file-tree .file-tree-children[hidden] { display: none; }')
    expect(css).toContain('border-left: 1px solid var(--border)')
    expect(css).toContain('text-overflow: ellipsis'); expect(css).not.toMatch(/@import|url\(/)
  })
})
