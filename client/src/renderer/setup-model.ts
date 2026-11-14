import type { TexSetupState } from '../shared/tex-setup-contracts'
import { readableError } from './editor-model'

export type SetupAction = 'status' | 'prepare' | 'cancel'
export interface SetupTicket { revision: number; operation: number }
const activePhases = new Set<TexSetupState['phase']>(['checking', 'downloading', 'extracting', 'verifying'])
const labels: Record<TexSetupState['phase'], string> = {
  required: '编译组件尚未配置', checking: '正在检查编译组件…', downloading: '正在读取内置组件…',
  extracting: '正在配置编译组件…', verifying: '正在验证编译组件…', prepared: '编译组件已配置', error: '编译组件配置失败'
}

export class SetupModel {
  state: TexSetupState | null = null
  error = ''
  closing = false
  private revision = 0
  private operation = 0
  private pending = new Set<SetupAction>()

  constructor(readonly available: boolean) {}

  get preparing(): boolean { return this.pending.has('prepare') }

  get verified(): boolean {
    return this.available && !this.error && this.state?.phase === 'prepared' && this.state.supported && this.state.compileVerified
  }

  get summary(): string {
    if (!this.available) return '编译组件服务不可用'
    if (this.error) return '编译组件检查失败'
    if (!this.state) return '正在检查编译组件…'
    if (!this.state.supported) return '当前系统暂不支持编译'
    if (this.verified) return '编译组件已就绪'
    if (this.state.phase === 'prepared') return '编译组件尚未通过验证'
    return labels[this.state.phase]
  }

  get attention(): boolean {
    return !this.available || Boolean(this.error) || this.state?.supported === false
      || this.state?.phase === 'error' || (this.state?.phase === 'prepared' && !this.verified)
  }

  get progress(): { value: number; total: number; percent: number | null } {
    const completed = this.state?.completed ?? 0
    const expected = this.state?.total ?? 0
    const total = Number.isFinite(expected) ? Math.max(0, expected) : 0
    const value = Number.isFinite(completed) ? Math.max(0, Math.min(total || completed, completed)) : 0
    return { value, total, percent: total > 0 ? Math.min(100, Math.floor(value / total * 100)) : null }
  }

  allowed(action: SetupAction): boolean {
    if (!this.available || this.closing || this.pending.has(action)) return false
    if (action === 'status') return true
    const phase = this.state?.phase
    if (action === 'cancel') return this.pending.has('prepare') || (phase !== undefined && activePhases.has(phase))
    return this.state?.supported === true && (phase === 'required' || phase === 'error')
      && !this.pending.has('prepare') && !this.pending.has('cancel')
  }

  begin(action: SetupAction): SetupTicket | null {
    if (!this.allowed(action)) return null
    this.pending.add(action)
    this.error = ''
    if (action !== 'status') this.operation += 1
    return { revision: this.revision, operation: this.operation }
  }

  receive(state: TexSetupState): void {
    this.revision += 1
    this.apply(state)
  }

  respond(action: SetupAction, state: TexSetupState, ticket: SetupTicket): boolean {
    if (ticket.operation !== this.operation || (action === 'status' && ticket.revision !== this.revision)) return false
    this.apply(state)
    return true
  }

  fail(error: unknown): void { this.error = readableError(error).slice(0, 1600) }
  finish(action: SetupAction): void { this.pending.delete(action) }

  private apply(state: TexSetupState): void {
    this.state = { ...state }
    this.error = ''
  }
}

export function environmentNotice(ready: boolean, verified: boolean, available: boolean | null,
  error: string, summary: string): { message: string; hidden: boolean; problem: boolean } {
  if (error) return { message: '编译组件检查失败', hidden: false, problem: true }
  if (ready && verified && available === true) return { message: '编译组件已就绪', hidden: true, problem: false }
  const message = !verified ? summary : available === false ? '编译环境不可用' : '正在检查编译环境…'
  return { message, hidden: false, problem: verified && available === false }
}

export function setupBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export function setupDetail(message: string): string {
  return readableError(new Error(message)).slice(0, 1600)
}
