import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
class Node {
  hidden = false
  values = new Map<string, string>()
  listeners = new Map<string, Set<(event: never) => void>>()
  capture: number | null = null
  left = 280
  right = 800
  style = { setProperty: (key: string, value: string) => this.values.set(key, value), removeProperty: (key: string) => this.values.delete(key) }
  classList = { add: vi.fn(), remove: vi.fn() }
  addEventListener(type: string, fn: (event: never) => void): void { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn) }
  removeEventListener(type: string, fn: (event: never) => void): void { this.listeners.get(type)?.delete(fn) }
  setAttribute(key: string, value: string): void { this.values.set(key, value) }
  getBoundingClientRect(): { left: number; right: number; width: number } { return { left: this.left, right: this.right, width: this.right - this.left } }
  setPointerCapture(id: number): void { this.capture = id }
  hasPointerCapture(id: number): boolean { return this.capture === id }
  releasePointerCapture(): void { this.capture = null }
  fire(type: string, value: object = {}): void { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault: vi.fn(), ...value } as never) }
}
const nodes = new Map<string, Node>()
vi.mock('../src/renderer/dom', () => ({ element: (id: string) => nodes.get(id)! }))
import { WorkspaceSplitter } from '../src/renderer/workspace-splitter'
let splitter: WorkspaceSplitter, handle: Node, host: Node, preview: Node
beforeEach(() => {
  nodes.clear(); for (const id of ['editor-panel', 'source-preview-splitter', '.workspace', '.preview-panel']) nodes.set(id, new Node())
  host = nodes.get('.workspace')!; handle = nodes.get('source-preview-splitter')!; preview = nodes.get('.preview-panel')!
  preview.left = 800; preview.right = 1320
  vi.stubGlobal('document', { querySelector: (selector: string) => nodes.get(selector) })
  splitter = new WorkspaceSplitter()
})
afterEach(() => { splitter.dispose(); vi.unstubAllGlobals() })
describe('view-only source/PDF splitter', () => {
  it('captures only primary pointer and changes track ratio without touching document content', () => {
    handle.fire('pointerdown', { button: 0, pointerId: 3 }); handle.fire('pointermove', { pointerId: 3, clientX: 1000 })
    expect(host.values.get('--source-track')).toBe(`${720 / 1040}fr`)
    expect(handle.values.get('aria-valuenow')).toBe('69')
    handle.fire('pointerup'); expect(handle.capture).toBeNull()
  })
  it('ignores unrelated pointers, right click and movement without capture', () => {
    handle.fire('pointerdown', { button: 2, pointerId: 3 }); handle.fire('pointermove', { pointerId: 3, clientX: 900 })
    expect(host.values.size).toBe(0)
    handle.fire('pointerdown', { button: 0, pointerId: 3 }); handle.fire('pointermove', { pointerId: 4, clientX: 900 })
    expect(host.values.size).toBe(0)
  })
  it('supports keyboard and clamps both sides to readable minimums', () => {
    handle.fire('keydown', { key: 'Home' }); expect(host.values.get('--source-track')).toBe(`${180 / 1040}fr`)
    handle.fire('keydown', { key: 'End' }); expect(host.values.get('--source-track')).toBe(`${860 / 1040}fr`)
    handle.fire('keydown', { key: 'ArrowLeft' }); expect(host.values.get('--source-track')).toBe(`${496 / 1040}fr`)
    handle.fire('dblclick'); expect(host.values.size).toBe(0)
  })
  it('stops drag while closing, resumes after canceled close, and never acts when preview hidden', () => {
    handle.fire('pointerdown', { button: 0, pointerId: 3 }); splitter.setClosing(true)
    expect(handle.capture).toBeNull(); handle.fire('keydown', { key: 'End' }); expect(host.values.size).toBe(0)
    splitter.setClosing(false); preview.hidden = true; handle.fire('keydown', { key: 'End' }); expect(host.values.size).toBe(0)
    preview.hidden = false; handle.fire('keydown', { key: 'End' }); expect(host.values.size).toBe(2)
  })
  it('removes listeners and captured pointer on dispose', () => {
    handle.fire('pointerdown', { button: 0, pointerId: 9 }); splitter.dispose()
    expect(handle.capture).toBeNull(); handle.fire('keydown', { key: 'End' }); expect(host.values.size).toBe(0)
  })
})
