import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
class Node {
  hidden = false
  open = false
  attributes = new Map<string, string>()
  listeners = new Set<() => void>()
  addEventListener(_type: string, listener: () => void): void { this.listeners.add(listener) }
  removeEventListener(_type: string, listener: () => void): void { this.listeners.delete(listener) }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  click(): void { for (const listener of this.listeners) listener() }
}
const nodes = new Map<string, Node>()
vi.mock('../src/renderer/dom', () => ({ element: (id: string) => nodes.get(id)! }))
import { WorkbenchLayout } from '../src/renderer/workbench-layout'
let layout: WorkbenchLayout, home: Mock<() => void>, body: { dataset: Record<string, string> }
const get = (id: string): Node => nodes.get(id)!
beforeEach(() => {
  nodes.clear(); for (const id of ['home-open', 'dashboard-all', 'layout-files', 'layout-preview', 'log-toggle', 'log-open', 'log-close', 'log-panel', 'layout-menu', 'project-home', 'editor-workspace', 'files', 'preview']) nodes.set(id, new Node())
  body = { dataset: {} }; home = vi.fn<() => void>()
  vi.stubGlobal('document', { body, querySelector: (selector: string) => nodes.get(selector === '.files-panel' ? 'files' : 'preview') })
  layout = new WorkbenchLayout(home)
})
afterEach(() => { layout.dispose(); vi.unstubAllGlobals() })
describe('Overleaf view navigation does not own or reset project buffers', () => {
  it('constructs without invoking navigation or application work', () => { expect(home).not.toHaveBeenCalled(); expect(body.dataset).toEqual({}) })
  it('switches between exclusive home/editor surfaces without replacing DOM', () => {
    layout.showHome(); expect(body.dataset.page).toBe('home'); expect(get('editor-workspace').hidden).toBe(true)
    layout.showEditor(); expect(body.dataset.page).toBe('editor'); expect(get('project-home').hidden).toBe(true)
    expect(get('editor-workspace').hidden).toBe(false)
  })
  it('routes home buttons through the guarded owner, not direct document mutations', () => { get('home-open').click(); get('dashboard-all').click(); expect(home).toHaveBeenCalledTimes(2) })
  it('only explicitly toggles the requested visible panel and its pressed state', () => {
    get('layout-files').click(); expect(get('files').hidden).toBe(true); expect(get('preview').hidden).toBe(false)
    expect(get('layout-files').attributes.get('aria-pressed')).toBe('false')
    get('layout-files').click(); expect(get('files').hidden).toBe(false)
    get('layout-preview').click(); expect(get('preview').hidden).toBe(true)
  })
  it('shows compilation logs only on explicit action or error notification', () => {
    layout.showLog(false); expect(get('log-panel').hidden).toBe(true)
    get('log-toggle').click(); expect(get('log-panel').hidden).toBe(false)
    expect(get('log-toggle').attributes.get('aria-pressed')).toBe('true')
  })
  it('opens and closes logs from the visible PDF toolbar and close button', () => {
    layout.showLog(false); get('log-open').click()
    expect(get('log-panel').hidden).toBe(false); expect(get('log-open').attributes.get('aria-expanded')).toBe('true')
    get('log-close').click(); expect(get('log-panel').hidden).toBe(true)
    expect(get('log-toggle').attributes.get('aria-pressed')).toBe('false')
    get('log-open').click(); get('log-open').click(); expect(get('log-panel').hidden).toBe(true)
  })
  it('blocks view changes while closing and permits them again after cancel', () => {
    layout.setClosing(true); get('home-open').click(); layout.showHome(); layout.showEditor(); layout.showLog()
    expect(home).not.toHaveBeenCalled(); expect(body.dataset).toEqual({})
    layout.setClosing(false); layout.showEditor(); expect(body.dataset.page).toBe('editor')
  })
  it('removes listeners and ignores late navigation after disposal', () => {
    layout.dispose(); get('home-open').click(); layout.showEditor(); expect(home).not.toHaveBeenCalled(); expect(body.dataset).toEqual({})
  })
})
