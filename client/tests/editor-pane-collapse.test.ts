import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { translate } from '../src/shared/i18n'

const html = readFileSync('src/renderer/index.html', 'utf8')
const layout = readFileSync('src/renderer/workspace-layout-style.css', 'utf8')
const main = readFileSync('src/renderer/main.ts', 'utf8')
const tags = [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)]
const tag = (id: string): string => tags.find(match => match[1] === id)?.[0] ?? ''
const workspace = html.slice(html.indexOf('<main class="workspace">'), html.indexOf('</main>', html.indexOf('<main class="workspace">')))
const rule = (selector: string): string => layout.split('\n').find(line => line.startsWith(`${selector} {`)) ?? ''
const WORKSPACE = 'body[data-ui-theme="overleaf"] .workspace'

describe('source and PDF panes can each be collapsed', () => {
  it('offers a source switch next to the PDF switch in the layout menu', () => {
    const menu = html.slice(html.indexOf('id="layout-menu"'), html.indexOf('id="project-share"'))
    expect(menu.indexOf('id="layout-files"')).toBeLessThan(menu.indexOf('id="layout-source"'))
    expect(menu.indexOf('id="layout-source"')).toBeLessThan(menu.indexOf('id="layout-preview"'))
    expect(tag('layout-source')).toContain('aria-pressed="true"')
  })
  it('puts two real buttons on the divider, outside both panes so one always stays reachable', () => {
    const group = workspace.slice(workspace.indexOf('id="pane-collapse"'))
    for (const id of ['pane-collapse-source', 'pane-collapse-preview']) {
      expect(tag(id)).toMatch(/^<button /); expect(tag(id)).toContain('aria-expanded="true"'); expect(group).toContain(`id="${id}"`)
    }
    expect(tag('pane-collapse')).toContain('role="group"')
    expect(tag('pane-collapse-source')).toContain('aria-controls="editor-panel"')
    expect(tag('pane-collapse-preview')).toContain('aria-controls="preview-panel"')
    expect(tag('preview-panel')).toContain('class="preview-panel"')
    expect(workspace).toMatch(/<\/section>\s*<div id="pane-collapse"[^>]*>(<button [^>]*><\/button>){2}<\/div>\s*<section class="preview-panel"/)
    expect(tag('source-preview-splitter')).toContain('role="separator"')
  })
  it('gives the PDF the whole width when the source is collapsed, in every combination of side panels', () => {
    const collapsed = `${WORKSPACE}:has(.editor-panel[hidden])`
    expect(rule(collapsed)).toContain('grid-template-columns: var(--file-tree-width) 0 minmax(200px,1fr);')
    expect(rule(`${collapsed}:has(#revision-panel:not([hidden]))`)).toContain('grid-template-columns: var(--file-tree-width) 0 minmax(200px,1fr) 300px;')
    expect(rule(`${WORKSPACE}:has(.files-panel[hidden]):has(.editor-panel[hidden])`)).toContain('grid-template-columns: 0 minmax(200px,1fr);')
    expect(rule(`${WORKSPACE}:has(.files-panel[hidden]):has(.editor-panel[hidden]):has(#revision-panel:not([hidden]))`))
      .toContain('grid-template-columns: 0 minmax(200px,1fr) 300px;')
  })
  it('keeps the collapse buttons on the divider, moves them to the edge when one pane is gone, and out of History', () => {
    expect(rule('.pane-collapse')).toContain('grid-area: preview;')
    expect(rule('.workspace:has(.preview-panel[hidden]) .pane-collapse')).toContain('grid-area: source;')
    expect(rule('.workspace:has(.editor-panel[hidden]) .pane-collapse')).toContain('transform: none;')
    expect(rule('body[data-history="open"] .pane-collapse')).toContain('display: none;')
    expect(layout).toContain('.pane-collapse button:focus-visible')
  })
  it('draws the arrows in CSS, pointing the way the divider will move', () => {
    expect(html.slice(html.indexOf('id="pane-collapse"'), html.indexOf('</main>'))).not.toMatch(/[‹›«»◀▶←→]/)
    expect(layout).toContain('#pane-collapse-source[aria-expanded="true"]::before, #pane-collapse-preview[aria-expanded="false"]::before { transform: translateX(1.5px) rotate(135deg); }')
    expect(layout).toContain('#pane-collapse-source[aria-expanded="false"]::before, #pane-collapse-preview[aria-expanded="true"]::before { transform: translateX(-1.5px) rotate(-45deg); }')
  })
  it('names every new control in Chinese, English and Korean', () => {
    for (const source of ['收起或展开源码与 PDF', '收起或展开源码', '收起或展开 PDF']) {
      expect(html).toContain(source)
      expect(translate(source, 'en')).not.toBe(source); expect(translate(source, 'ko')).not.toBe(source)
      expect(translate(source, 'en')).not.toMatch(/[㐀-鿿]/)
    }
    expect(translate('收起或展开源码', 'en')).toBe('Collapse or expand source')
    expect(translate('收起或展开 PDF', 'en')).toBe('Collapse or expand PDF')
  })
  it('opens the source again when the user asks for a place in it', () => {
    expect(main).toContain("line => { this.layout.showSource(); this.editor.revealLine(line) }")
    expect(main).toContain("if (this.documents.buffer.path === file) { this.layout.showSource(); this.editor.revealLine(line, word) }")
    expect(main).toContain("async () => { await this.documents.open(path); this.layout.showSource() }")
    expect(main).toContain("async () => { await this.documents.create(); this.layout.showSource() }")
  })
  it('never leaves an external-change warning or a newly opened paper behind a collapsed source', () => {
    const warning = main.indexOf("element('external-warning').hidden = !buffer.conflict")
    expect(main.slice(warning, warning + 140)).toContain('if (buffer.conflict) this.layout.showSource()')
    const adopt = main.slice(main.indexOf('private async adopt('), main.indexOf('private renderProject('))
    expect(adopt.indexOf('this.layout.showSource()')).toBeGreaterThan(-1)
    expect(adopt.indexOf('this.layout.showSource()')).toBeLessThan(adopt.indexOf('this.showEditor()'))
    expect(html.slice(html.indexOf('id="editor-panel"'), html.indexOf('id="pane-collapse"'))).toContain('id="external-warning"')
  })
})
