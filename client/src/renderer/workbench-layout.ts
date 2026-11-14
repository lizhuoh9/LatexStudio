import { element } from './dom'

/** View-only navigation. Documents/Main retain the active buffer and all write authority. */
export class WorkbenchLayout {
  private closing = false
  private disposed = false
  private cleanups: (() => void)[] = []

  constructor(home: () => void) {
    this.listen('home-open', home)
    this.listen('dashboard-all', home)
    this.listen('layout-files', () => this.toggle('.files-panel', 'layout-files'))
    this.listen('layout-preview', () => this.toggle('.preview-panel', 'layout-preview'))
    this.listen('log-toggle', () => this.showLog(Boolean(element('log-panel').hidden)))
    this.listen('log-open', () => this.showLog(Boolean(element('log-panel').hidden)))
    this.listen('log-close', () => this.showLog(false))
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

  showLog(visible = true): void {
    if (this.closing || this.disposed) return
    element('log-panel').hidden = !visible
    element('log-toggle').setAttribute('aria-pressed', String(visible))
    element('log-open').setAttribute('aria-expanded', String(visible))
  }

  setClosing(closing: boolean): void { this.closing = closing }
  dispose(): void { this.disposed = true; for (const cleanup of this.cleanups.splice(0)) cleanup() }
}
