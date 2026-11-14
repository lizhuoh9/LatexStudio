import type { CollaborationModel } from './collaboration-model'
import { button, element, text } from './dom'

/** One choice per renderer startup. No storage, account request or browser action on open/offline/Escape. */
export class StartupDialog {
  private shown = false
  private dismissed = false
  private closing = false
  private disposed = false
  private dialog = element<HTMLDialogElement>('startup-dialog')

  constructor(private collaboration: CollaborationModel, private login: () => void) {
    button('startup-login', () => {
      if (!this.usable() || !this.collaboration.allowed('login')) return
      this.dismiss('login')
      this.login()
    })
    button('startup-offline', () => { if (this.usable()) this.dismiss('offline') })
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (this.usable()) this.dismiss('offline')
    })
    this.dialog.addEventListener('close', () => { this.dismissed = true })
    this.update()
  }

  open(): void {
    if (this.shown || this.dismissed || this.closing || this.disposed) return
    this.shown = true
    if (this.collaboration.account) { this.dismissed = true; return }
    this.update()
    this.dialog.showModal()
  }

  update(): void {
    if (this.disposed) return
    const allowed = this.collaboration.allowed('login')
    element<HTMLButtonElement>('startup-login').disabled = this.closing || !allowed
    element<HTMLButtonElement>('startup-offline').disabled = this.closing
    const state = this.collaboration.state
    const status = !this.collaboration.available ? 'GitHub 登录不可用'
      : this.collaboration.error ? '暂时无法登录'
      : !state ? '正在连接 GitHub…'
      : state.phase === 'unconfigured' ? 'GitHub 登录未配置'
      : state.phase === 'error' ? '暂时无法登录'
      : this.collaboration.expired ? '登录已到期'
      : state.phase === 'authorizing' ? '等待 GitHub 授权…' : ''
    text('startup-status', status)
    element('startup-status').hidden = !status
    if (!this.closing && this.dialog.open && this.collaboration.account) this.dismiss('signed-in')
  }

  setClosing(closing: boolean): void { this.closing = closing; this.update() }

  dispose(): void {
    this.disposed = true
    this.dismissed = true
    if (this.dialog.open) this.dialog.close()
  }

  private usable(): boolean { return !this.disposed && !this.closing && !this.dismissed && this.dialog.open }

  private dismiss(reason: string): void {
    this.dismissed = true
    this.dialog.close(reason)
  }
}
