import type { TexSetupApi, TexSetupState } from '../shared/tex-setup-contracts'
import { button, element, text } from './dom'
import { SetupModel, setupBytes, setupDetail, type SetupAction } from './setup-model'

export class SetupPanel {
  readonly model: SetupModel

  constructor(private api: TexSetupApi | undefined, private changed: () => void) {
    this.model = new SetupModel(Boolean(api))
    button('setup-open', () => this.open())
    button('setup-close', () => { if (!this.model.closing) element<HTMLDialogElement>('setup-dialog').close() })
    button('setup-refresh', () => { void this.request('status') })
    button('setup-prepare', () => { void this.request('prepare') })
    button('setup-cancel', () => { void this.request('cancel') })
    this.render()
  }

  initialize(): void {
    if (!this.api) { this.changed(); return }
    try {
      this.api.onState((state) => { this.model.receive(state); this.publish() })
      void this.request('status')
    } catch (error) { this.model.fail(error); this.publish() }
  }

  get verified(): boolean { return this.model.verified }
  get summary(): string { return this.model.summary }
  get attention(): boolean { return this.model.attention }

  setClosing(closing: boolean): void {
    this.model.closing = closing
    this.render()
  }

  open(): void {
    if (this.model.closing) return
    const dialog = element<HTMLDialogElement>('setup-dialog')
    if (!dialog.open) dialog.showModal()
    void this.request('status')
  }

  private async request(action: SetupAction): Promise<void> {
    const api = this.api
    const ticket = this.model.begin(action)
    if (!api || !ticket) return
    this.render()
    try {
      const result = action === 'status' ? await api.status() : action === 'prepare' ? await api.prepare() : await api.cancel()
      this.model.respond(action, result, ticket)
    } catch (error) { this.model.fail(error) }
    finally { this.model.finish(action); this.publish() }
  }

  private publish(): void { this.render(); this.changed() }

  private render(): void {
    text('setup-status', this.model.summary)
    const state: TexSetupState | null = this.model.state
    text('setup-detail', state ? setupDetail(state.message) : '')
    element('setup-detail').hidden = !state?.message
    text('setup-error', this.model.error ? `操作未完成：${this.model.error}` : '')
    element('setup-error').hidden = !this.model.error
    element<HTMLButtonElement>('setup-refresh').disabled = !this.model.allowed('status')
    element<HTMLButtonElement>('setup-prepare').disabled = !this.model.allowed('prepare')
    element<HTMLButtonElement>('setup-cancel').disabled = !this.model.allowed('cancel')
    element('setup-prepare').hidden = !state?.supported || !['required', 'error'].includes(state.phase)
    element('setup-cancel').hidden = !this.model.allowed('cancel')
    element<HTMLButtonElement>('setup-close').disabled = this.model.closing
    text('setup-prepare', '重试配置')
    this.renderProgress()
  }

  private renderProgress(): void {
    const { value, total, percent } = this.model.progress
    const progress = element<HTMLProgressElement>('setup-progress')
    if (percent === null) progress.removeAttribute('value')
    else { progress.max = total; progress.value = value }
    const phase = this.model.state?.phase
    const amount = phase === 'downloading' ? `${setupBytes(value)} / ${setupBytes(total)}` : `${value.toLocaleString()} / ${total.toLocaleString()}`
    const active = phase !== undefined && ['checking', 'downloading', 'extracting', 'verifying'].includes(phase)
    const checking = phase === 'checking' || phase === 'verifying'
    const label = active ? (percent === null ? (checking ? '正在后台校验，可先编辑论文…' : this.model.summary) : `${percent}% · ${amount}`)
      : this.model.preparing ? '正在启动组件配置…' : ''
    text('setup-progress-label', label)
    progress.setAttribute('aria-valuetext', label)
    progress.hidden = !active && !this.model.preparing
    element('setup-progress-label').hidden = progress.hidden
  }
}
