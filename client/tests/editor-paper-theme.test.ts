import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
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
  it('keeps code in the middle and PDF to its right, with history inline after PDF', () => {
    expect(editor.indexOf('id="editor-panel"')).toBeLessThan(editor.indexOf('aria-label="PDF 预览"'))
    expect(editor.indexOf('id="revision-panel"')).toBeGreaterThan(editor.indexOf('aria-label="PDF 预览"'))
    expect(tag('revision-list')).toContain('<ol'); expect(layout).toContain('minmax(200px,1.15fr) minmax(200px,1fr)')
    expect(html.slice(html.indexOf('id="cloud-dialog"'), html.indexOf('id="project-dialog"'))).not.toContain('id="revision-list"')
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
    expect(base).toContain('[hidden] { display: none !important; }')
  })
  it('retains accessible announcements, keyboard-readable differences and native focus handling', () => {
    for (const id of ['status', 'revision-status', 'collaboration-state', 'setup-status']) { expect(tag(id)).toContain('role="status"'); expect(tag(id)).toContain('aria-live="polite"') }
    for (const id of ['revision-before', 'revision-after', 'revision-diff', 'log']) expect(tag(id)).toContain('tabindex="0"')
    expect(base).toContain(':focus-visible'); expect(base).toContain('forced-colors: active')
  })
  it('uses local assets and its own brand, not an embedded or copied Overleaf runtime', () => {
    expect(layout).not.toMatch(/@import|@font-face|url\(/)
    expect(html).not.toMatch(/<iframe|https?:\/\/[^<]*\.(?:woff2?|ttf|svg|png)/)
    expect(html).toContain('data-ui-theme="overleaf"'); expect(topbar).toContain('LatexStudio'); expect(html).not.toContain('PaperStudio')
    expect(html).not.toContain('SPRINGER'); expect(layout).toContain('user-supplied Overleaf screenshots')
  })
  it('matches the reference dark frame, white editor and restrained green actions', () => {
    expect(layout).toContain('--nav-bg: #1c232d'); expect(layout).toContain('--frame-bg: #303c4e')
    expect(layout).toContain('background: #087f43'); expect(base).toContain('.editor-panel { background: var(--surface-paper);')
    expect(contrast('#f1f4f8', '#1c232d')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', '#087f43')).toBeGreaterThanOrEqual(4.5)
  })
})
