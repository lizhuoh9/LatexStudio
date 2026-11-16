import type { CloudApi, CloudInvitation } from '../shared/cloud-contracts'
import type { DesktopLinksApi } from '../shared/desktop-links-contracts'
import { parseProjectLink } from '../shared/project-links'
import type { ProjectInfo } from '../shared/workspace-contracts'
import type { CollaborationModel } from './collaboration-model'
import type { Documents } from './documents'
import type { RunAction } from './sync-panel'
import { element } from './dom'
import { readableError } from './editor-model'
import { localizeStaticHtml, uiText, uiErrorValue } from './i18n-dom'
import './sharing-style.css'

const TEMPLATE = `
<dialog id="share-dialog" class="sharing-dialog" aria-labelledby="share-title">
  <div class="dialog-heading"><div><h2 id="share-title">分享项目</h2><strong id="share-project-name"></strong></div><button id="share-close" class="icon-button" aria-label="关闭分享">×</button></div>
  <p id="share-status" role="status" aria-live="polite"></p>
  <div id="share-ready" hidden><label for="share-link">项目链接</label><div class="sharing-link-row"><input id="share-link" readonly spellcheck="false"><button id="share-copy" disabled>复制链接</button></div>
  <p id="share-copy-status" role="status"></p><p class="sharing-note">链接不授予私有仓库权限。</p>
  <details><summary>邀请合作者</summary><label for="share-login">合作者 GitHub 用户名</label><div class="sharing-link-row"><input id="share-login" autocomplete="off" maxlength="39"><button id="share-invite">发送合作邀请</button></div></details></div>
  <div class="button-row"><button id="share-sign-in">GitHub登录</button><button id="share-setup" class="secondary">关联仓库</button><button id="share-retry" class="secondary">重试</button></div>
  <textarea id="share-error" class="sharing-error" aria-label="完整错误详情" readonly rows="5" hidden></textarea>
</dialog>
<dialog id="join-dialog" class="sharing-dialog" aria-labelledby="join-title">
  <div class="dialog-heading"><h2 id="join-title">加入项目</h2><button id="join-close" class="icon-button" aria-label="关闭加入项目">×</button></div>
  <label for="join-link">项目链接</label><input id="join-link" type="url" placeholder="粘贴项目分享链接" autocomplete="off" spellcheck="false" maxlength="2048">
  <strong id="join-repository" class="sharing-repository"></strong><p id="join-status" role="status" aria-live="polite"></p>
  <div class="button-row"><button id="join-sign-in">GitHub登录</button><button id="join-download">选择本地文件夹并下载</button><button id="join-cancel-transfer" class="secondary" hidden>取消传输</button></div>
  <div class="button-row"><button id="join-invitations" class="secondary">查看此项目的邀请</button><button id="join-authorization" class="secondary">管理 GitHub 项目授权</button></div>
  <ul id="join-invitation-list" class="detail-list"></ul>
  <textarea id="join-error" class="sharing-error" aria-label="完整错误详情" readonly rows="6" hidden></textarea>
</dialog>`
type Ticket = { epoch: number; project: ProjectInfo | null; account: number | null }

/** Link intake presents a choice only. Every download/invite still uses the ordinary Main workflow. */
export class SharingPanel {
  private disposed = false
  private closing = false
  private busy = false
  private ready = false
  private linkGeneration = 0
  private downloading = false
  private canceling = false
  private epoch = 0
  private pending: string | null = null
  private waitingLogin: 'share' | 'join' | null = null
  private accountId: number | null
  private cleanups: (() => void)[] = []

  constructor(private api: CloudApi | undefined, private links: DesktopLinksApi | undefined,
    private documents: Documents, private model: CollaborationModel, private run: RunAction,
    private adopt: (project: ProjectInfo) => Promise<void>, private login: () => void,
    private setup: () => void, private canPresent: () => boolean, private cancelTransfer?: () => Promise<unknown>) {
    element('sharing-dialogs').innerHTML = TEMPLATE
    localizeStaticHtml(element('sharing-dialogs'))
    this.accountId = model.account?.id ?? null
    this.bind('share-close', () => this.dialog('share').close())
    this.bind('join-close', () => this.dialog('join').close())
    this.bind('share-copy', () => { void this.copy() })
    this.bind('share-retry', () => this.loadShare())
    this.bind('share-invite', () => this.action('share', () => this.invite()))
    this.bind('share-sign-in', () => this.signIn('share'))
    this.bind('join-sign-in', () => this.signIn('join'))
    this.bind('share-setup', () => { this.dialog('share').close(); this.setup() })
    this.bind('join-download', () => this.action('join', () => this.download()))
    this.bind('join-cancel-transfer', () => { void this.cancelDownload() })
    this.bind('join-invitations', () => this.action('join', () => this.invitations()))
    this.bind('join-authorization', () => this.action('join', () => this.api!.openAuthorization()))
    const input = element<HTMLInputElement>('join-link'), changed = () => this.renderJoin()
    input.addEventListener('input', changed)
    this.cleanups.push(() => input.removeEventListener('input', changed))
    for (const kind of ['share', 'join'] as const) {
      const dialog = this.dialog(kind), closed = () => { this.epoch += 1 }, cancel = (event: Event) => {
        if (this.busy || this.closing || this.disposed) event.preventDefault()
      }
      dialog.addEventListener('close', closed); dialog.addEventListener('cancel', cancel)
      this.cleanups.push(() => { dialog.removeEventListener('close', closed); dialog.removeEventListener('cancel', cancel) })
    }
    const resumed = () => queueMicrotask(() => this.flushPending())
    document.addEventListener('close', resumed, true)
    this.cleanups.push(() => document.removeEventListener('close', resumed, true))
    if (links) {
      this.cleanups.push(links.onLink(link => this.receiveLink(link)))
      const generation = this.linkGeneration
      void links.pending().then(link => { if (link && generation === this.linkGeneration) this.receiveLink(link) }, () => undefined)
    }
    this.controls()
  }

  markReady(): void { this.ready = true; this.flushPending() }

  openShare(): void {
    if (!this.available() || !this.canPresent() || !this.documents.project || document.querySelector('dialog[open]')) return
    this.clearShare()
    element('share-project-name').textContent = this.documents.project.name
    this.dialog('share').showModal()
    this.loadShare()
  }

  openJoin(link?: string): void {
    if (!this.available() || !this.canPresent() || document.querySelector('dialog[open]')) return
    if (link !== undefined) element<HTMLInputElement>('join-link').value = link
    this.error('join', '')
    element('join-invitation-list').replaceChildren()
    this.dialog('join').showModal()
    this.renderJoin()
    element('join-link').focus()
  }

  private receiveLink(value: string): void {
    if (this.disposed) return
    try { this.pending = parseProjectLink(value).appUrl; this.linkGeneration += 1; this.flushPending() } catch { /* Invalid links never perform work. */ }
  }

  flushPending(): void {
    this.controls()
    if (!this.ready || !this.pending || !this.available() || !this.canPresent() || document.querySelector('dialog[open]')) return
    const link = this.pending
    this.pending = null
    this.openJoin(link)
    void this.links?.acknowledge(link).catch(() => undefined)
  }

  accountChanged(): void {
    const id = this.model.account?.id ?? null
    if (id !== this.accountId) {
      this.accountId = id; this.epoch += 1; this.clearShare()
      element('join-invitation-list').replaceChildren()
    }
    if (id !== null && this.waitingLogin) {
      const destination = this.waitingLogin
      this.waitingLogin = null
      const account = element<HTMLDialogElement>('cloud-dialog')
      if (account.open) account.close()
      queueMicrotask(() => { if (destination === 'join') this.openJoin(); else this.openShare() })
    }
    this.renderJoin()
    this.controls()
  }

  projectChanged(): void {
    this.epoch += 1; this.clearShare()
    for (const kind of ['share', 'join'] as const) if (this.dialog(kind).open) this.dialog(kind).close()
    element('join-invitation-list').replaceChildren()
    this.controls()
  }

  setClosing(value: boolean): void {
    this.closing = value; this.epoch += 1
    if (value) this.clearShare()
    this.controls()
    if (!value) this.flushPending()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.epoch += 1; this.pending = null; this.waitingLogin = null
    this.clearShare()
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    for (const kind of ['share', 'join'] as const) if (this.dialog(kind).open) this.dialog(kind).close()
    this.controls()
  }

  private available(): boolean { return !this.disposed && !this.closing && !this.busy }
  private dialog(kind: 'share' | 'join'): HTMLDialogElement { return element<HTMLDialogElement>(`${kind}-dialog`) }
  private ticket(): Ticket { return { epoch: this.epoch, project: this.documents.project, account: this.model.account?.id ?? null } }
  private current(ticket: Ticket): boolean {
    return !this.disposed && !this.closing && ticket.epoch === this.epoch && ticket.project === this.documents.project
      && ticket.account === (this.model.account?.id ?? null)
  }
  private bind(id: string, action: () => void): void {
    const node = element(id)
    node.addEventListener('click', action)
    this.cleanups.push(() => node.removeEventListener('click', action))
  }
  private error(kind: 'share' | 'join', message: string): void {
    const field = element<HTMLTextAreaElement>(`${kind}-error`)
    uiErrorValue(field, message); field.hidden = !message
  }
  private clearShare(): void {
    element<HTMLInputElement>('share-link').value = ''
    element<HTMLInputElement>('share-login').value = ''
    element('share-ready').hidden = true
    uiText(element('share-copy-status'), '')
  }

  private action(kind: 'share' | 'join', action: () => Promise<void>): void {
    if (!this.available() || !this.canPresent() || !this.api) return
    const ticket = this.ticket()
    this.run(kind === 'share' ? '分享项目' : '加入项目', async () => {
      if (!this.current(ticket) || this.busy) return
      this.busy = true; this.error(kind, ''); this.controls()
      try { await action() } catch (error) { if (this.current(ticket)) this.error(kind, readableError(error)) }
      finally { this.busy = false; if (!this.disposed) { this.controls(); this.flushPending() } }
    }, kind === 'join')
  }

  private loadShare(): void {
    if (!this.model.account) { uiText(element('share-status'), '请先登录 GitHub。'); this.controls(); return }
    this.action('share', async () => {
      const ticket = this.ticket(), state = await this.api!.status()
      if (!this.current(ticket) || !this.dialog('share').open) return
      if (!state.connection || !state.signedIn) { uiText(element('share-status'), '此论文尚未关联 GitHub 私有合作项目。'); return }
      const source = await this.api!.shareProject()
      if (!this.current(ticket) || !this.dialog('share').open) return
      const target = parseProjectLink(source)
      if (target.owner.toLowerCase() !== state.connection.owner.toLowerCase() || target.name.toLowerCase() !== state.connection.name.toLowerCase()) throw new Error('分享链接与当前项目不一致。')
      const field = element<HTMLInputElement>('share-link')
      field.value = target.appUrl
      element('share-ready').hidden = false
      uiText(element('share-status'), '')
      field.focus(); field.select()
    })
  }

  private async copy(): Promise<void> {
    const value = element<HTMLInputElement>('share-link').value, ticket = this.ticket()
    if (!this.available() || !value || element('share-ready').hidden || !this.dialog('share').open) return
    try {
      await navigator.clipboard.writeText(value)
      if (this.current(ticket) && this.dialog('share').open && element<HTMLInputElement>('share-link').value === value) uiText(element('share-copy-status'), '已复制链接')
    } catch {
      if (!this.current(ticket) || !this.dialog('share').open) return
      element<HTMLInputElement>('share-link').focus(); element<HTMLInputElement>('share-link').select()
      uiText(element('share-copy-status'), '复制未完成，已选中链接，可手动复制。')
    }
  }

  private signIn(kind: 'share' | 'join'): void {
    if (!this.available() || !this.model.allowed('login')) return
    this.waitingLogin = kind
    this.dialog(kind).close()
    this.login()
  }

  private async invite(): Promise<void> {
    const login = element<HTMLInputElement>('share-login').value.trim(), ticket = this.ticket()
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw new Error('请填写 GitHub 用户名，不是邮箱或密钥。')
    const result = await this.api!.inviteCollaborator(login)
    if (this.current(ticket)) uiText(element('share-status'), result.message)
  }

  private target() {
    try { return parseProjectLink(element<HTMLInputElement>('join-link').value.trim()) } catch { return null }
  }
  private renderJoin(): void {
    const target = this.target()
    element('join-repository').textContent = target ? `${target.owner}/${target.name}` : ''
    uiText(element('join-status'), !this.model.account ? '请先登录 GitHub。' : '')
    this.controls()
  }

  private async download(): Promise<void> {
    const target = this.target(), ticket = this.ticket()
    if (!target || !this.model.account) return
    if (this.documents.buffer.dirty && !await this.documents.save()) throw new Error('保存未完成，未执行云端操作；编辑草稿已保留。')
    if (!this.current(ticket) || this.documents.buffer.dirty || this.documents.buffer.conflict) return
    const version = this.documents.buffer.editVersion, path = this.documents.buffer.path
    uiText(element('join-status'), '请选择空文件夹保存项目。')
    let project: ProjectInfo | null
    this.downloading = true; this.controls()
    try { project = await this.api!.joinProject(target.appUrl) }
    finally { this.downloading = false; this.controls() }
    // Main has committed a real ProjectInfo: closing/account epochs alone cannot undo that commit.
    if (!project || this.disposed || ticket.project !== this.documents.project || version !== this.documents.buffer.editVersion
      || path !== this.documents.buffer.path || this.documents.buffer.dirty || this.documents.buffer.conflict) return
    this.dialog('join').close()
    await this.adopt(project)
  }

  private async cancelDownload(): Promise<void> {
    if (!this.downloading || this.canceling || this.closing || this.disposed || !this.cancelTransfer) return
    const ticket = this.ticket()
    this.canceling = true; this.controls()
    try { await this.cancelTransfer() } catch (error) { if (this.current(ticket)) this.error('join', readableError(error)) }
    finally { this.canceling = false; if (!this.disposed) this.controls() }
  }

  private async invitations(): Promise<void> {
    const target = this.target(), ticket = this.ticket()
    if (!target || !this.model.account) return
    const invitations = await this.api!.invitations()
    if (!this.current(ticket) || this.target()?.appUrl !== target.appUrl) return
    const matches = invitations.filter(invitation => invitation.owner.toLowerCase() === target.owner.toLowerCase()
      && invitation.name.toLowerCase() === target.name.toLowerCase()).slice(0, 20)
    element('join-invitation-list').replaceChildren(...matches.map(invitation => this.invitation(invitation, ticket, target.appUrl)))
    if (!matches.length) uiText(element('join-status'), '未找到此项目的待接受邀请。请确认账号、仓库权限和应用授权。')
  }

  private invitation(invitation: CloudInvitation, ticket: Ticket, link: string): HTMLLIElement {
    const row = document.createElement('li'), name = document.createElement('span'), button = document.createElement('button')
    name.textContent = `${invitation.owner}/${invitation.name}`
    button.type = 'button'; button.dataset.joinInvitation = 'true'; uiText(button, '接受邀请')
    button.addEventListener('click', () => {
      if (button.disabled || !this.current(ticket) || this.target()?.appUrl !== link) return
      this.action('join', async () => {
        const result = await this.api!.acceptInvitation(invitation.handle)
        if (this.current(ticket)) { uiText(element('join-status'), result.message); element('join-invitation-list').replaceChildren() }
      })
    })
    row.append(name, button)
    return row
  }

  private controls(): void {
    const locked = !this.available() || !this.canPresent() || !this.api, signedIn = !!this.model.account
    element<HTMLInputElement>('join-link').disabled = this.busy || this.closing || this.disposed
    element<HTMLInputElement>('share-login').disabled = locked
    for (const kind of ['share', 'join'] as const) element<HTMLButtonElement>(`${kind}-close`).disabled = this.busy || this.closing || this.disposed
    const shareReady = !element('share-ready').hidden && !!element<HTMLInputElement>('share-link').value
    for (const kind of ['share', 'join'] as const) {
      const login = element<HTMLButtonElement>(`${kind}-sign-in`)
      login.hidden = signedIn; login.disabled = locked || !this.model.allowed('login')
    }
    element<HTMLButtonElement>('share-copy').disabled = locked || !shareReady
    element<HTMLButtonElement>('share-invite').disabled = locked || !signedIn || !shareReady
    element<HTMLButtonElement>('share-retry').disabled = locked || !signedIn
    element<HTMLButtonElement>('share-setup').hidden = shareReady
    element<HTMLButtonElement>('share-setup').disabled = locked || !this.documents.project
    element<HTMLButtonElement>('join-download').disabled = locked || !signedIn || !this.target()
    element('join-cancel-transfer').hidden = !this.downloading || !this.cancelTransfer
    element<HTMLButtonElement>('join-cancel-transfer').disabled = !this.downloading || this.canceling || this.closing || this.disposed
    element<HTMLButtonElement>('join-invitations').disabled = locked || !signedIn || !this.target()
    element<HTMLButtonElement>('join-authorization').disabled = locked
    for (const node of element('join-invitation-list').querySelectorAll<HTMLButtonElement>('[data-join-invitation]')) node.disabled = locked || !signedIn
  }
}
