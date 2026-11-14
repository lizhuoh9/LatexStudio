import type { CloudApi, CloudProjectChoice, CloudWorkspaceStatus } from '../shared/cloud-contracts'
import type { ProjectInfo } from '../shared/workspace-contracts'
import type { Documents } from './documents'
import type { Dialogs } from './dialogs'
import type { RunAction } from './sync-panel'
import { element, listItem, text } from './dom'
import { readableError } from './editor-model'

type Ticket = { project: ProjectInfo | null; version: number; path: string; epoch: number }
const TEMPLATE = `
  <header><h3>当前论文同步</h3><button id="cp-refresh" type="button">刷新</button></header>
  <p id="cp-status" role="status" aria-live="polite"></p>
  <p id="cp-message" role="status" aria-live="polite"></p>
  <section id="cp-error" role="region" aria-labelledby="cp-error-title" tabindex="-1" hidden>
    <header><h4 id="cp-error-title">操作失败详情</h4><div class="cp-error-actions">
      <button id="cp-error-copy" type="button">复制详情</button><button id="cp-error-dismiss" type="button">关闭详情</button>
    </div></header>
    <textarea id="cp-error-detail" aria-label="完整错误详情" rows="8" readonly spellcheck="false" wrap="soft"></textarea>
    <p id="cp-error-copy-status" role="status" aria-live="polite"></p>
  </section>
  <button id="cp-authorization" type="button">管理 GitHub 项目授权</button>
  <details class="cp-group"><summary>创建或加入合作项目</summary>
  <div class="cp-row"><label>项目名称 <input id="cp-name" placeholder="my-paper（字母、数字、短横线）" maxlength="100"></label>
  <button id="cp-create" type="button">创建私有合作项目</button></div>
  <div class="cp-row"><label>合作链接 <input id="cp-join-link" type="url" placeholder="粘贴项目分享链接"></label>
  <button id="cp-join" type="button">加入并下载到本地</button></div>
  <p class="cp-note">链接不会授予私有项目权限。请先登录、接受邀请，并为应用授权该项目，再下载。</p></details>
  <details class="cp-group"><summary>我的项目与合作邀请</summary>
  <div class="cp-row"><button id="cp-projects" type="button">查看我的云端项目</button>
  <button id="cp-invitations" type="button">查看合作邀请</button>
  <button id="cp-invitations-web" type="button">在 GitHub 接受邀请</button></div>
  <ul id="cp-project-list" aria-label="可访问的云端项目"></ul>
  <ul id="cp-invitation-list" aria-label="待接受的合作邀请"></ul></details>
  <section id="cp-connected" hidden><details class="cp-group"><summary>分享与邀请合作者</summary>
  <div class="cp-row"><button id="cp-share" type="button">获取分享链接</button>
  <label>分享链接（只读，可全选复制）<input id="cp-share-link" readonly></label></div>
  <div class="cp-row"><label>合作者 GitHub 用户名 <input id="cp-login" autocomplete="off"></label>
  <button id="cp-invite" type="button">发送合作邀请</button></div></details>
  <div class="cp-row"><label>本次写作说明 <input id="cp-summary" placeholder="保存写作进展" maxlength="500"></label>
  <button id="cp-sync" type="button">同步当前论文</button>
  <button id="cp-auto" type="button" aria-pressed="false">开启本次会话自动同步</button></div>
  <details class="cp-boundaries"><summary>自动同步与权限</summary><p class="cp-note">仅同步当前论文，每 30 秒检查一次；未保存草稿、冲突、忙碌或退出时跳过。失败后停止，需明确重新开启。链接不授予仓库权限，不提供实时协同编辑。</p></details></section>`

export class CloudProjectPanel {
  private initialized = false
  private disposed = false
  private closing = false
  private busy = false
  private epoch = 0
  private statusRequest = 0
  private refreshing = false
  private state: CloudWorkspaceStatus | null = null
  private stateProject: ProjectInfo | null = null
  private autoSession = false
  private createdUnlinked = new Set<ProjectInfo | null>()
  private timer: ReturnType<typeof setInterval> | null = null
  private cleanups: (() => void)[] = []

  constructor(private api: CloudApi | undefined, private documents: Documents, private dialogs: Dialogs,
    private run: RunAction, private adopt: (project: ProjectInfo) => Promise<void>, private notify: (message: string) => void) {
    element('cloud-project-workspace').innerHTML = TEMPLATE
    this.bind('refresh', () => this.refresh())
    this.bind('authorization', async () => { await this.api!.openAuthorization() })
    this.bind('invitations-web', async () => { await this.api!.openInvitations() })
    this.bind('projects', () => this.projects())
    this.bind('invitations', () => this.invitations())
    this.bind('create', () => this.create(), true)
    this.bind('join', () => this.receive(() => this.api!.joinProject(this.value('join-link'))), true)
    this.bind('share', () => this.share())
    this.bind('invite', () => this.invite(), true)
    this.bindSync(element<HTMLButtonElement>('cp-sync'))
    this.bindSync(element<HTMLButtonElement>('project-sync'))
    this.bind('auto', () => this.auto(), true)
    this.listen(element('cp-error-copy'), () => { void this.copyError() })
    this.listen(element('cp-error-dismiss'), () => { if (!this.closing && !this.disposed) this.clearError() })
    this.clearError()
    this.controls()
  }

  initialize(): void {
    if (this.initialized || this.disposed) return
    this.initialized = true
    if (!this.api) { text('cp-status', '当前桌面版本未接入云端项目桥接；仍可离线写作。'); return }
    void this.refresh()
    this.timer = setInterval(() => {
      if (this.canAuto()) this.dispatch('自动同步', () => this.sync(true), true)
    }, 30_000)
  }

  projectChanged(): void {
    if (this.disposed) return
    this.epoch += 1; this.statusRequest += 1
    this.state = null; this.stateProject = null; this.autoSession = false; this.refreshing = false
    element('cp-project-list').replaceChildren(); element('cp-invitation-list').replaceChildren()
    for (const id of ['share-link', 'summary', 'login']) element<HTMLInputElement>(`cp-${id}`).value = ''
    text('cp-status', ''); text('cp-message', ''); text('project-sync-status', '')
    this.clearError()
    this.controls()
  }

  setClosing(closing: boolean): void {
    if (this.closing === closing) return
    this.closing = closing; this.epoch += 1
    this.controls()
  }

  dispose(): void {
    this.disposed = true; this.epoch += 1
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.controls()
  }

  private ticket(): Ticket {
    return { project: this.documents.project, version: this.documents.buffer.editVersion, path: this.documents.buffer.path, epoch: this.epoch }
  }

  private valid(ticket: Ticket, edits = true): boolean {
    return !this.disposed && !this.closing && ticket.epoch === this.epoch && ticket.project === this.documents.project
      && (!edits || ticket.version === this.documents.buffer.editVersion && ticket.path === this.documents.buffer.path)
  }

  private bind(id: string, action: () => Promise<void>, mutation = false): void {
    const node = element<HTMLButtonElement>(`cp-${id}`)
    this.listen(node, () => { if (!node.disabled) this.dispatch('云端合作', action, mutation) })
  }

  private bindSync(node: HTMLButtonElement): void {
    this.listen(node, () => {
      if (!node.disabled && this.canSyncCurrent()) this.dispatch('同步当前论文', () => this.sync(false), true)
    })
  }

  private canSyncCurrent(): boolean {
    return !!this.api && !this.busy && !this.closing && !this.disposed && !this.refreshing
      && !!this.documents.project && this.stateProject === this.documents.project
      && !!this.state?.configured && this.state.signedIn && !!this.state.connection
  }

  private listen(node: HTMLElement, action: () => void): void {
    node.addEventListener('click', action)
    this.cleanups.push(() => node.removeEventListener('click', action))
  }

  private dispatch(label: string, action: () => Promise<void>, mutation = false): void {
    if (!this.api || this.disposed || this.closing || this.busy) return
    const ticket = this.ticket()
    this.run(label, async () => {
      if (!this.valid(ticket) || this.busy) return
      this.busy = true; this.controls()
      try {
        if (mutation && !await this.saved(ticket)) return
        if (this.valid(ticket)) await action()
      } catch (error) {
        if (this.valid(ticket)) this.failure(`操作未完成：${readableError(error)}`)
      } finally { this.busy = false; if (!this.disposed) this.controls() }
    }, true)
  }

  private async saved(ticket: Ticket): Promise<boolean> {
    if (this.documents.buffer.dirty && !await this.documents.save()) {
      if (this.valid(ticket)) this.message('保存未完成，未执行云端操作；编辑草稿已保留。')
      return false
    }
    if (this.valid(ticket) && this.documents.buffer.conflict) this.message('本地文件存在冲突，未执行云端操作；请先处理并保存草稿。')
    return this.valid(ticket) && !this.documents.buffer.dirty && !this.documents.buffer.conflict
  }

  private value(id: string): string { return element<HTMLInputElement>(`cp-${id}`).value.trim() }
  private message(message: string): void { text('cp-message', message); this.notify(message) }

  private failure(message: string): void {
    element<HTMLTextAreaElement>('cp-error-detail').value = message
    text('cp-error-copy-status', '')
    element('cp-error').hidden = false
    const summary = message.split('\n', 1)[0] ?? message
    this.message(summary.length > 180 ? summary.slice(0, 180) + '…' : summary)
    element('cp-error').focus()
  }

  private clearError(): void {
    element('cp-error').hidden = true
    element<HTMLTextAreaElement>('cp-error-detail').value = ''
    text('cp-error-copy-status', '')
  }

  private async copyError(): Promise<void> {
    const detail = element<HTMLTextAreaElement>('cp-error-detail'), value = detail.value, ticket = this.ticket()
    if (this.closing || this.disposed || element('cp-error').hidden || !value) return
    try {
      await navigator.clipboard.writeText(value)
      if (this.valid(ticket, false) && detail.value === value && !element('cp-error').hidden) text('cp-error-copy-status', '已复制详情')
    } catch {
      if (!this.valid(ticket, false) || detail.value !== value || element('cp-error').hidden) return
      detail.focus(); detail.select()
      text('cp-error-copy-status', '复制未完成，已选中全文，可手动复制。')
    }
  }

  async refresh(): Promise<void> {
    if (!this.api || this.disposed || this.closing) return
    const ticket = this.ticket(), request = ++this.statusRequest
    this.refreshing = true; this.controls()
    try {
      const state = await this.api.status()
      if (!this.valid(ticket) || request !== this.statusRequest) return
      const accountChanged = this.state?.account?.id !== state.account?.id || this.state?.signedIn !== state.signedIn
      if (accountChanged) this.epoch += 1
      if (accountChanged || this.stateProject !== ticket.project || !state.signedIn) {
        element('cp-project-list').replaceChildren(); element('cp-invitation-list').replaceChildren()
        element<HTMLInputElement>('cp-share-link').value = ''
      }
      this.state = state; this.stateProject = ticket.project
      if (!state.autoSync || !state.signedIn) this.autoSession = false
      text('cp-status', state.connection ? `${state.connection.owner}/${state.connection.name} · ${state.message}` : state.message)
    } catch {
      if (!this.valid(ticket) || request !== this.statusRequest) return
      this.state = null; this.stateProject = null; this.autoSession = false
      text('cp-status', '合作状态读取失败，请检查登录并手动刷新。')
    } finally {
      if (request === this.statusRequest) { this.refreshing = false; this.controls() }
    }
  }

  private controls(): void {
    const locked = !this.api || this.busy || this.closing || this.disposed
    const signedIn = this.state?.configured && this.state.signedIn
    const connected = signedIn && !!this.documents.project && this.stateProject === this.documents.project && !!this.state?.connection
    element('cp-connected').hidden = !connected
    for (const id of ['refresh', 'authorization', 'invitations-web', 'projects', 'invitations', 'create', 'join', 'share', 'invite', 'sync', 'auto']) {
      element<HTMLButtonElement>(`cp-${id}`).disabled = locked || (!['refresh', 'authorization', 'invitations-web'].includes(id) && !signedIn)
    }
    for (const id of ['share', 'invite', 'sync', 'auto']) element<HTMLButtonElement>(`cp-${id}`).disabled ||= !connected
    element<HTMLButtonElement>('cp-create').disabled ||= !this.documents.project || this.createdUnlinked.has(this.documents.project)
    for (const node of element('cloud-project-workspace').querySelectorAll<HTMLButtonElement>('[data-cp-choice]')) node.disabled = locked || !signedIn
    text('cp-auto', this.autoSession && this.state?.autoSync ? '停止本次会话自动同步' : '开启本次会话自动同步')
    element('cp-auto').setAttribute('aria-pressed', String(this.autoSession && !!this.state?.autoSync))
    for (const id of ['cp-error-copy', 'cp-error-dismiss']) element<HTMLButtonElement>(id).disabled = this.closing || this.disposed
    this.syncControls()
  }

  private syncControls(): void {
    const project = this.documents.project, node = element<HTMLButtonElement>('project-sync')
    const status = element('project-sync-status')
    node.hidden = !project; status.hidden = !project
    node.disabled = !this.canSyncCurrent()
    element<HTMLButtonElement>('cp-sync').disabled ||= node.disabled
    const label = this.canSyncCurrent() ? '同步当前论文' : !this.api ? '同步不可用'
      : this.busy ? '同步处理中…' : this.refreshing || !this.state || this.stateProject !== project ? '同步检查中…'
      : !this.state.signedIn ? '同步 · 请登录' : !this.state.connection ? '同步 · 未关联' : '同步暂不可用'
    text('project-sync', label)
    const reason = !this.api ? '同步不可用' : this.closing || this.disposed ? '暂不可同步'
      : this.busy ? '处理中…' : this.refreshing ? '读取同步状态…'
      : !this.state || this.stateProject !== project ? '同步状态待刷新'
      : !this.state.configured ? '登录未配置' : !this.state.signedIn ? '未登录'
      : !this.state.connection ? '未关联' : `${this.state.connection.owner}/${this.state.connection.name}`
    node.title = project ? `同步当前论文“${project.name}” · ${reason}` : '选择论文后同步'
    node.setAttribute('aria-label', project ? `同步当前论文 ${project.name}` : '同步当前论文')
    text('project-sync-status', project ? `${project.name} · ${reason}` : '')
    element<HTMLButtonElement>('cp-sync').title = node.title
    text('project-settings', this.state?.signedIn && !this.state.connection ? '关联仓库' : '项目设置')
  }

  private async create(): Promise<void> {
    if (!this.documents.project || this.createdUnlinked.has(this.documents.project)) return
    const name = this.value('name')
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) { this.message('请填写 ASCII 项目名称，例如 my-paper。'); return }
    const ticket = this.ticket()
    if (!await this.dialogs.confirm('创建私有合作项目？', '将为当前本地论文创建并关联私有 GitHub 项目，不会公开，也不会默默上传。之后点击“同步当前论文”或明确开启自动同步，才会交换可同步文件。')) return
    if (!this.valid(ticket)) return
    const result = await this.api!.createPrivateProject(name)
    if (!this.valid(ticket)) return
    if (!result.connected) this.createdUnlinked.add(ticket.project)
    await this.refresh()
    if (this.valid(ticket)) this.message(result.connected ? result.message : `${result.message} 请先安装或授权应用，再刷新项目列表并关联已创建的项目；不会自动重复创建。`)
  }

  private choice(label: string, action: () => Promise<void>, ticket: Ticket): HTMLButtonElement {
    const node = document.createElement('button')
    node.type = 'button'; node.textContent = label; node.dataset.cpChoice = 'true'
    this.listen(node, () => { if (!node.disabled && this.valid(ticket, false)) this.dispatch(label, action, true) })
    return node
  }

  private async projects(): Promise<void> {
    const ticket = this.ticket(), projects = await this.api!.projects()
    if (!this.valid(ticket)) return
    const list = element('cp-project-list')
    list.replaceChildren(...projects.map(choice => this.projectRow(choice, ticket)))
    if (!projects.length) list.append(listItem('暂无可访问项目，请检查应用授权。'))
  }

  private projectRow(choice: CloudProjectChoice, ticket: Ticket): HTMLLIElement {
    const row = listItem(`${choice.project.owner}/${choice.project.name}`, choice.project.private ? '私有项目' : '已有项目')
    row.append(this.choice('下载到本地', () => this.receive(() => this.api!.downloadProject(choice.handle)), ticket))
    if (ticket.project) row.append(this.choice('关联当前论文', async () => {
      const current = this.ticket()
      if (!await this.dialogs.confirm('关联当前论文？', '将当前本地论文关联到所选项目。之后需明确同步才会交换文件。')) return
      if (!this.valid(current)) return
      await this.api!.linkProject(choice.handle)
      if (this.valid(current)) { this.createdUnlinked.delete(current.project); await this.refresh() }
    }, ticket))
    return row
  }

  private async receive(request: () => Promise<ProjectInfo | null>): Promise<void> {
    const ticket = this.ticket(), project = await request()
    // A successful ProjectInfo acknowledges Main's commit; account/closing epochs cannot undo it.
    if (!project || this.disposed || ticket.project !== this.documents.project || ticket.version !== this.documents.buffer.editVersion
      || ticket.path !== this.documents.buffer.path || this.documents.buffer.dirty || this.documents.buffer.conflict) return
    this.autoSession = false
    await this.adopt(project) // Documents.adopt waits for the close handshake to become interactive.
    if (!this.disposed && !this.closing && this.documents.project === project) await this.refresh()
  }

  private async share(): Promise<void> {
    const ticket = this.ticket(), link = await this.api!.shareProject()
    if (!this.valid(ticket)) return
    const field = element<HTMLInputElement>('cp-share-link')
    field.value = link; field.focus(); field.select()
    this.message('分享链接已选中，可复制；接收者仍需获得项目权限并登录。')
  }

  private async invite(): Promise<void> {
    const login = this.value('login')
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) { this.message('请填写 GitHub 用户名，不是邮箱或密钥。'); return }
    const ticket = this.ticket(), result = await this.api!.inviteCollaborator(login)
    if (this.valid(ticket)) this.message(result.message)
  }

  private async invitations(): Promise<void> {
    const ticket = this.ticket(), invitations = await this.api!.invitations()
    if (!this.valid(ticket)) return
    element('cp-invitation-list').replaceChildren(...invitations.map(invitation => {
      const row = listItem(`${invitation.owner}/${invitation.name}`, `邀请人：${invitation.inviter}`)
      row.append(this.choice('接受邀请', async () => {
        const current = this.ticket()
        if (!await this.dialogs.confirm('接受合作邀请？', `加入 ${invitation.owner}/${invitation.name}；此操作不会立即下载文件。`)) return
        if (!this.valid(current)) return
        const result = await this.api!.acceptInvitation(invitation.handle)
        if (this.valid(current)) { this.message(result.message); await this.invitations() }
      }, ticket))
      return row
    }))
  }

  private canAuto(running = false): boolean {
    return this.autoSession && !!this.state?.autoSync && this.state.signedIn && !!this.state.connection
      && !!this.documents.project && this.stateProject === this.documents.project
      && !this.documents.buffer.dirty && !this.documents.buffer.conflict && !this.closing && !this.disposed && (running || !this.busy)
  }

  private async auto(): Promise<void> {
    const enabled = !this.autoSession, ticket = this.ticket()
    if (enabled && !await this.dialogs.confirm('开启本次会话自动同步？', '每 30 秒上传已保存的文件并检查云端更新；草稿或忙碌时跳过，失败后停止。')) return
    if (!this.valid(ticket)) return
    const state = await this.api!.setAutoSync(enabled)
    if (!this.valid(ticket)) return
    this.autoSession = enabled && state.autoSync; this.state = state; this.stateProject = ticket.project
    this.controls()
  }

  private async sync(background: boolean): Promise<void> {
    const ticket = this.ticket()
    if (!ticket.project) return
    try {
      await this.refresh()
      if (!this.valid(ticket) || this.stateProject !== ticket.project || !this.state?.configured
        || !this.state.signedIn || !this.state.connection || this.documents.buffer.dirty) return
      if (background && !this.canAuto(true)) return
      if (!background && !await this.dialogs.confirm('同步当前论文？', `将同步“${ticket.project.name}”的已保存文件并下载云端更新；遇到冲突时不会强制覆盖。`)) return
      if (!this.valid(ticket) || this.documents.buffer.dirty) return
      const result = await this.api!.sync(this.value('summary') || '保存写作进展', background)
      if (!this.valid(ticket)) return
      await this.documents.refresh([''])
      if (!this.valid(ticket, false)) return
      await this.refresh()
      if (this.valid(ticket, false)) this.message(result.message)
    } catch (error) {
      this.autoSession = false
      if (this.valid(ticket, false)) {
        await this.refresh()
        if (this.valid(ticket, false)) this.failure(`同步已停止：${readableError(error)}。请先核对远端状态，不要盲目重复操作。`)
      }
    }
  }
}
