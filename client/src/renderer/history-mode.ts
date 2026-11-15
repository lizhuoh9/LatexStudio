import { element } from './dom'

/** History is a read-only view; it never replaces the active editor document or its draft. */
export class HistoryMode {
  private closing = false
  private disposed = false
  private escape = (event: KeyboardEvent): void => {
    if (this.closing || this.disposed || event.key !== 'Escape' || document.querySelector('dialog[open]') || !this.active) return
    event.preventDefault(); this.leave?.()
  }
  constructor(private leave: () => void) { document.addEventListener('keydown', this.escape) }
  get active(): boolean { return document.body.dataset.history === 'open' }
  open(): void {
    if (this.closing || this.disposed) return
    document.body.dataset.history = 'open'
    for (const id of ['revision-panel', 'history-files', 'history-comparison-panel', 'history-back']) element(id).hidden = false
    element('cloud-open').setAttribute('aria-expanded', 'true')
    element('history-back').focus()
  }
  close(focus = true): void {
    if (this.closing || this.disposed) return
    delete document.body.dataset.history
    for (const id of ['revision-panel', 'history-files', 'history-comparison-panel', 'history-back']) element(id).hidden = true
    element('cloud-open').setAttribute('aria-expanded', 'false')
    if (focus) element('cloud-open').focus()
  }
  setClosing(closing: boolean): void { this.closing = closing }
  dispose(): void { this.disposed = true; document.removeEventListener('keydown', this.escape) }
}
