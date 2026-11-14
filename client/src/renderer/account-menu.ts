import type { CollaborationModel } from './collaboration-model'
import { button, element, text } from './dom'

/** Account identity only: opening this menu never authorizes or discovers projects. */
export class AccountMenu {
  private disposed = false
  private closing = false
  private outside = (event: Event): void => {
    if (!element('account-menu').contains(event.target as Node | null)) this.close()
  }
  private keyboard = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !element<HTMLDetailsElement>('account-menu').open) return
    event.preventDefault(); this.close(); element('account-toggle').focus()
  }
  private toggle = (event: Event): void => { if (this.disposed || this.closing) event.preventDefault() }

  constructor(private model: CollaborationModel, private openSettings: () => void) {
    button('account-settings', () => {
      if (this.disposed || this.closing) return
      this.close(); this.openSettings()
    })
    element('account-toggle').addEventListener('click', this.toggle)
    element('account-menu').addEventListener('keydown', this.keyboard)
    for (const id of ['setup-open', 'about-open']) button(id, () => this.close())
    document.addEventListener('pointerdown', this.outside)
    this.update()
  }

  update(): void {
    if (this.disposed) return
    const account = this.model.account, name = account?.name?.trim() || account?.login || '离线使用'
    text('account-label', account?.login || '未登录')
    text('account-name', name)
    text('account-avatar', account ? (Array.from(name)[0] || '?').toLocaleUpperCase() : '')
    element('account-avatar').classList.toggle('is-guest', !account)
    element('account-menu').classList.toggle('is-signed-in', Boolean(account))
    const identity = account ? `已登录 ${name}（${account.login}）` : '未登录 · 账号与设置'
    element('account-toggle').setAttribute('aria-label', identity)
    element('account-toggle').title = identity
  }

  setClosing(closing: boolean): void {
    this.closing = closing
    element('account-toggle').setAttribute('aria-disabled', String(closing))
    if (closing) this.close()
  }

  private close(): void { element<HTMLDetailsElement>('account-menu').open = false }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.close()
    element('account-toggle').removeEventListener('click', this.toggle)
    element('account-menu').removeEventListener('keydown', this.keyboard)
    document.removeEventListener('pointerdown', this.outside)
  }
}
