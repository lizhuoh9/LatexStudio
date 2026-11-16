import { element } from './dom'
import { uiText } from './i18n-dom'

export class Dialogs {
  private pending = false

  async confirm(title: string, detail: string): Promise<boolean> {
    if (this.pending) return false
    this.pending = true
    const dialog = element<HTMLDialogElement>('confirm-dialog')
    uiText(element('confirm-title'), title)
    uiText(element('confirm-detail'), detail)
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
    uiText(element('input-title'), title)
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
