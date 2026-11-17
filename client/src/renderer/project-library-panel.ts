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
export interface CloudPaper { owner: string; name: string }
/** Public metadata of the signed-in account's private cloud projects. No handle, token or local path crosses here. */
export interface CloudPapers {
  signedIn(): boolean
  /** True only while the home page itself is showing; the list is never read behind the editor or a dialog. */
  visible(): boolean
  /** Resolves null when the read could not start because another action is running; it is retried when idle. */
  list(): Promise<CloudPaper[] | null>
  /** Explicit per-paper request; the ordinary guarded download asks for an empty folder. */
  download(paper: CloudPaper): void
}
type CloudState = { phase: 'idle' | 'loading' | 'ready' | 'error'; papers: CloudPaper[]; error: string }
const NO_CLOUD: CloudState = Object.freeze({ phase: 'idle', papers: [], error: '' })
const paperKey = (owner: string, name: string): string => `${owner}/${name}`.toLowerCase()
const TEMPLATE = `<header class="pl-heading"><h2 id="project-library-heading">全部项目</h2><div class="pl-heading-actions">
  <input id="project-library-search" type="search" aria-label="搜索项目名称" placeholder="搜索项目" autocomplete="off" spellcheck="false">
  <button id="project-library-refresh" type="button" aria-label="刷新项目列表" title="刷新项目列表">刷新</button></div></header>
  <p id="project-library-cloud" role="status" aria-live="polite" hidden></p>
  <div class="pl-columns" aria-hidden="true"><div class="pl-columns-main"><span>项目名称</span><span>存储位置</span><span>最后修改</span></div><span>操作</span></div>
  <ul id="project-library-list" aria-label="全部项目"></ul>
  <p id="project-library-status" role="status" aria-live="polite"></p>`

/** Dashboard of remembered local entrances; opening another paper remains a save-first transaction.
 * With a signed-in account it also shows which papers exist only in the cloud; downloading one stays an explicit click.
 */
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
  private cloudState: CloudState = NO_CLOUD
  private cloudRequest = 0
  private unsubscribe: (() => void) | null = null
  private rowCleanups: (() => void)[] = []
  private readonly refreshClick = (): void => { if (!this.closing && !this.busy) void this.refresh(true) }
  private readonly searchInput = (): void => {
    if (this.disposed || this.closing || this.busy) return
    this.query = element<HTMLInputElement>('project-library-search').value
    this.render()
  }

  constructor(private api: ProjectLibraryApi | undefined, private documents: Documents, private dialogs: Dialogs,
    private run: RunAction, private adopt: (project: ProjectInfo) => Promise<void>, private notify: (message: string) => void,
    private resume: () => void = () => undefined, private cloud?: CloudPapers) {
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
    this.resumeCloud()
  }

  /** `cloud`: also re-read the account's cloud papers (the explicit refresh button). File notifications never do. */
  async refresh(cloud = false): Promise<void> {
    if (cloud) void this.refreshCloud()
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

  /** Login, logout or account switch: forget the previous account's papers, then read the new account's list. */
  accountChanged(): void {
    if (this.disposed) return
    this.cloudRequest += 1; this.cloudState = NO_CLOUD
    this.render()
    void this.refreshCloud()
  }

  /** The home page became usable (shown, a dialog closed, an action finished): read this account's list if it was
   * never read. A list that was read, or failed, is only read again by the refresh button or an account change.
   */
  resumeCloud(): void {
    if (!this.disposed && this.cloud?.signedIn() && this.cloudState.phase === 'idle') void this.refreshCloud()
  }

  private async refreshCloud(): Promise<void> {
    const cloud = this.cloud
    if (!cloud || this.disposed || this.closing) return
    if (!cloud.signedIn()) { this.cloudRequest += 1; this.cloudState = NO_CLOUD; this.render(); return }
    if (!cloud.visible() || this.cloudState.phase === 'loading') return // never overlap two reads of the same list
    const request = ++this.cloudRequest, previous = this.cloudState.papers
    this.cloudState = { phase: 'loading', papers: previous, error: '' }; this.render()
    try {
      const papers = await cloud.list()
      if (this.disposed || request !== this.cloudRequest) return
      if (!cloud.signedIn()) this.cloudState = NO_CLOUD
      else if (!papers) this.cloudState = { phase: previous.length ? 'ready' : 'idle', papers: previous, error: '' } // could not start now
      else {
        const unique = new Map(papers.map(paper => [paperKey(paper.owner, paper.name), { owner: paper.owner, name: paper.name }]))
        this.cloudState = { phase: 'ready', papers: [...unique.values()], error: '' }
      }
    } catch (error) {
      if (this.disposed || request !== this.cloudRequest) return
      this.cloudState = { phase: 'error', papers: [], error: readableError(error) }
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
    const cloudOnly = this.cloudOnly(), papers = cloudOnly.filter(paper => paperKey(paper.owner, paper.name).includes(query))
    const list = element('project-library-list')
    list.replaceChildren(...projects.map(entry => this.row(entry, locked)), ...papers.map(paper => this.cloudRow(paper, locked)))
    if (this.ready && !projects.length && !papers.length) {
      const empty = document.createElement('li'); empty.className = 'pl-empty'
      uiText(empty, this.state.projects.length || cloudOnly.length ? '没有匹配的项目' : '尚无项目')
      list.append(empty)
    }
    this.renderCloudSummary(cloudOnly.length)
  }

  /** Cloud papers that no remembered local project is linked to. */
  private cloudOnly(): CloudPaper[] {
    if (!this.cloud?.signedIn()) return []
    const linked = new Set(this.state.projects.flatMap(entry => entry.github ? [paperKey(entry.github.owner, entry.github.name)] : []))
    return this.cloudState.papers.filter(paper => !linked.has(paperKey(paper.owner, paper.name)))
  }

  /** What can be said about one local project without guessing: "can sync" only when this account's list contains it. */
  private syncNote(entry: ProjectLibraryEntry): string {
    if (entry.syncIssue) return '需检查关联'
    if (!entry.github) return '未上传到云端'
    if (!this.cloud?.signedIn() || this.cloudState.phase !== 'ready') return '已关联云端'
    return this.inAccount(entry) ? '可同步' : '当前账号不可同步'
  }
  private inAccount(entry: ProjectLibraryEntry): boolean {
    const key = entry.github ? paperKey(entry.github.owner, entry.github.name) : ''
    return !!key && !entry.syncIssue && this.cloudState.papers.some(paper => paperKey(paper.owner, paper.name) === key)
  }

  private renderCloudSummary(cloudOnly: number): void {
    const cloud = this.cloud, node = element('project-library-cloud'), failure = this.cloudState.error
    let message = ''
    if (cloud && !this.disposed) {
      const local = this.state.projects.length, linked = this.state.projects.filter(entry => this.inAccount(entry)).length
      if (!cloud.signedIn()) message = '登录 GitHub 后，这里会同时显示你在云端的论文。'
      else if (this.cloudState.phase === 'loading') message = '正在读取云端论文…'
      else if (this.cloudState.phase === 'error') message = '云端论文读取失败：'
      else if (this.cloudState.phase === 'ready') message = `本机 ${local} 篇，其中 ${linked} 篇已关联云端、可同步；另有 ${cloudOnly} 篇只在云端，可下载到本地。`
    }
    // The failure reason is an application message of its own, so it is translated separately from the fixed frame.
    if (cloud && !this.disposed && cloud.signedIn() && this.cloudState.phase === 'error')
      uiFormattedText(node, () => `${translate('云端论文读取失败：')}${translate(failure)} ${translate('本地项目不受影响，可点“刷新”重试。')}`)
    else text('project-library-cloud', message)
    node.hidden = !message
  }

  private cloudRow(paper: CloudPaper, locked: boolean): HTMLLIElement {
    const row = document.createElement('li'), cell = document.createElement('div'), name = document.createElement('span')
    const badge = document.createElement('span'), download = document.createElement('button'), note = document.createElement('small')
    const modified = document.createElement('span')
    row.className = 'pl-project is-cloud'; cell.className = 'pl-open pl-cloud'
    name.className = 'pl-name'; name.textContent = `${paper.owner}/${paper.name}`
    badge.className = 'pl-badge'; badge.setAttribute('data-kind', 'cloud'); uiText(badge, '云端')
    uiAttribute(badge, 'title', '此项目只在云端，尚未下载到这台电脑')
    // Same four cells as a local row. A cloud-only paper has no local files, so its modified time is not known here.
    modified.className = 'pl-modified'; modified.textContent = '—'; modified.setAttribute('aria-hidden', 'true')
    download.type = 'button'; download.className = 'pl-download'; uiText(download, '下载'); uiAttribute(download, 'title', '下载到本地')
    uiAttribute(download, 'aria-label', `下载 ${paper.owner}/${paper.name} 到本地`)
    download.disabled = locked || !this.cloud?.signedIn()
    // A local project whose link could not be read may be this very paper: say so instead of claiming it is absent.
    note.className = 'pl-note'; uiText(note, this.state.projects.some(entry => entry.syncIssue) ? '可能已在本机' : '尚未下载')
    this.listen(download, () => { if (!download.disabled && !this.disposed && !this.closing) this.cloud?.download(paper) })
    cell.append(name, badge, modified, note)
    row.append(cell, download) // the action column, where a local row has its remove button
    return row
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
    badge.className = 'pl-badge'
    badge.setAttribute('data-kind', entry.syncIssue ? 'issue' : entry.github ? 'github' : 'local')
    uiText(badge, entry.syncIssue ? '关联异常' : entry.github ? 'GitHub' : '本地')
    uiAttribute(badge, 'title', entry.syncIssue ? '此项目关联状态读取异常，请打开后检查项目设置' : entry.github ? `${entry.github.owner}/${entry.github.name}` : '此项目仅在本地')
    const modified = this.modifiedAt(entry)
    const note = document.createElement('small')
    note.className = 'pl-note'; uiText(note, this.syncNote(entry))
    uiFormattedAttribute(open, 'aria-label', () => `${entry.name}${translate(active ? '（当前项目，继续编辑）' : '，切换到此项目')} · ${badge.textContent} · ${note.textContent} · ${modified.title}`)
    open.append(name, badge, modified, note)
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
