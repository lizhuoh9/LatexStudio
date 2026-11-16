import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { translate } from '../src/shared/i18n'
const html = readFileSync('src/renderer/index.html', 'utf8')
const base = readFileSync('src/renderer/style.css', 'utf8'), layout = readFileSync('src/renderer/workspace-layout-style.css', 'utf8')
const tags = [...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)], ids = tags.map(match => match[1])
const tag = (id: string): string => tags.find(match => match[1] === id)?.[0] ?? ''
const home = html.slice(html.indexOf('<main id="project-home"'), html.indexOf('<div id="editor-workspace"'))
const editor = html.slice(html.indexOf('<div id="editor-workspace"'), html.indexOf('<dialog id="startup-dialog"'))
const topbar = html.slice(html.indexOf('<header class="topbar"'), html.indexOf('</header>'))
function luminance(hex: string): number {
  const channel = (start: number): number => { const value = parseInt(hex.slice(start, start + 2), 16) / 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }
  return channel(1) * .2126 + channel(3) * .7152 + channel(5) * .0722
}
function contrast(a: string, b: string): number { const first = luminance(a), second = luminance(b); return (Math.max(first, second) + .05) / (Math.min(first, second) + .05) }

describe('user-selected Overleaf home/editor layout retains real application contracts', () => {
  it('keeps all core targets unique', () => {
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['home-open', 'project-home', 'editor-workspace', 'project-open', 'project-create', 'project-library',
      'project-name', 'project-sync', 'project-settings', 'file-create', 'file-save', 'file-tree', 'file-count', 'file-outline',
      'active-file', 'save-state', 'source-editor', 'editor-empty', 'external-warning', 'file-reload', 'file-copy',
      'compile', 'cancel-compile', 'engine', 'main-file', 'pdf-pages', 'pdf-empty', 'cloud-open', 'cloud-close',
      'revision-list', 'revision-restore', 'history-list', 'status', 'log', 'account-menu', 'account-avatar']) expect(ids.filter(found => found === id), id).toHaveLength(1)
  })
  it('starts at an independent project homepage, not a second project sidebar in the editor', () => {
    expect(html).toContain('data-page="home"'); expect(tag('editor-workspace')).toContain('hidden')
    for (const id of ['project-library', 'project-open', 'project-create']) expect(home).toContain(`id="${id}"`)
    expect(editor).not.toContain('id="project-library"'); expect(editor).not.toContain('project-library-toggle')
    expect(layout).toContain('.project-home { display: grid; grid-template-columns: 260px minmax(0,1fr);')
  })
  it('puts synchronization and project settings in the current file column, never in the global header', () => {
    const fileColumn = editor.slice(editor.indexOf('id="paper-contents"'), editor.indexOf('class="outline-panel"'))
    for (const id of ['project-sync', 'project-settings', 'file-create', 'file-tree']) expect(fileColumn).toContain(`id="${id}"`)
    expect(topbar).not.toContain('id="project-sync"'); expect(topbar).not.toContain('id="project-settings"')
    expect(tag('project-actions')).toContain('hidden'); expect(tag('project-sync')).toContain('disabled')
  })
  it('uses one file tree with a real chapter outline below it', () => {
    expect(editor).toContain('aria-label="当前论文文件与大纲"'); expect(tag('file-outline')).toContain('<ol')
    expect(editor.indexOf('id="file-outline"')).toBeGreaterThan(editor.indexOf('id="file-tree"'))
    expect(layout).toContain('grid-template-rows: minmax(180px,1.35fr) minmax(120px,1fr)')
  })
  it('uses honest static sidebar headings without fake disclosure glyphs or button semantics', () => {
    expect(html).toContain('<h2 id="paper-files-title">文件树</h2>')
    expect(html).toContain('<h2 id="outline-title">文件大纲</h2>')
    for (const id of ['paper-files-title', 'outline-title']) {
      expect(tag(id)).not.toMatch(/aria-expanded|aria-controls|tabindex|role=/)
      expect(tag(id)).toContain('<h2')
    }
    expect(html).not.toContain('⌄ 文件树'); expect(html).not.toContain('⌄ 文件大纲')
    expect(html).toContain('aria-labelledby="paper-files-title"'); expect(html).toContain('aria-labelledby="outline-title"')
  })
  it('translates plain sidebar headings without restoring decorative font arrows', () => {
    for (const [locale, tree, outline] of [['zh-CN', '文件树', '文件大纲'], ['en', 'File tree', 'File outline'], ['ko', '파일 트리', '파일 개요']] as const) {
      expect(translate('文件树', locale)).toBe(tree); expect(translate('文件大纲', locale)).toBe(outline)
    }
  })
  it('keeps the editor/PDF layout and provides an independent reference-based History mode', () => {
    expect(editor.indexOf('id="editor-panel"')).toBeLessThan(editor.indexOf('aria-label="PDF 预览"'))
    expect(editor.indexOf('id="revision-panel"')).toBeGreaterThan(editor.indexOf('aria-label="PDF 预览"'))
    expect(tag('revision-list')).toContain('<ol'); expect(layout).toContain('minmax(180px,var(--source-track,1.15fr)) minmax(180px,var(--preview-track,1fr))')
    expect(tag('source-preview-splitter')).toContain('role="separator"'); expect(tag('source-preview-splitter')).toContain('tabindex="0"')
    expect(html.slice(html.indexOf('id="cloud-dialog"'), html.indexOf('id="project-dialog"'))).not.toContain('id="revision-list"')
    for (const id of ['history-files', 'history-comparison-panel', 'history-back']) expect(tag(id)).toContain('hidden')
    expect(tag('history-source')).toContain('tabindex="0"'); expect(tag('revision-files')).toContain('<ul')
    expect(layout).toContain('[data-history="open"]'); expect(layout).toContain('"files source history"')
    expect(html).not.toContain('id="revision-full"'); expect(html).not.toContain('id="revision-diff"')
  })
  it('places compile controls over PDF and preserves actual editable compiler settings', () => {
    const preview = editor.slice(editor.indexOf('aria-label="PDF 预览"'), editor.indexOf('id="pdf-empty"'))
    for (const id of ['compile', 'cancel-compile', 'environment-summary', 'main-file', 'engine']) expect(preview).toContain(`id="${id}"`)
    expect(topbar).not.toContain('id="compile"')
    for (const id of ['engine', 'main-file']) expect(tag(id)).toContain('data-lock')
    expect(base).toContain('max-width: calc(100vw - 20px);')
  })
  it('keeps global history/layout/share and account at the top, with local save in the editor tab', () => {
    for (const id of ['cloud-open', 'layout-menu', 'project-share', 'account-menu']) expect(topbar).toContain(`id="${id}"`)
    expect(topbar).not.toContain('id="file-save"'); expect(tag('file-save')).toContain('aria-keyshortcuts="Control+s Meta+s"')
    for (const id of ['edit-undo', 'edit-redo', 'edit-bold', 'edit-italic', 'edit-search']) expect(editor).toContain(`id="${id}"`)
  })
  it('does not recreate a bottom status bar or permanently occupy the bottom with logs', () => {
    expect(html).not.toContain('<footer'); expect(html).not.toContain('class="statusbar"')
    expect(tag('status')).toContain('hidden'); expect(tag('log-panel')).toContain('hidden')
    expect(layout).toContain('.workspace:has(#log-panel:not([hidden]))')
    expect(layout).toContain('"files source preview" "files logs logs"')
    expect(editor.indexOf('id="log-panel"')).toBeLessThan(editor.indexOf('</main>'))
    expect(tag('log-open')).toContain('aria-controls="log-panel"'); expect(tag('log-close')).toContain('aria-label="关闭编译日志"')
  })
  it('retains locks, real confirmation, conflict recovery and security policy', () => {
    for (const id of ['project-open', 'project-create', 'file-save', 'file-create', 'compile', 'engine', 'main-file', 'file-reload', 'file-copy', 'revision-refresh']) expect(tag(id), id).toContain('data-lock')
    for (const id of ['revision-restore', 'cancel-compile', 'setup-prepare', 'setup-cancel', 'collaboration-login', 'collaboration-cancel', 'collaboration-verify', 'repository-transfer-cancel']) expect(tag(id), id).toContain('disabled')
    expect(tag('confirm-dialog')).toContain('aria-labelledby="confirm-title"'); expect(html).toContain('<form method="dialog">')
    expect(html).toContain("connect-src 'none'"); expect(html).toContain("frame-src 'none'")
    expect(html).toContain("img-src 'self' data: blob: https://avatars.githubusercontent.com;")
    expect(html).not.toContain('img-src https:'); expect(html).not.toContain('img-src *')
    expect(tag('account-initial')).toContain('<span')
    expect(base).toContain('[hidden] { display: none !important; }')
  })
  it('retains accessible announcements, keyboard-readable differences and native focus handling', () => {
    for (const id of ['status', 'revision-status', 'collaboration-state', 'setup-status']) { expect(tag(id)).toContain('role="status"'); expect(tag(id)).toContain('aria-live="polite"') }
    for (const id of ['history-source', 'log']) expect(tag(id)).toContain('tabindex="0"')
    expect(base).toContain(':focus-visible'); expect(base).toContain('forced-colors: active')
  })
  it('uses local assets and its own brand, not an embedded or copied Overleaf runtime', () => {
    expect(layout).not.toMatch(/@import|@font-face|url\(/)
    expect(html).not.toMatch(/<iframe|https?:\/\/[^<]*\.(?:woff2?|ttf|svg|png)/)
    expect(html).toContain('data-ui-theme="overleaf"'); expect(topbar).toContain('LatexStudio'); expect(html).not.toContain('PaperStudio')
    expect(html).not.toContain('SPRINGER'); expect(layout).toContain('DeepSeek Harness inspired')
  })
  it('keeps the home open button readable on hover and keyboard focus', () => {
    expect(layout).toContain('.dashboard-actions #home-join:is(:hover, :focus-visible):not(:disabled) { background: #e8edf7; color: #111827;')
    expect(layout).toContain('#home-join:focus-visible:not(:disabled) { outline: 2px solid #3b58eb; outline-offset: 3px;')
    expect(contrast('#111827', '#e8edf7')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#3b58eb', '#f9fafd')).toBeGreaterThanOrEqual(3)
  })
  it('uses one aligned decorative chevron, not a baseline glyph or duplicate native marker', () => {
    const summary = html.match(/<summary aria-label="编译选项"[^>]*>(.*?)<\/summary>/)?.[1]
    expect(summary).toBe('<span>选项</span>')
    expect(translate('选项', 'en')).toBe('Options'); expect(translate('选项', 'ko')).toBe('옵션')
    expect(layout).toContain('summary::-webkit-details-marker { display: none; }')
    expect(layout).toContain("summary::marker { content: ''; }")
    expect(layout).toContain("summary::after { content: ''; display: block; flex: 0 0 auto; width: 6px; height: 6px;")
    expect(layout).toContain('transform: translateY(-2px) rotate(45deg)')
    expect(layout).toContain('[open] > summary::after { transform: translateY(2px) rotate(225deg); }')
  })
  it('keeps compile-toolbar text readable across hover, focus and expanded states', () => {
    for (const selector of ['.advanced-compile > summary:is(:hover, :focus-visible)', '.advanced-compile[open] > summary', '#log-open:is(:hover, :focus-visible)', '#log-open[aria-expanded="true"]']) expect(layout).toContain(selector)
    expect(layout).toContain('background: #e4e9f3; color: #111827; border-color: #a9b5cc;')
    expect(layout).toContain('.preview-toolbar summary):focus-visible { outline: 2px solid #3b58eb; outline-offset: 2px; }')
    expect(contrast('#111827', '#e4e9f3')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#111827', '#f4f6fa')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#3b58eb', '#f4f6fa')).toBeGreaterThanOrEqual(3)
  })
  it('keeps native disclosure behavior and bounds its popup within the PDF toolbar', () => {
    expect(html).toContain('<details class="advanced-compile"><summary aria-label="编译选项"')
    expect(layout).toContain('.preview-toolbar { position: relative;')
    expect(layout).toContain('.preview-toolbar .advanced-compile { position: static;')
    expect(layout).toContain('display: inline-flex; flex-wrap: nowrap; align-items: center; gap: 8px;')
    expect(layout).toContain('.preview-toolbar .advanced-fields { color: var(--text); right: 8px; top: calc(100% + 6px); max-width: calc(100% - 16px);')
  })
  it('matches the DeepSeek Harness ice-slate frame, white editor and cobalt/teal actions', () => {
    expect(layout).toContain('--nav-bg: #f4f6fa;'); expect(layout).toContain('--frame-bg: #f9fafd;')
    expect(layout).toContain('background: #3b58eb;'); expect(base).toContain('.editor-panel { background: var(--surface-paper);')
    expect(contrast('#111827', '#f4f6fa')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', '#3b58eb')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', '#0b8475')).toBeGreaterThanOrEqual(4.5)
  })
  it('renders all five editor toolbar icons at a uniform SVG box size', () => {
    for (const id of ['edit-undo', 'edit-redo', 'edit-bold', 'edit-italic', 'edit-search']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*><svg viewBox="0 0 16 16"`))
    }
    expect(layout).toContain('.editor-toolbar button svg { width: 15px; height: 15px; display: block; flex: none; }')
  })
})
