import type { CloudAccount, CloudProject, CollaborationState, DevicePrompt } from '../shared/collaboration-contracts'
import { readableError } from './editor-model'

export type CollaborationAction = 'status' | 'login' | 'cancel' | 'logout' | 'verify' | 'projects'
export interface CollaborationTicket { id: number; auth: number; revision: number; account: number | null; action: CollaborationAction; reconcile: boolean }
type Queued = { kind: 'state'; state: CollaborationState; at: number; recovery?: CollaborationTicket }
  | { kind: 'projects'; projects: CloudProject[]; ticket: CollaborationTicket }
  | { kind: 'failure'; action: CollaborationAction; auth: number; revision: number }
const labels = { status: '刷新登录状态', login: '登录', cancel: '取消登录', logout: '退出此设备', verify: '打开官方授权页', projects: '查看授权项目' }
export const VERIFICATION_URI = 'https://github.com/login/device'

export function collaborationDetail(message: string): string {
  return readableError(new Error(message)).replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, '[短期授权码]')
    .replace(/\b(?:device_code|user_code|access_token|refresh_token)\s*[:=]\s*\S+/gi, '[已隐藏授权信息]').slice(0, 600)
}

/** No credential or browser persistence. Main-process events take precedence over old replies. */
export class CollaborationModel {
  state: CollaborationState | null = null
  projects: CloudProject[] = []
  error = ''
  closing = false
  expired = false
  private configured = false
  private denySignIn = false
  private revision = 0
  private auth = 0
  private serial = 0
  private reconcileAfter: number | null = null
  private pending = new Map<CollaborationAction, CollaborationTicket>()
  private queued: Queued[] = []

  constructor(readonly available: boolean, private now: () => number = () => Date.now()) {}

  get account(): CloudAccount | null {
    const state = this.state
    if (this.expired || state?.phase !== 'signed-in' || !state.account) return null
    if (!Number.isSafeInteger(state.account.id) || state.account.id <= 0 || !state.account.login.trim()) return null
    if (state.expiresAt !== null && (!Number.isFinite(state.expiresAt) || state.expiresAt <= this.now())) return null
    return state.account
  }

  get prompt(): DevicePrompt | null {
    const prompt = this.state?.phase === 'authorizing' ? this.state.authorization : null
    if (this.closing || this.expired || !prompt || prompt.verificationUri !== VERIFICATION_URI) return null
    if (!/^[A-Z0-9-]{4,32}$/.test(prompt.userCode) || !Number.isFinite(prompt.expiresAt) || prompt.expiresAt <= this.now()) return null
    return prompt
  }

  get remainingSeconds(): number {
    const prompt = this.prompt
    return prompt ? Math.max(0, Math.ceil((prompt.expiresAt - this.now()) / 1000)) : 0
  }

  get summary(): string {
    if (!this.available) return '此桌面版本未接入普通协作登录；编辑与本地历史仍可用。'
    if (!this.state) return '正在确认普通协作登录是否可用；本地写作不受影响。'
    if (this.state.phase === 'unconfigured') return '此开发版未配置普通协作登录；编辑与本地历史仍可用。'
    if (this.expired) return '授权已到期，请重新登录；不会自动续期或传输项目。'
    if (this.account) return `当前运行已登录：${this.account.name || this.account.login}（${this.account.login}）`
    if (this.state.phase === 'authorizing') return '等待你在官方页面授权；可随时取消。'
    if (this.state.phase === 'error') return '普通协作登录暂未就绪，请刷新状态或重试。'
    return '尚未登录；编辑、保存与本地历史不需要账号。'
  }

  allowed(action: CollaborationAction): boolean {
    if (!this.available || this.closing || this.hasCurrent(action)) return false
    if (action === 'status') return true
    const changing = this.hasCurrent('login') || this.hasCurrent('cancel') || this.hasCurrent('logout')
    if (action === 'login') return this.configured && !changing && !this.account && (this.state?.phase !== 'authorizing' || this.expired)
    if (action === 'cancel') return !this.hasCurrent('logout') && (this.hasCurrent('login') || this.state?.phase === 'authorizing')
    if (action === 'logout') return !this.hasCurrent('cancel') && this.state?.phase === 'signed-in'
    if (action === 'verify') return Boolean(this.prompt) && !this.hasCurrent('cancel') && !this.hasCurrent('logout')
    return Boolean(this.account) && !changing
  }

  begin(action: CollaborationAction): CollaborationTicket | null {
    this.tick()
    if (!this.allowed(action)) return null
    const id = ++this.serial
    if (action === 'login' || action === 'cancel' || action === 'logout') {
      this.auth += 1
      this.denySignIn = action !== 'login'
      this.reconcileAfter = action === 'login' ? null : id
      this.expired = false
      this.projects = []
      if (this.state) this.state = { ...this.state, account: null, authorization: null, expiresAt: null }
    }
    const reconcile = action === 'status' && this.reconcileAfter !== null && !this.expired
      && !this.hasCurrent('login') && !this.hasCurrent('cancel') && !this.hasCurrent('logout')
    const ticket = { id, auth: this.auth, revision: this.revision, account: this.account?.id ?? null, action, reconcile }
    this.pending.set(action, ticket)
    this.error = ''
    return ticket
  }

  finish(action: CollaborationAction, ticket: CollaborationTicket): void {
    if (this.pending.get(action)?.id === ticket.id) this.pending.delete(action)
  }

  fail(action: CollaborationAction, ticket?: CollaborationTicket): boolean {
    if (ticket && (!this.current(ticket) || this.pending.get(action)?.id !== ticket.id)) return false
    this.enqueue({ kind: 'failure', action, auth: this.auth, revision: this.revision })
    return true
  }

  receive(state: CollaborationState): void {
    if (this.denySignIn && (state.phase === 'signed-in' || state.phase === 'authorizing')) return
    this.revision += 1
    this.enqueue({ kind: 'state', state, at: this.now() })
  }

  respond(state: CollaborationState, ticket: CollaborationTicket): boolean {
    if (!this.current(ticket)) return false
    const recovery = this.canReconcile(ticket) ? ticket : undefined
    if (this.denySignIn && (state.phase === 'signed-in' || state.phase === 'authorizing') && !recovery) return false
    this.enqueue({ kind: 'state', state, at: this.now(), recovery })
    return true
  }

  projectResponse(projects: CloudProject[], ticket: CollaborationTicket): boolean {
    if (!this.currentProjects(ticket)) return false
    this.enqueue({ kind: 'projects', projects, ticket })
    return true
  }

  setClosing(closing: boolean): void {
    if (this.closing === closing) return
    this.closing = closing
    if (closing) return
    const queued = this.queued
    this.queued = []
    for (const item of queued) this.apply(item)
    this.tick()
  }

  tick(): boolean { return !this.closing && this.expireAt(this.now()) }

  private expireAt(at: number): boolean {
    const expiry = this.state?.phase === 'authorizing' ? this.state.authorization?.expiresAt : this.state?.expiresAt
    if (expiry === null || expiry === undefined || expiry > at || this.expired) return false
    this.expired = true
    this.denySignIn = true
    this.reconcileAfter = null
    this.auth += 1
    this.projects = []
    if (this.state) this.state = { ...this.state, authorization: null, account: null, expiresAt: null }
    this.pending.delete('login'); this.pending.delete('cancel'); this.pending.delete('projects')
    return true
  }

  dispose(): void {
    this.auth += 1; this.denySignIn = true; this.reconcileAfter = null
    this.projects = []; this.queued = []; this.pending.clear()
    if (this.state) this.state = { ...this.state, authorization: null, account: null, expiresAt: null }
  }

  private enqueue(item: Queued): void { if (this.closing) this.queued.push(item); else this.apply(item) }

  private apply(item: Queued): void {
    if (item.kind === 'state') {
      const recover = item.recovery !== undefined && this.current(item.recovery) && this.canReconcile(item.recovery)
      this.applyState(item.state, item.at, recover)
    } else if (item.kind === 'projects') {
      if (this.currentProjects(item.ticket)) this.projects = item.projects.map((project) => ({ ...project }))
    } else if (item.auth === this.auth && item.revision === this.revision) {
      this.error = `${labels[item.action]}请求未完成。登录状态仍以主进程报告为准，请刷新或重试；不会自动重试登录。`
    }
  }

  private hasCurrent(action: CollaborationAction): boolean { return this.pending.get(action)?.auth === this.auth }
  private current(ticket: CollaborationTicket): boolean { return ticket.auth === this.auth && ticket.revision === this.revision }

  private canReconcile(ticket: CollaborationTicket): boolean {
    return ticket.action === 'status' && ticket.reconcile && this.reconcileAfter !== null && ticket.id > this.reconcileAfter
      && this.configured && !this.expired && !this.hasCurrent('login') && !this.hasCurrent('cancel') && !this.hasCurrent('logout')
  }

  private currentProjects(ticket: CollaborationTicket): boolean {
    return ticket.auth === this.auth && ticket.revision === this.revision && ticket.account === this.account?.id && Boolean(this.account)
  }

  private identity(state: CollaborationState | null): string {
    return state?.phase === 'signed-in' ? `account:${state.account?.id}:${state.expiresAt}`
      : state?.phase === 'authorizing' ? `prompt:${state.authorization?.userCode}:${state.authorization?.expiresAt}` : state?.phase ?? 'unknown'
  }

  private applyState(state: CollaborationState, at: number, recover = false): void {
    if (state.sessionOnly !== true) state = { phase: 'unconfigured', message: '本版仅支持当前运行会话，登录桥接状态不匹配。',
      account: null, authorization: null, expiresAt: null, sessionOnly: true }
    if (this.denySignIn && !recover && (state.phase === 'signed-in' || state.phase === 'authorizing')) return
    if (state.phase !== 'signed-in' && state.phase !== 'authorizing') this.reconcileAfter = null
    if (state.phase === 'unconfigured') { this.configured = false; this.denySignIn = true }
    else this.configured = true // A Main error permits an explicit retry, never an automatic login.
    if (state.phase === 'error') this.denySignIn = true
    const clean = { ...state, account: state.phase === 'signed-in' ? state.account : null,
      authorization: state.phase === 'authorizing' ? state.authorization : null }
    if (this.identity(this.state) !== this.identity(clean)) { this.auth += 1; this.projects = [] }
    if (state.phase !== 'signed-in') this.projects = []
    this.state = clean
    this.expired = false
    this.error = ''
    this.expireAt(at)
  }
}
