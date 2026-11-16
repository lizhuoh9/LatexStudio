import type { ProjectLibraryApi, ProjectLibraryEntry, ProjectLibraryState } from '../shared/project-library-contracts'
import type { ProjectInfo } from '../shared/workspace-contracts'
import type { Documents } from './documents'
import type { Dialogs } from './dialogs'
import type { RunAction } from './sync-panel'
import { element, text } from './dom'
import { readableError } from './editor-model'
import { intlLocale, translate } from '../shared/i18n'
import { localizeStaticHtml, uiText, uiAttribute, uiFormattedText, uiFormattedAttribute } from './i18n-dom'

type Ticket = { project: ProjectInfo | null; version: number; path: string; epoch: number }
const TEMPLATE = `<header class="pl-heading"><h2 id="project-library-heading">全部项目</h2><div class="pl-heading-actions">
  <input id="project-library-search" type="search" aria-label="搜索项目名称" placeholder="搜索项目" autocomplete="off" spellcheck="false">
  <button id="project-library-refresh" type="button" aria-label="刷新项目列表" title="刷新项目列表">刷新</button></div></header>
  <div class="pl-columns" aria-hidden="true"><span>项目名称</span><span>存储位置</span><span>最后修改</span><span></span></div>
  <ul id="project-library-list" aria-label="全部项目"></ul>
  <p id="project-library-status" role="status" aria-live="polite"></p>`

/** Dashboard of remembered local entrances; opening another paper remains a save-first transaction. */
export class ProjectLibraryPanel {
  private initialized = false
  private disposed = false
  private closing = false
  private busy = false
  private ready = false
  private query = ''
  private epoch = 0
  private request = 0
  private state: ProjectLibraryState = { projects: [], activeId: null }
  private unsubscribe: (() => void) | null = null
  private rowCleanups: (() => void)[] = []
  private readonly refreshClick = (): void => { if (!this.closing && !this.busy) void this.refresh() }
  private readonly searchInput = (): void => {
    if (this.disposed || this.closing || this.busy) return
    this.query = element<HTMLInputElement>('project-library-search').value
    this.render()
  }

  constructor(private api: ProjectLibraryApi | undefined, private documents: Documents, private dialogs: Dialogs,
    private run: RunAction, private adopt: (project: ProjectInfo) => Promise<void>, private notify: (message: string) => void,
    private resume: () => void = () => undefined) {
    element('project-library').innerHTML = TEMPLATE
    localizeStaticHtml(element('project-library'))
    element('project-library-refresh').addEventListener('click', this.refreshClick)
    element('project-library-search').addEventListener('input', this.searchInput)
    this.render()
  }

  initialize(): void {
    if (this.initialized || this.disposed) return
    this.initialized = true
    if (!this.api) { this.status('此版本未接入项目列表，仍可通过打开或新建项目写作。'); return }
    this.unsubscribe = this.api.onChanged(() => { void this.refresh() })
    void this.refresh()
  }

  async refresh(): Promise<void> {
    if (!this.api || this.disposed || this.closing) return
    const request = ++this.request, epoch = this.epoch, project = this.documents.project
    try {
      const state = await this.api.list()
      if (this.disposed || this.closing || request !== this.request || epoch !== this.epoch || project !== this.documents.project) return
      this.state = state; this.ready = true
      this.status(state.projects.length ? '' : '通过“打开项目”或“新建项目”添加论文。')
    } catch (error) {
      if (this.disposed || this.closing || request !== this.request || epoch !== this.epoch || project !== this.documents.project) return
      this.ready = false
      this.status(`项目列表读取失败：${readableError(error)} 请刷新重试；硬盘文件未改变。`)
    }
    this.render()
  }

  setClosing(closing: boolean): void {
    if (this.closing === closing || this.disposed) return
    this.closing = closing; this.epoch += 1
    this.render()
    if (!closing && this.initialized) void this.refresh()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.epoch += 1
    this.unsubscribe?.(); this.unsubscribe = null
    element('project-library-refresh').removeEventListener('click', this.refreshClick)
    element('project-library-search').removeEventListener('input', this.searchInput)
    this.clearRows()
  }

  private ticket(): Ticket {
    return { project: this.documents.project, version: this.documents.buffer.editVersion, path: this.documents.buffer.path, epoch: this.epoch }
  }

  private unchanged(ticket: Ticket): boolean {
    return !this.disposed && ticket.project === this.documents.project && ticket.version === this.documents.buffer.editVersion
      && ticket.path === this.documents.buffer.path
  }

  private fresh(ticket: Ticket): boolean { return this.unchanged(ticket) && !this.closing && ticket.epoch === this.epoch }

  private dispatch(label: string, action: (ticket: Ticket) => Promise<void>): void {
    if (!this.api || this.disposed || this.closing || this.busy || !this.ready) return
    const ticket = this.ticket()
    this.run(label, async () => {
      if (!this.fresh(ticket) || this.busy) return
      this.busy = true; this.render()
      try { await action(ticket) } catch (error) {
        if (this.unchanged(ticket)) this.message(`操作未完成：${readableError(error)}。当前草稿已保留，请检查目录权限后重试。`)
      } finally { this.busy = false; if (!this.disposed) this.render() }
    }, true)
  }

  private async activate(id: string, ticket: Ticket): Promise<void> {
    const selected = this.state.projects.find(entry => entry.id === id)
    if (!selected) return
    if (selected.root === this.documents.project?.root) { this.resumeActive(selected); return }
    if (!await this.documents.save()) {
      if (this.fresh(ticket)) this.message('保存未完成，未切换项目；请先处理冲突或保存草稿。')
      return
    }
    if (!this.fresh(ticket) || this.documents.buffer.dirty || this.documents.buffer.conflict) return
    const project = await this.api!.activate(id)
    // Main has committed a successful ProjectInfo. A canceled close alone must not hide that commit.
    if (!project || !this.unchanged(ticket) || this.documents.buffer.dirty || this.documents.buffer.conflict) return
    await this.adopt(project) // Documents.adopt waits for the closing handshake to resume interaction.
    if (!this.disposed && !this.closing && this.documents.project === project) await this.refresh()
  }

  private resumeActive(entry: ProjectLibraryEntry): void {
    if (this.disposed || this.closing || this.busy || !this.documents.project || entry.root !== this.documents.project.root) return
    this.resume()
  }

  private async forget(entry: ProjectLibraryEntry, ticket: Ticket): Promise<void> {
    if (entry.id === this.state.activeId || entry.root === this.documents.project?.root || !this.state.projects.some(item => item.id === entry.id)) return
    if (!await this.dialogs.confirm('从项目列表移出？', `仅移出“${entry.name}”的本机入口，不会删除硬盘目录、论文文件或历史记录。之后可通过“打开项目”重新添加。`)) return
    if (!this.fresh(ticket) || entry.id === this.state.activeId || entry.root === this.documents.project?.root) return
    await this.api!.forget(entry.id)
    if (!this.disposed) await this.refresh()
  }

  private status(message: string): void { text('project-library-status', message); element('project-library-status').hidden = !message }
  private message(message: string): void { this.status(message); this.notify(message) }
  private clearRows(): void { for (const cleanup of this.rowCleanups.splice(0)) cleanup() }

  private listen(node: HTMLButtonElement, action: () => void): void {
    node.addEventListener('click', action)
    this.rowCleanups.push(() => node.removeEventListener('click', action))
  }

  private render(): void {
    this.clearRows()
    const locked = !this.api || !this.ready || this.busy || this.closing || this.disposed
    element<HTMLButtonElement>('project-library-refresh').disabled = !this.api || this.busy || this.closing || this.disposed
    const search = element<HTMLInputElement>('project-library-search')
    search.disabled = this.busy || this.closing || this.disposed; search.value = this.query
    const query = this.query.trim().toLocaleLowerCase()
    const projects = this.state.projects.filter(entry => entry.name.toLocaleLowerCase().includes(query))
    const list = element('project-library-list')
    list.replaceChildren(...projects.map(entry => this.row(entry, locked)))
    if (this.ready && !projects.length) {
      const empty = document.createElement('li'); empty.className = 'pl-empty'
      uiText(empty, this.state.projects.length ? '没有匹配的项目' : '尚无项目')
      list.append(empty)
    }
  }

  private modifiedAt(entry: ProjectLibraryEntry): HTMLTimeElement {
    const node = document.createElement('time'), value = entry.lastModifiedAt
    const date = typeof value === 'string' ? new Date(value) : null
    const valid = !!date && Number.isFinite(date.getTime()) && date.toISOString() === value
    node.className = 'pl-modified'; node.dateTime = valid ? value! : ''
    uiFormattedText(node, () => valid ? date!.toLocaleString(intlLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : translate('未知'))
    const opened = new Date(entry.lastOpenedAt), openedValid = Number.isFinite(opened.getTime()) && opened.toISOString() === entry.lastOpenedAt
    uiFormattedAttribute(node, 'title', () => `${translate(valid ? `最后修改：${value}` : '最后修改时间未知')}\n${translate(openedValid ? `最近打开：${entry.lastOpenedAt}` : '最近打开时间未知')}`)
    return node
  }

  private row(entry: ProjectLibraryEntry, locked: boolean): HTMLLIElement {
    const active = entry.root === this.documents.project?.root, row = document.createElement('li')
    row.className = active ? 'pl-project is-active' : 'pl-project'
    const open = document.createElement('button'), name = document.createElement('span')
    open.type = 'button'; open.className = 'pl-open'; open.title = entry.root
    open.disabled = active ? this.busy || this.closing || this.disposed || !this.documents.project : locked
    open.setAttribute('aria-current', String(active))
    name.className = 'pl-name'; name.textContent = entry.name
    const badge = document.createElement('span')
    badge.className = 'pl-badge'; uiText(badge, entry.syncIssue ? '关联异常' : entry.github ? 'GitHub' : '本地')
    uiAttribute(badge, 'title', entry.syncIssue ? '此项目关联状态读取异常，请打开后检查项目设置' : entry.github ? `${entry.github.owner}/${entry.github.name}` : '此项目仅在本地')
    const modified = this.modifiedAt(entry)
    uiFormattedAttribute(open, 'aria-label', () => `${entry.name}${translate(active ? '（当前项目，继续编辑）' : '，切换到此项目')} · ${badge.textContent} · ${modified.title}`)
    open.append(name, badge, modified)
    this.listen(open, () => {
      if (open.disabled) return
      if (entry.root === this.documents.project?.root) this.resumeActive(entry)
      else this.dispatch('切换本地项目', ticket => this.activate(entry.id, ticket))
    })
    const forget = document.createElement('button')
    forget.type = 'button'; forget.className = 'pl-forget'; forget.textContent = '×'; forget.disabled = locked || active || entry.id === this.state.activeId
    uiAttribute(forget, 'title', active ? '当前项目不能移出列表' : '移出列表，不删除硬盘文件')
    uiAttribute(forget, 'aria-label', `从列表移出 ${entry.name}，不删除文件`)
    this.listen(forget, () => { if (!forget.disabled) this.dispatch('移出项目入口', ticket => this.forget(entry, ticket)) })
    row.append(open, forget)
    return row
  }
}
