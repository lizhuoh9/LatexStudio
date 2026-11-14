import { element } from './dom'

/** View-only split; never touches the editor document, project, or persisted settings. */
export class WorkspaceSplitter {
  private host = document.querySelector<HTMLElement>('.workspace')!
  private source = element('editor-panel')
  private preview = document.querySelector<HTMLElement>('.preview-panel')!
  private handle = element('source-preview-splitter')
  private pointer: number | null = null
  private closing = false
  private disposed = false

  constructor() {
    this.handle.addEventListener('pointerdown', this.down)
    this.handle.addEventListener('pointermove', this.move)
    this.handle.addEventListener('pointerup', this.up)
    this.handle.addEventListener('pointercancel', this.up)
    this.handle.addEventListener('lostpointercapture', this.up)
    this.handle.addEventListener('keydown', this.key)
    this.handle.addEventListener('dblclick', this.reset)
  }

  private available(): boolean {
    return !this.disposed && !this.closing && !this.preview.hidden && this.source.getBoundingClientRect().width > 0
  }

  private set(clientX: number): void {
    const start = this.source.getBoundingClientRect().left
    const width = this.preview.getBoundingClientRect().right - start
    if (width <= 0 || !Number.isFinite(clientX)) return
    const minimum = Math.min(180, width / 2)
    const source = Math.max(minimum, Math.min(width - minimum, clientX - start))
    this.host.style.setProperty('--source-track', `${source / width}fr`)
    this.host.style.setProperty('--preview-track', `${1 - source / width}fr`)
    this.handle.setAttribute('aria-valuenow', String(Math.round(source / width * 100)))
  }

  private down = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.available()) return
    event.preventDefault()
    this.pointer = event.pointerId
    this.handle.setPointerCapture(event.pointerId)
    this.handle.classList.add('is-dragging')
  }
  private move = (event: PointerEvent): void => {
    if (event.pointerId === this.pointer && this.available()) this.set(event.clientX)
  }
  private up = (): void => {
    const pointer = this.pointer
    this.pointer = null
    this.handle.classList.remove('is-dragging')
    if (pointer !== null && this.handle.hasPointerCapture(pointer)) this.handle.releasePointerCapture(pointer)
  }
  private key = (event: KeyboardEvent): void => {
    if (!this.available() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const source = this.source.getBoundingClientRect(), preview = this.preview.getBoundingClientRect()
    const x = event.key === 'Home' ? source.left : event.key === 'End' ? preview.right
      : source.right + (event.key === 'ArrowLeft' ? -24 : 24)
    this.set(x)
  }
  private reset = (): void => {
    if (!this.available()) return
    this.host.style.removeProperty('--source-track')
    this.host.style.removeProperty('--preview-track')
    this.handle.setAttribute('aria-valuenow', '53')
  }
  setClosing(closing: boolean): void { this.closing = closing; if (closing) this.up() }
  dispose(): void {
    this.up(); this.disposed = true
    this.handle.removeEventListener('pointerdown', this.down)
    this.handle.removeEventListener('pointermove', this.move)
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.handle.removeEventListener(type, this.up)
    this.handle.removeEventListener('keydown', this.key)
    this.handle.removeEventListener('dblclick', this.reset)
  }
}
