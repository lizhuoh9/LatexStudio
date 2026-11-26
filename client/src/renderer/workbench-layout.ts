import { element } from './dom'

type Pane = 'source' | 'preview'

/** View-only navigation. Documents/Main retain the active buffer and all write authority. */
export class WorkbenchLayout {
  private closing = false
  private disposed = false
  private cleanups: (() => void)[] = []

  constructor(home: () => void) {
    this.listen('home-open', home)
    this.listen('dashboard-all', home)
    this.listen('layout-files', () => this.toggle('.files-panel', 'layout-files'))
    this.listen('layout-source', () => this.togglePane('source'))
    this.listen('layout-preview', () => this.togglePane('preview'))
    this.listen('pane-collapse-source', () => this.togglePane('source'))
    this.listen('pane-collapse-preview', () => this.togglePane('preview'))
    this.listen('log-toggle', () => this.showLog(Boolean(element('log-panel').hidden)))
    this.listen('log-open', () => this.showLog(Boolean(element('log-panel').hidden)))
    this.listen('log-close', () => this.showLog(false))
    this.syncPanes()
  }

  private listen(id: string, action: () => void): void {
    const node = element(id)
    const listener = (): void => { if (!this.closing && !this.disposed) action() }
    node.addEventListener('click', listener)
    this.cleanups.push(() => node.removeEventListener('click', listener))
  }

  showHome(): void {
    if (this.closing || this.disposed) return
    document.body.dataset.page = 'home'
    element('project-home').hidden = false
    element('editor-workspace').hidden = true
    element<HTMLDetailsElement>('layout-menu').open = false
  }

  showEditor(): void {
    if (this.closing || this.disposed) return
    document.body.dataset.page = 'editor'
    element('project-home').hidden = true
    element('editor-workspace').hidden = false
  }

  private toggle(selector: string, control: string): void {
    const panel = document.querySelector<HTMLElement>(selector)
    if (!panel) return
    panel.hidden = !panel.hidden
    element(control).setAttribute('aria-pressed', String(!panel.hidden))
  }

  private pane(pane: Pane): HTMLElement | null {
    return pane === 'source' ? element('editor-panel') : document.querySelector<HTMLElement>('.preview-panel')
  }

  /** Source and PDF are never both collapsed: collapsing the last visible one brings the other back. */
  private togglePane(pane: Pane): void {
    const target = this.pane(pane), other = this.pane(pane === 'source' ? 'preview' : 'source')
    if (!target || !other) return
    target.hidden = !target.hidden
    if (target.hidden) other.hidden = false
    this.syncPanes()
  }

  /** For a request to see a place in the source (file tree, outline, jump from the PDF). Leaves the PDF as it is. */
  showSource(): void {
    if (this.closing || this.disposed) return
    const source = this.pane('source')
    if (!source?.hidden) return
    source.hidden = false
    this.syncPanes()
  }

  /** With one pane collapsed only the button that brings it back stays, so the other pane cannot be collapsed too. */
  private syncPanes(): void {
    const source = !this.pane('source')?.hidden, preview = !this.pane('preview')?.hidden
    element('layout-source').setAttribute('aria-pressed', String(source))
    element('layout-preview').setAttribute('aria-pressed', String(preview))
    const collapseSource = element('pane-collapse-source'), collapsePreview = element('pane-collapse-preview')
    collapseSource.setAttribute('aria-expanded', String(source)); collapseSource.hidden = !preview
    collapsePreview.setAttribute('aria-expanded', String(preview)); collapsePreview.hidden = !source
  }

  showLog(visible = true): void {
    if (this.closing || this.disposed) return
    element('log-panel').hidden = !visible
    element('log-toggle').setAttribute('aria-pressed', String(visible))
    element('log-open').setAttribute('aria-expanded', String(visible))
  }

  setClosing(closing: boolean): void { this.closing = closing }
  dispose(): void { this.disposed = true; for (const cleanup of this.cleanups.splice(0)) cleanup() }
}
