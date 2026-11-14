import type { RepositoryTransferState } from '../shared/workspace-contracts'

export type RepositoryTransferAction = 'status' | 'cancel'
export interface RepositoryTransferTicket {
  readonly id: number
  readonly action: RepositoryTransferAction
  readonly revision: number
  readonly sequence: number | null
}
type Publication = { kind: 'state'; state: RepositoryTransferState }
  | { kind: 'error'; ticketId: number; revision: number; sequence: number | null; message: string }
const order = { idle: 0, running: 1, cancelling: 2, settled: 3 } as const

export function repositoryTransferCaption(state: RepositoryTransferState): string {
  const names = { connect: '关联', clone: '下载项目', sync: '同步' }
  const name = state.kind === null ? '后台传输' : names[state.kind]
  if (state.phase === 'idle') return '当前没有后台传输。'
  if (state.phase === 'running') return `${name}正在进行。`
  if (state.phase === 'cancelling') return `已请求取消${name}，正在等待操作与清理收束。`
  return `${name}操作等待已结束；这不代表成功、连接清理已确认或修改已撤回，请查看最终结果。`
}

function snapshot(value: RepositoryTransferState): RepositoryTransferState | null {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null
  if (!['idle', 'running', 'cancelling', 'settled'].includes(value.phase)) return null
  if (value.kind !== null && !['connect', 'clone', 'sync'].includes(value.kind)) return null
  const clean = { sequence: value.sequence, phase: value.phase, kind: value.kind, message: '' }
  // Provider strings may contain URLs or credentials; never copy or render them.
  clean.message = repositoryTransferCaption(clean)
  return clean
}

export class RepositoryTransferModel {
  state: RepositoryTransferState | null = null
  error = ''
  private latest: RepositoryTransferState | null = null
  private knownKind: RepositoryTransferState['kind'] = null
  private revision = 0
  private serial = 0
  private frozen = false
  private frozenSummary = ''
  private frozenRequesting = false
  private disposed = false
  private pending = new Map<RepositoryTransferAction, RepositoryTransferTicket>()
  private publications: Publication[] = []

  constructor(readonly supported: boolean) {}

  get requesting(): boolean {
    if (this.frozen) return this.frozenRequesting
    return this.state?.phase === 'running' && this.pending.get('cancel')?.sequence === this.state.sequence
  }

  get summary(): string {
    if (this.frozen) return this.frozenSummary
    if (this.requesting) return '已请求取消当前传输，正在等待后台确认与后续收束；这不代表取消已经生效。'
    if (this.state) return this.state.message + (this.supported ? '' : ' 此版本未接入取消控制。')
    return this.supported ? '尚未取得后台传输状态。' : '此版本未接入传输取消控制；不会尝试兼容调用。'
  }

  allowed(action: RepositoryTransferAction): boolean {
    if (!this.supported || this.disposed || this.frozen) return false
    if (action === 'cancel') return this.latest?.phase === 'running'
      && this.pending.get('cancel')?.sequence !== this.latest.sequence
    return this.pending.get('status')?.revision !== this.revision
  }

  begin(action: RepositoryTransferAction): RepositoryTransferTicket | null {
    if (!this.allowed(action)) return null
    // A local request invalidates older observations but never changes Main's phase.
    if (action === 'cancel') this.revision += 1
    const ticket = { id: ++this.serial, action, revision: this.revision, sequence: this.latest?.sequence ?? null }
    this.pending.set(action, ticket)
    this.error = ''
    return ticket
  }

  receive(state: RepositoryTransferState): boolean {
    return !this.disposed && this.offer(state)
  }

  respond(ticket: RepositoryTransferTicket, state: RepositoryTransferState): boolean {
    if (!this.current(ticket)) return false
    if (ticket.action === 'status' && ticket.revision !== this.revision) return false
    if (ticket.action === 'cancel' && (ticket.sequence !== this.latest?.sequence || state?.sequence !== ticket.sequence)) return false
    // A same-operation terminal reply may advance after its own progress event.
    // Sequence/kind/phase still forbid rollback; it may not adopt another operation.
    return this.offer(state)
  }

  fail(ticket: RepositoryTransferTicket): boolean {
    if (!this.current(ticket) || ticket.revision !== this.revision || ticket.id !== this.serial) return false
    const message = ticket.action === 'cancel'
      ? '取消请求尚未确认，请等待操作与清理状态；部分修改可能已经生效，不会自动撤回。'
      : '传输状态请求未完成；保留最近已知状态，可主动刷新。'
    this.enqueue({ kind: 'error', ticketId: ticket.id, revision: this.revision, sequence: this.latest?.sequence ?? null, message })
    return true
  }

  finish(ticket: RepositoryTransferTicket): void {
    if (this.pending.get(ticket.action)?.id === ticket.id) this.pending.delete(ticket.action)
  }

  setClosing(closing: boolean): void {
    if (this.disposed || this.frozen === closing) return
    if (closing) this.freezeView()
    this.frozen = closing
    if (!closing) for (const item of this.publications.splice(0)) this.publish(item)
  }

  dispose(): void {
    if (!this.frozen) this.freezeView()
    this.disposed = true
    this.frozen = true
    this.pending.clear()
    this.publications = []
  }

  private freezeView(): void {
    this.frozenSummary = this.summary
    this.frozenRequesting = this.requesting
  }

  private current(ticket: RepositoryTransferTicket): boolean {
    return !this.disposed && this.pending.get(ticket.action)?.id === ticket.id
  }

  private offer(value: RepositoryTransferState): boolean {
    const next = snapshot(value)
    if (!next) return false
    const previous = this.latest
    if (previous && next.sequence < previous.sequence) return false
    if (previous?.sequence === next.sequence) {
      if (order[next.phase] < order[previous.phase]) return false
      if (this.knownKind !== null && next.kind !== null && this.knownKind !== next.kind) return false
    } else this.knownKind = null
    if (next.kind !== null) this.knownKind = next.kind
    this.latest = next
    this.revision += 1
    this.enqueue({ kind: 'state', state: next })
    return true
  }

  private enqueue(item: Publication): void {
    if (!this.frozen) { this.publish(item); return }
    // Keep at most the latest monotonic state and its still-current error.
    this.publications = item.kind === 'state' ? [item]
      : [...this.publications.filter((entry) => entry.kind === 'state'), item]
  }

  private publish(item: Publication): void {
    if (item.kind === 'state') { this.state = item.state; this.error = ''; return }
    if (item.ticketId === this.serial && item.revision === this.revision
      && item.sequence === (this.latest?.sequence ?? null)) this.error = item.message
  }
}
