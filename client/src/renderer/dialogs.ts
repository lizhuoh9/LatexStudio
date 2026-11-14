import { element } from './dom'

export class Dialogs {
  private pending = false

  async confirm(title: string, detail: string): Promise<boolean> {
    if (this.pending) return false
    this.pending = true
    const dialog = element<HTMLDialogElement>('confirm-dialog')
    element('confirm-title').textContent = title
    element('confirm-detail').textContent = detail
    dialog.returnValue = 'cancel'
    dialog.showModal()
    try { return await this.closed(dialog) === 'accept' }
    finally { this.pending = false }
  }

  async input(title: string, value: string): Promise<string | null> {
    if (this.pending) return null
    this.pending = true
    const dialog = element<HTMLDialogElement>('input-dialog')
    const field = element<HTMLInputElement>('input-value')
    element('input-title').textContent = title
    field.value = value
    dialog.returnValue = 'cancel'
    dialog.showModal()
    field.focus(); field.select()
    try { return await this.closed(dialog) === 'accept' ? field.value.trim() : null }
    finally { field.value = ''; this.pending = false }
  }

  private closed(dialog: HTMLDialogElement): Promise<string> {
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true })
    })
  }
}
