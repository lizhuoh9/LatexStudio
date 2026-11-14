import type { ProjectInfo, RevisionDetail, RevisionEntry, WorkspaceApi } from '../shared/workspace-contracts'
import type { Dialogs } from './dialogs'
import type { Documents } from './documents'
import { button, element, text } from './dom'
import type { RunAction } from './sync-panel'
import { compareVersions, versionPreview } from './version-diff'

const KIND = { create: '创建', save: '保存修改', restore: '回退', external: '外部更改' }
const MAX_ENTRIES = 300

function author(entry: RevisionEntry): string {
  if (entry.kind === 'external') return '作者未知（无法溯源）'
  return entry.id.startsWith('git:') ? `提交作者：${entry.author}（非逐次编辑来源）` : `${entry.author}（OS 显示名，未经认证）`
}
function newestFirst(a: RevisionEntry, b: RevisionEntry): number {
  const left = Date.parse(a.date), right = Date.parse(b.date)
  if (Number.isFinite(left) && Number.isFinite(right)) return right - left
  return Number.isFinite(left) ? -1 : Number.isFinite(right) ? 1 : 0
}
function timestamp(date: string): string {
  const value = new Date(date)
  return Number.isFinite(value.getTime()) ? value.toLocaleString() : date || '时间未知'
}

export class VersionPanel {
  private detail: RevisionDetail | null = null
  private entries: RevisionEntry[] = []
  private project: ProjectInfo | null = null
  private epoch = 0
  private closing = false
  private selectedId = ''
  private buttons = new Map<string, HTMLButtonElement>()

  constructor(private api: WorkspaceApi, private documents: Documents, private dialogs: Dialogs,
    private run: RunAction, private notify: (message: string) => void) {
    button('revision-refresh', () => run('读取共享文件历史', () => this.refresh()))
    button('revision-restore', () => run('回退所选文件版本', () => this.restore(), true))
    api.onEvent((event) => {
      if (event.kind !== 'close-state' && event.kind !== 'close-request') return
      this.closing = event.kind === 'close-request' || event.closing
      this.epoch++
      this.clear(this.closing ? '正在关闭…' : '请选择版本。')
    })
  }

  /** Invalidates old reads/selections immediately; never fetches, writes or changes a draft. */
  projectChanged(): void {
    this.epoch++
    this.project = this.documents.project
    this.entries = []; this.buttons.clear()
    element('revision-list').replaceChildren()
    this.clear(this.project ? '请选择版本。' : '请先打开项目。')
  }

  private current(project: ProjectInfo | null, epoch: number): boolean {
    return !this.closing && !!project && project === this.documents.project && epoch === this.epoch
  }

  async refresh(): Promise<void> {
    if (this.closing) return
    const project = this.documents.project, epoch = ++this.epoch
    this.project = project
    this.entries = []; this.buttons.clear()
    this.clear(project ? '正在读取历史…' : '请先打开项目。')
    element('revision-list').replaceChildren()
    if (!project) return
    try {
      const entries = await this.api.revisions()
      if (!this.current(project, epoch)) return
      this.entries = entries.slice(0, MAX_ENTRIES).sort(newestFirst)
      this.renderEntries()
      text('revision-status', entries.length ? `${entries.length} 条文件版本${entries.length > MAX_ENTRIES ? '，仅显示前 300 条' : ''}` : '暂无文件版本')
    } catch (error) {
      if (this.current(project, epoch)) text('revision-status', '历史读取失败，请重试。')
      throw error
    }
  }

  private renderEntries(): void {
    this.buttons.clear()
    element('revision-list').replaceChildren(...this.entries.map(entry => this.row(entry)))
    this.selection()
  }

  private row(entry: RevisionEntry): HTMLLIElement {
    const row = document.createElement('li'), open = document.createElement('button')
    row.className = 'revision-event'; open.type = 'button'; open.className = 'revision-entry'; open.dataset.revisionId = entry.id
    open.title = `${entry.path} · ${KIND[entry.kind]} · ${author(entry)} · ${entry.date}\n${entry.summary}`
    open.setAttribute('aria-label', open.title)
    const metadata = document.createElement('span'), date = document.createElement('time'), who = document.createElement('span')
    metadata.className = 'revision-meta'; date.className = 'revision-time'; date.dateTime = entry.date
    date.textContent = timestamp(entry.date); date.title = entry.date
    who.className = 'revision-author'; who.textContent = entry.kind === 'external' ? '作者未知' : `${entry.id.startsWith('git:') ? '提交 · ' : ''}${entry.author}`
    who.title = author(entry); metadata.append(date, who)
    const changed = document.createElement('span'), path = document.createElement('span'), kind = document.createElement('span')
    changed.className = 'revision-file-row'; path.className = 'revision-path'; path.textContent = entry.path
    kind.className = 'revision-kind'; kind.textContent = KIND[entry.kind]; changed.append(path, kind)
    const summary = document.createElement('span'); summary.className = 'revision-summary'; summary.textContent = entry.summary; summary.hidden = !entry.summary
    open.append(metadata, changed, summary); row.append(open); this.buttons.set(entry.id, open)
    const project = this.project
    open.addEventListener('click', () => {
      if (this.closing || project !== this.documents.project || project !== this.project || !this.entries.includes(entry)) return
      this.run('读取版本差异', () => this.select(entry.id))
    })
    return row
  }

  private selection(): void {
    for (const [id, open] of this.buttons) {
      const selected = id === this.selectedId
      open.setAttribute('aria-current', selected ? 'true' : 'false')
      open.setAttribute('aria-pressed', String(selected)); open.disabled = this.closing
    }
  }

  private clear(message: string): void {
    this.detail = null; this.selectedId = ''; this.selection()
    text('revision-status', message)
    for (const id of ['revision-description', 'revision-before', 'revision-after', 'revision-diff', 'revision-diff-summary']) text(id, '')
    element<HTMLButtonElement>('revision-restore').disabled = true
    element<HTMLDetailsElement>('revision-full').open = false
    element('revision-diff').hidden = true
  }

  private async select(id: string): Promise<void> {
    if (this.closing || this.project !== this.documents.project) return
    const project = this.project, epoch = ++this.epoch
    this.clear('正在读取版本内容…')
    const entry = this.entries.find(value => value.id === id)
    if (!entry) { text('revision-status', '请先刷新并选择一个文件版本。'); return }
    this.selectedId = id; this.selection()
    try {
      const detail = await this.api.revisionDetail(id)
      if (!this.current(project, epoch)) return
      if (detail.entry.id !== id || detail.entry.path !== entry.path) throw new Error('返回的版本与所选文件不一致，请刷新后重试。')
      this.detail = detail
      this.renderDetail(detail)
    } catch (error) {
      if (this.current(project, epoch)) this.clear('版本读取失败；没有回退或覆盖任何文件。')
      throw error
    }
  }

  private renderDetail(detail: RevisionDetail): void {
    const { entry, before, after } = detail, diff = compareVersions(before, after)
    text('revision-description', `${entry.path} · ${KIND[entry.kind]} · ${author(entry)} · ${entry.date}\n${entry.summary}`)
    text('revision-before', versionPreview(before)); text('revision-after', versionPreview(after))
    text('revision-diff', diff.text); text('revision-diff-summary', diff.summary)
    element('revision-diff').hidden = !diff.text
    text('revision-status', before === null ? '初始记录' : '所选修改的差异片段')
    element<HTMLButtonElement>('revision-restore').disabled = false
  }

  private async saveDraft(project: ProjectInfo | null, epoch: number): Promise<boolean> {
    if (!this.documents.buffer.dirty) return true
    if (!await this.dialogs.confirm('先保存当前编辑草稿？', '回退前必须先保存当前草稿。取消会保留草稿且不回退；不会放弃未保存内容。')) return false
    if (!this.current(project, epoch) || !await this.documents.save()) return false
    if (this.documents.buffer.dirty) { this.notify('仍有未保存输入，已停止回退并保留草稿。'); return false }
    return true
  }

  private async restore(): Promise<void> {
    const detail = this.detail, project = this.project, epoch = this.epoch
    if (!detail || !this.current(project, epoch)) return
    if (!await this.saveDraft(project, epoch) || !this.current(project, epoch)) return
    const editVersion = this.documents.buffer.editVersion
    const current = await this.api.readFile(detail.entry.path)
    if (!this.current(project, epoch)) return
    const confirmed = await this.dialogs.confirm('仅回退此文件至所选版本？',
      `文件：${detail.entry.path}\n所选版本：${detail.entry.date}\n只替换此文件，不回退整个项目。回退会新增历史记录，旧版本仍保留。随后还需系统原生确认；文件若已变化，后端会拒绝覆盖。`)
    if (!confirmed || !this.current(project, epoch)) return
    if (editVersion !== this.documents.buffer.editVersion || this.documents.buffer.dirty) {
      this.notify('确认期间草稿发生变化，已停止回退并保留草稿。'); return
    }
    const restored = await this.api.restoreRevision(detail.entry.id, current.revision)
    if (!this.current(project, epoch)) return
    await this.documents.refresh([restored.path])
    if (!this.current(project, epoch)) return
    await this.refresh()
    this.notify(`已回退文件 ${restored.path}；其他文件未回退，旧历史仍保留。`)
  }
}
