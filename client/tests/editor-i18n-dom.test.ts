import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '../src/shared/i18n'
import { text } from '../src/renderer/dom'
import { localizeStaticHtml, startDomLocalization, uiAttribute, uiErrorValue, uiFormattedText, uiText } from '../src/renderer/i18n-dom'

class NodeFixture {
  textContent = ''; nodeValue: string | null = null; value = ''; isConnected = true
  attributes = new Map<string, string>()
  get innerHTML(): never { throw new Error('HTML access is not a localization operation') }
  set innerHTML(_: string) { throw new Error('No HTML injection') }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
}
const asNode = (node: NodeFixture): HTMLElement => node as unknown as HTMLElement
let nodes: Map<string, NodeFixture>, cleanup: () => void
beforeEach(() => {
  setLocale('zh-CN'); nodes = new Map()
  vi.stubGlobal('document', { nodeType: 9, documentElement: { lang: '' },
    createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [],
    getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new NodeFixture()); return nodes.get(id) }
  })
  cleanup = startDomLocalization()
})
afterEach(() => { cleanup(); setLocale('zh-CN'); vi.unstubAllGlobals() })

describe('semantic UI language bindings', () => {
  it('switches live while retaining the canonical source for a second switch back', () => {
    const label = asNode(new NodeFixture()); uiText(label, '保存')
    setLocale('en'); expect(label.textContent).toBe('Save'); expect(document.documentElement.lang).toBe('en')
    setLocale('ko'); expect(label.textContent).toBe('저장'); expect(document.documentElement.lang).toBe('ko')
    setLocale('zh-CN'); expect(label.textContent).toBe('保存')
  })
  it('never translates literal filename, account identity, source, URL or log output fields', () => {
    for (const id of ['active-file', 'account-label', 'account-name', 'project-name', 'revision-file-name', 'log']) text(id, '保存')
    text('save-state', '已保存到本地')
    setLocale('en')
    for (const id of ['active-file', 'account-label', 'account-name', 'project-name', 'revision-file-name', 'log']) expect(nodes.get(id)?.textContent).toBe('保存')
    expect(nodes.get('save-state')?.textContent).not.toBe('已保存到本地')
  })
  it('forgets a former placeholder binding before installing a real literal filename', () => {
    const field = document.getElementById('active-file')!; uiText(field, '源文件')
    text('active-file', '保存'); setLocale('ko'); expect(field.textContent).toBe('保存')
  })
  it('only changes application attributes and a specifically bound read-only error value', () => {
    const button = asNode(new NodeFixture()), error = new NodeFixture(), editable = new NodeFixture()
    editable.value = '取消'; uiAttribute(button, 'title', '刷新')
    uiErrorValue(error as unknown as HTMLTextAreaElement, '操作未完成，请重试。')
    setLocale('en'); expect(button.getAttribute('title')).toBe('Refresh'); expect(editable.value).toBe('取消')
    expect(error.value).not.toBe('操作未完成，请重试。'); expect(error.value).not.toMatch(/[\u3400-\u9fff]/)
  })
  it('keeps all off-DOM rows in a large synchronous render and drops detached rows', async () => {
    const rows = Array.from({ length: 150 }, () => { const row = new NodeFixture(); row.isConnected = false; uiText(asNode(row), '保存'); return row })
    for (const row of rows) row.isConnected = true
    await Promise.resolve(); setLocale('en'); expect(rows.every(row => row.textContent === 'Save')).toBe(true)
    rows[0]!.isConnected = false; setLocale('ko')
    expect(rows[0]!.textContent).toBe('Save'); expect(rows.slice(1).every(row => row.textContent === '저장')).toBe(true)
  })
  it('supports pure locale formatting without modifying the data it displays', () => {
    const raw = { name: '取消', size: 42 }, target = asNode(new NodeFixture())
    uiFormattedText(target, () => `${raw.name} / ${getLocale()} / ${raw.size}`)
    setLocale('en'); expect(target.textContent).toBe('取消 / en / 42'); expect(raw).toEqual({ name: '取消', size: 42 })
  })
  it('traverses only initial trusted UI text and excludes code, textarea and endonym markers', () => {
    const label = new NodeFixture(), code = new NodeFixture(), ignored = new NodeFixture()
    label.nodeValue = code.nodeValue = ignored.nodeValue = '取消'
    Object.assign(label, { parentElement: { closest: () => null } })
    Object.assign(code, { parentElement: { closest: () => ({ tagName: 'CODE' }) } })
    Object.assign(ignored, { parentElement: { closest: () => ({ dataset: { i18nIgnore: '' } }) } })
    const queue = [label, code, ignored]
    const root = { nodeType: 9, createTreeWalker: () => ({ nextNode: () => queue.shift() ?? null }), querySelectorAll: () => [] }
    localizeStaticHtml(root as unknown as Document); setLocale('en')
    expect(label.nodeValue).toBe('Cancel'); expect(code.nodeValue).toBe('取消'); expect(ignored.nodeValue).toBe('取消')
  })
  it('disposes live subscriptions without requesting account, project or network APIs', () => {
    const fetch = vi.fn(() => { throw new Error('No network') }); vi.stubGlobal('fetch', fetch)
    const target = asNode(new NodeFixture()); uiText(target, '保存'); cleanup()
    setLocale('en'); expect(target.textContent).toBe('保存'); expect(fetch).not.toHaveBeenCalled()
  })
})
