import { uiText, uiFormattedText } from './i18n-dom'
import { intlLocale, translate } from '../shared/i18n'
import type { CloudProject, CollaborationApi } from '../shared/collaboration-contracts'
import { button, element, text } from './dom'
import { CollaborationModel, collaborationDetail, VERIFICATION_URI, type CollaborationAction, type CollaborationTicket } from './collaboration-model'

export class CollaborationPanel {
  readonly model: CollaborationModel
  private disposed = false
  private initialized = false
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private renderedProjects: CloudProject[] | null = null
  private renderedPrompt: string | null = null
  private copyState: { key: string; failed: boolean } | null = null

  constructor(private api: CollaborationApi | undefined, now: () => number = () => Date.now(),
    private changed: () => void = () => undefined) {
    this.model = new CollaborationModel(Boolean(api), now)
    const actions: CollaborationAction[] = ['status', 'login', 'cancel', 'logout', 'verify', 'projects']
    for (const action of actions) button(`collaboration-${action}`, () => { void this.request(action) })
    button('collaboration-copy', () => { void this.copyCode() })
    this.render()
  }

  initialize(): void {
    if (this.initialized || this.disposed) return
    this.initialized = true
    if (!this.api) return
    try {
      this.unsubscribe = this.api.onState((state) => {
        if (!this.disposed) { this.model.receive(state); this.publish() }
      })
      this.timer = setInterval(() => { this.model.tick(); this.publish() }, 1000)
      void this.request('status')
    } catch { this.model.fail('status'); this.publish() }
  }

  setClosing(closing: boolean): void { this.model.setClosing(closing); this.publish() }

  startLogin(): void { void this.request('login') }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.model.dispose()
    this.code()
  }

  private async request(action: CollaborationAction): Promise<void> {
    if (this.disposed) return
    const ticket = this.model.begin(action)
    if (!this.api || !ticket || this.disposed) return
    this.publish()
    try { await this.perform(action, ticket) }
    catch { if (!this.disposed) this.model.fail(action, ticket) }
    finally {
      if (!this.disposed) { this.model.finish(action, ticket); this.publish() }
    }
  }

  private async perform(action: CollaborationAction, ticket: CollaborationTicket): Promise<void> {
    const api = this.api
    if (!api) return
    if (action === 'verify') { await api.openVerification(); return }
    if (action === 'projects') {
      const projects = await api.projects()
      if (!this.disposed) this.model.projectResponse(projects, ticket)
      return
    }
    const result = action === 'status' ? await api.status() : action === 'login' ? await api.startLogin()
      : action === 'cancel' ? await api.cancelLogin() : await api.logout()
    if (!this.disposed) this.model.respond(result, ticket)
  }

  private publish(): void {
    if (this.disposed) return
    if (this.model.closing) { this.controls(); this.code(); return }
    this.render()
  }

  private render(): void {
    if (this.model.account) text('collaboration-state', this.accountStatus())
    else uiText(element('collaboration-state'), this.accountStatus())
    const phase = this.model.state?.phase
    const detail = phase === 'error' || phase === 'authorizing' || this.recovering() ? collaborationDetail(this.model.state?.message ?? '') : ''
    text('collaboration-detail', detail)
    element('collaboration-detail').hidden = !detail
    const expires = this.model.account ? this.model.state?.expiresAt : null
    uiFormattedText(element('collaboration-session-expiry'), () => expires ? this.model.state?.renewable === true ? translate(this.model.state.sessionOnly ? '本次运行自动保持登录' : '自动保持登录') :
      translate(`到期 ${new Date(expires).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' })}`) : '')
    element('collaboration-session-expiry').hidden = !expires
    element('collaboration-project-area').hidden = !this.model.account
    text('collaboration-error', this.model.error)
    element('collaboration-error').hidden = !this.model.error
    this.controls()
    this.code()
    this.projectList()
    this.changed()
  }

  private accountStatus(): string {
    if (!this.model.available) return 'GitHub 登录不可用'
    const state = this.model.state, account = this.model.account
    if (!state) return '正在连接 GitHub…'
    if (state.phase === 'unconfigured') return 'GitHub 登录未配置'
    if (this.model.expired) return '登录已到期'
    if (account) return account.name && account.name !== account.login ? `${account.name} · ${account.login}` : account.login
    if (this.model.allowed('cancel') && !this.model.prompt) return '正在登录…'
    if (state.phase === 'authorizing') return '等待 GitHub 授权…'
    if (this.recovering()) return '等待恢复 GitHub 连接…'
    return state.phase === 'error' ? '暂时无法登录' : '未登录'
  }

  private recovering(): boolean { return this.model.state?.renewable === true && !this.model.account && this.model.state.phase === 'signed-out' }

  private controls(): void {
    const actions: CollaborationAction[] = ['status', 'login', 'cancel', 'logout', 'verify', 'projects']
    for (const action of actions) element<HTMLButtonElement>(`collaboration-${action}`).disabled = !this.model.allowed(action)
    text('collaboration-login', this.model.expired ? '重新登录' : 'GitHub登录')
    if (this.model.closing) return
    const account = Boolean(this.model.account), authorizing = this.model.allowed('cancel') || Boolean(this.model.prompt)
    element('collaboration-login').hidden = account || authorizing || !this.model.allowed('login')
    element('collaboration-cancel').hidden = !authorizing
    element('collaboration-logout').hidden = !account && !this.recovering()
    element('collaboration-projects').hidden = !account
    element('collaboration-status').hidden = !this.model.available || !this.model.error
      && this.model.state?.phase !== 'error' && this.model.state?.phase !== 'unconfigured' && !this.recovering()
    element('collaboration-verify').hidden = !this.model.prompt
  }

  private code(): void {
    const prompt = this.model.prompt
    text('collaboration-code', prompt?.userCode ?? '')
    text('collaboration-expiry', prompt ? `授权码剩余 ${this.model.remainingSeconds} 秒` : '')
    text('collaboration-verification', prompt ? VERIFICATION_URI : '')
    const key = prompt ? `${prompt.userCode}:${prompt.expiresAt}` : null
    if (key !== this.renderedPrompt) { element<HTMLDetailsElement>('collaboration-fallback').open = false; this.copyState = null }
    this.renderedPrompt = key
    element<HTMLButtonElement>('collaboration-copy').disabled = !prompt || this.disposed
    text('collaboration-copy', this.copyState?.key === key ? this.copyState.failed ? '复制失败，重试' : '已复制' : '复制验证码')
    element('collaboration-authorization').hidden = !prompt
  }

  private async copyCode(): Promise<void> {
    const prompt = this.model.prompt
    if (!prompt || this.disposed || this.model.closing) return
    const key = `${prompt.userCode}:${prompt.expiresAt}`
    let failed = false
    try { await navigator.clipboard.writeText(prompt.userCode) } catch { failed = true }
    if (this.disposed || this.model.closing || this.renderedPrompt !== key) return
    this.copyState = { key, failed }
    this.code()
  }

  private projectList(): void {
    const projects = this.model.projects
    if (projects === this.renderedProjects) return
    this.renderedProjects = projects
    const list = element('collaboration-project-list')
    list.replaceChildren()
    for (const project of projects) {
      const item = document.createElement('li')
      const name = document.createElement('strong')
      name.textContent = `${project.owner}/${project.name}`
      const scope = document.createElement('small')
      uiText(scope, project.private ? '私有' : '公开')
      item.append(name, scope); list.append(item)
    }
    if (!projects.length) {
      const item = document.createElement('li')
      uiText(item, this.model.account ? '尚未加载项目' : '')
      list.append(item)
    }
  }
}
