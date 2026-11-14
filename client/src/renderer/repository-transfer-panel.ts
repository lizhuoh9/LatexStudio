import type { RepositoryTransferState, WorkspaceApi } from '../shared/workspace-contracts'
import { button, element, text } from './dom'
import { RepositoryTransferModel, type RepositoryTransferAction } from './repository-transfer-model'

export type RepositoryTransferBridge = Partial<Pick<WorkspaceApi, 'repositoryTransfer' | 'cancelRepositoryTransfer'>>

/** Independent from Workbench.run: cancellation must remain reachable while busy. */
export class RepositoryTransferPanel {
  readonly model: RepositoryTransferModel
  private initialized = false
  private disposed = false

  constructor(private api: RepositoryTransferBridge | undefined) {
    const supported = typeof api?.repositoryTransfer === 'function' && typeof api.cancelRepositoryTransfer === 'function'
    this.model = new RepositoryTransferModel(supported)
    button('repository-transfer-status', () => { void this.request('status') })
    button('repository-transfer-cancel', () => { void this.request('cancel') })
    this.render()
  }

  initialize(): void {
    if (this.initialized || this.disposed) return
    this.initialized = true
    void this.request('status')
  }

  receive(state: RepositoryTransferState): void {
    this.model.receive(state)
    this.render()
  }

  setClosing(closing: boolean): void {
    this.model.setClosing(closing)
    this.render()
  }

  dispose(): void {
    this.disposed = true
    this.model.dispose()
  }

  private async request(action: RepositoryTransferAction): Promise<void> {
    const ticket = this.model.begin(action)
    const api = this.api
    if (!ticket || !api) return
    this.render()
    try {
      const state = action === 'status' ? await api.repositoryTransfer!() : await api.cancelRepositoryTransfer!()
      this.model.respond(ticket, state)
    } catch { this.model.fail(ticket) }
    finally { this.model.finish(ticket); this.render() }
  }

  private render(): void {
    if (this.disposed) return
    text('repository-transfer-state', this.model.summary)
    text('repository-transfer-error', this.model.error)
    element('repository-transfer-error').hidden = !this.model.error
    element('repository-transfer').setAttribute('data-phase', this.model.state?.phase ?? 'unknown')
    element('repository-transfer').setAttribute('data-cancel-pending', String(this.model.requesting))
    element<HTMLButtonElement>('repository-transfer-cancel').disabled = !this.model.allowed('cancel')
    element<HTMLButtonElement>('repository-transfer-status').disabled = !this.model.allowed('status')
    text('repository-transfer-cancel', this.model.requesting || this.model.state?.phase === 'cancelling'
      ? '已请求取消，等待收束' : '取消当前传输')
  }
}
