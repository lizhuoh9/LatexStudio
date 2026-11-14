import type { UpdateApi, UpdateState } from '../shared/update-contracts'
import { button, element, text } from './dom'

/** Software releases never share credentials or repository authority with paper collaboration. */
export class UpdatePanel {
  private state: UpdateState | null = null
  private closing = false
  private disposed = false
  private unsubscribe: (() => void) | null = null
  constructor(private api: UpdateApi | undefined) {
    button('update-open', () => {
      if (this.closing || this.disposed) return
      element<HTMLDetailsElement>('account-menu').open = false
      element<HTMLDialogElement>('update-dialog').showModal()
    })
    button('update-close', () => element<HTMLDialogElement>('update-dialog').close())
    button('update-check', () => { void this.request(false) })
    button('update-releases', () => { void this.request(true) })
    if (api) {
      this.unsubscribe = api.onState(state => { if (!this.disposed) { this.state = state; this.render() } })
      void api.status().then(state => { if (!this.disposed && !this.state) { this.state = state; this.render() } }).catch(() => this.error())
    }
    this.render()
  }
  private async request(releases: boolean): Promise<void> {
    if (!this.api || this.closing || this.disposed) return
    try {
      if (releases) await this.api.openReleases()
      else { const state = await this.api.check(); if (!this.disposed) { this.state = state; this.render() } }
    } catch { this.error() }
  }
  private error(): void { if (!this.disposed) text('update-message', '更新请求未完成，请稍后重试。') }
  private render(): void {
    if (this.disposed) return
    const state = this.state
    text('update-open', state?.phase === 'available' ? `发现更新 ${state.latestVersion}` : '检查更新')
    text('update-version', state ? `当前版本 ${state.currentVersion}${state.latestVersion ? ` → ${state.latestVersion}` : ''}` : '')
    text('update-message', state?.message ?? (this.api ? '正在读取更新状态…' : '此版本未接入更新检查。'))
    element<HTMLButtonElement>('update-check').disabled = this.closing || !state || ['checking', 'development'].includes(state.phase)
    element<HTMLButtonElement>('update-releases').disabled = this.closing || !this.api
  }
  setClosing(closing: boolean): void { this.closing = closing; this.render() }
  dispose(): void { this.disposed = true; this.unsubscribe?.(); this.unsubscribe = null }
}
