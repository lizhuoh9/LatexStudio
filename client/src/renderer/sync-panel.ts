import type { GitHubSettings, ProjectInfo, RepositoryStatus, WorkspaceApi } from '../shared/workspace-contracts'
import { button, element, listItem, text } from './dom'
import type { Dialogs } from './dialogs'
import type { Documents } from './documents'
import { VersionPanel } from './version-panel'
import { HistoryMode } from './history-mode'

export type RunAction = (label: string, action: () => Promise<void>, freezeEditor?: boolean) => void

export class SyncPanel {
  private versions: VersionPanel
  private mode: HistoryMode
  private closing = false
  private refreshing: Promise<void> | null = null
  private refreshAgain = false
  private generation = 0

  constructor(private api: WorkspaceApi, private documents: Documents, private dialogs: Dialogs,
    private run: RunAction, private adopt: (project: ProjectInfo) => Promise<void>, private notify: (message: string) => void) {
    this.mode = new HistoryMode(() => this.closeHistory())
    this.versions = new VersionPanel(api, documents, dialogs, run, notify, () => this.closeHistory())
    button('history-back', () => this.closeHistory())
    button('cloud-open', () => this.open())
    button('revision-close', () => this.closeHistory())
    button('cloud-close', () => element<HTMLDialogElement>('cloud-dialog').close())
    button('cloud-connect', () => run('连接调试账号', () => this.connect()))
    button('cloud-clone', () => run('下载调试项目', () => this.clone(), true))
    button('cloud-disconnect', () => run('断开调试账号', () => this.disconnect()))
    button('cloud-refresh', () => run('读取本地历史', () => this.refresh()))
    button('cloud-sync', () => run('调试同步', () => this.sync()))
    button('cloud-snapshot', () => run('保存本地历史快照', () => this.snapshot()))
    element('developer-sync').addEventListener('toggle', () => {
      element<HTMLInputElement>('github-token').value = ''
      if (this.developerEnabled()) run('读取调试状态', () => this.refresh())
    })
  }

  private developerEnabled(): boolean { return element<HTMLDetailsElement>('developer-sync').open }

  private open(): void {
    if (this.closing) return
    if (!this.documents.project) return
    if (this.mode.active) { this.closeHistory(); return }
    this.mode.open()
    this.refreshVisible()
  }

  private closeHistory(): void {
    if (this.closing) return
    this.generation++
    this.versions.exit()
    this.mode.close()
  }

  projectChanged(): void {
    this.generation++
    this.mode.close(false)
    this.versions.projectChanged()
    element('history-list').replaceChildren()
    text('revision-context', this.documents.project?.name ?? '')
    this.refreshVisible()
  }

  setClosing(closing: boolean): void { this.closing = closing; this.mode.setClosing(closing) }

  dispose(): void { this.mode.dispose(); this.versions.dispose() }

  refreshVisible(): void {
    if (this.closing || element('revision-panel').hidden || !this.documents.project) return
    if (this.refreshing) { this.refreshAgain = true; return }
    this.refreshing = this.refresh().catch(() => undefined).finally(() => {
      this.refreshing = null
      if (this.refreshAgain) { this.refreshAgain = false; this.refreshVisible() }
    })
  }

  private takeSettings(): GitHubSettings {
    const token = element<HTMLInputElement>('github-token')
    const settings = { url: element<HTMLInputElement>('github-url').value.trim(), token: token.value }
    token.value = ''
    return settings
  }

  private async connect(): Promise<void> {
    if (!this.developerEnabled()) return
    if (!this.documents.project) { this.notify('请先打开本地项目，或在开发者区下载调试项目。'); return }
    try { await this.api.connectGitHub(this.takeSettings()) }
    catch { throw new Error('调试关联失败。请检查地址、权限或网络。密钥不会显示在日志中。') }
    this.notify('开发者关联配置已保存；普通图形协作登录仍未启用。')
    await this.refresh()
  }

  private async clone(): Promise<void> {
    if (!this.developerEnabled() || !await this.documents.mayLeave()) return
    let project: ProjectInfo | null
    try { project = await this.api.cloneProject(this.takeSettings()) }
    catch { throw new Error('调试下载失败。请检查地址、权限、网络与所选本地目录。') }
    if (!project) return
    await this.adopt(project)
    await this.refresh()
  }

  private async disconnect(): Promise<void> {
    if (!this.developerEnabled()) return
    if (!await this.dialogs.confirm('断开此项目的开发者关联？', '不会删除本地文件或云端项目。')) return
    await this.api.disconnectGitHub()
    element<HTMLInputElement>('github-token').value = ''
    await this.refresh()
  }

  async refresh(): Promise<void> {
    if (!this.documents.project || this.closing) return
    const project = this.documents.project, generation = this.generation
    let localLoaded = true
    try { await this.refreshHistory() } catch {
      localLoaded = false
      element('history-list').replaceChildren(listItem('本机 Git 快照读取失败，可重试。', '共享文件版本将独立读取，不会因此停用。'))
    }
    if (this.closing || project !== this.documents.project || generation !== this.generation) return
    try { await this.versions.refresh() } catch { /* The shared version panel displays its own retry/error state. */ }
    if (!this.developerEnabled()) return
    try { this.renderStatus(await this.api.repository()) }
    catch { text('cloud-status', localLoaded ? '开发者关联状态读取未完成；本地历史已单独加载。' : '开发者关联状态及本机 Git 快照读取未完成；共享文件版本状态见上方。') }
  }

  private async refreshHistory(): Promise<void> {
    const project = this.documents.project
    const history = await this.api.history()
    if (this.closing || project !== this.documents.project) return
    const list = element('history-list')
    list.replaceChildren(...history.map((entry) => listItem(entry.summary || '未命名快照', `${entry.author} · ${entry.date}`)))
    if (!history.length) list.append(listItem('还没有本地历史快照'))
  }

  private renderStatus(status: RepositoryStatus): void {
    const connection = status.connection
    text('cloud-account', connection ? `开发者关联 · ${connection.owner}/${connection.repository} · ${connection.login}` : '未关联开发者调试账号')
    if (connection) element<HTMLInputElement>('github-url').value = connection.url
    text('cloud-status', status.conflict ? '上次同步需要人工处理；重试仍由后端安全判断，不会强制覆盖。' : status.message)
    const names = { added: '新增', modified: '修改', deleted: '删除' }
    element('pending-list').replaceChildren(...status.changes.map((change) => listItem(change.path, names[change.kind])))
    if (!status.changes.length) element('pending-list').append(listItem('本地没有待上传修改；调试同步仍会检查云端更新。'))
  }

  private summary(): string { return element<HTMLInputElement>('snapshot-summary').value.trim() || '保存写作进展' }

  private async snapshot(): Promise<void> {
    if (!this.documents.project) { this.notify('请先打开或创建本地项目。'); return }
    if (!await this.documents.save()) return
    const entry = await this.api.snapshot(this.summary())
    this.notify(entry ? '已保存本地历史快照。' : '没有新的文件修改需要保存快照。')
    await this.refresh()
  }

  private async sync(): Promise<void> {
    if (!this.developerEnabled() || !await this.documents.save()) return
    const status = await this.api.repository()
    this.renderStatus(status)
    if (!status.connection) { this.notify('开发者调试尚未关联账号；普通登录仍未启用。'); return }
    if (this.documents.buffer.dirty) { this.notify('请先保存尚未写入文件的修改，再同步。'); return }
    // Persisted conflict is advisory: the backend alone re-checks safe history.
    const files = status.changes.map((change) => change.path).join('\n') || '本地没有待上传修改。'
    if (!await this.dialogs.confirm('确认同步这些本地文件？', `${files}\n\n将上传本地修改并检查下载云端更新。不是实时同步；存在冲突时不会强制覆盖。`)) return
    const result = await this.api.sync(this.summary())
    await this.documents.refresh([this.documents.buffer.path])
    this.notify(result.message)
    await this.refresh()
  }
}
