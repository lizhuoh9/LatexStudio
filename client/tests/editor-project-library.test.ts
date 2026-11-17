/// <reference lib="dom" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ProjectLibraryApi, ProjectLibraryState } from '../src/shared/project-library-contracts'
import type { ProjectInfo, WorkspaceApi } from '../src/shared/workspace-contracts'
import { Documents } from '../src/renderer/documents'
import type { Dialogs } from '../src/renderer/dialogs'
import type { RunAction } from '../src/renderer/sync-panel'
import { ProjectLibraryPanel, type CloudPapers } from '../src/renderer/project-library-panel'
import { setLocale, translate } from '../src/shared/i18n'

class NodeMock {
  id = ''; className = ''; textContent = ''; title = ''; type = ''; value = ''; dateTime = ''; disabled = false; hidden = false; markup = ''
  children: NodeMock[] = []; attributes = new Map<string, string>(); handlers = new Set<() => void>()
  classList = {
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
    toggle: (name: string, force: boolean): boolean => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean))
      if (force) classes.add(name); else classes.delete(name)
      this.className = [...classes].join(' '); return force
    }
  }
  set innerHTML(markup: string) {
    this.markup = markup
    for (const match of markup.matchAll(/\bid="([^"]+)"/g)) this.children.push(get(match[1]!))
  }
  get innerHTML(): string { return this.markup }
  append(...nodes: NodeMock[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: NodeMock[]): void { this.children = nodes }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === 'title') this.title = value }
  addEventListener(_type: string, handler: () => void): void { this.handlers.add(handler) }
  removeEventListener(_type: string, handler: () => void): void { this.handlers.delete(handler) }
  click(): void { if (!this.disabled) for (const handler of this.handlers) handler() }
  input(value: string): void { this.value = value; if (!this.disabled) for (const handler of this.handlers) handler() }
}
const nodes = new Map<string, NodeMock>()
function get(id: string): NodeMock {
  if (!nodes.has(id)) { const node = new NodeMock(); node.id = id; nodes.set(id, node) }
  return nodes.get(id)!
}
const project = (id: string): ProjectInfo => ({ id, name: `Paper ${id}`, root: `/fixture/${id}`, files: [], defaultMain: null })
const entry = (id: string) => ({ id, name: `Paper ${id}`, root: `/fixture/${id}`, lastOpenedAt: '2026-11-13T00:00:00.000Z' })
let state: ProjectLibraryState
let api: ProjectLibraryApi
let documents: Documents
let dialogs: Dialogs
let adopt: (project: ProjectInfo) => Promise<void>
let notify: (message: string) => void
let resume: () => void
let run: RunAction
let tasks: Promise<void>[]
let workbenchBusy: boolean
let changed: (() => void) | null
let unsubscribe: () => void
const panels: ProjectLibraryPanel[] = []
beforeEach(() => {
  nodes.clear(); tasks = []; workbenchBusy = false; changed = null; unsubscribe = vi.fn()
  vi.stubGlobal('document', { getElementById: get, createElement: () => new NodeMock() })
  state = { projects: [entry('a'), entry('b')], activeId: 'a' }
  api = { list: vi.fn(async () => state), activate: vi.fn(async id => { state = { ...state, activeId: id }; return project(id) }),
    forget: vi.fn(async id => { state = { ...state, projects: state.projects.filter(item => item.id !== id) }; return state }),
    onChanged: vi.fn(listener => { changed = listener; return unsubscribe }) }
  documents = { project: project('a'), buffer: { path: 'main.tex', editVersion: 1, dirty: false, conflict: false },
    save: vi.fn().mockResolvedValue(true) } as unknown as Documents
  dialogs = { confirm: vi.fn().mockResolvedValue(true) } as unknown as Dialogs
  adopt = vi.fn(async next => { documents.project = next; documents.buffer.editVersion += 1 })
  notify = vi.fn(); resume = vi.fn(); run = vi.fn((_label, action) => { if (!workbenchBusy) tasks.push(action()) })
})
afterEach(() => { for (const panel of panels.splice(0)) panel.dispose(); vi.unstubAllGlobals() })
function make(bridge: ProjectLibraryApi | null = api): ProjectLibraryPanel {
  const panel = new ProjectLibraryPanel(bridge ?? undefined, documents, dialogs, run, adopt, notify, resume)
  panels.push(panel); panel.initialize(); return panel
}
async function flush(): Promise<void> { for (let i = 0; i < 15; i += 1) await Promise.resolve() }
async function settle(): Promise<void> { await flush(); await Promise.all(tasks.splice(0)) }
function button(name: string, index = 0): NodeMock {
  const row = get('project-library-list').children.find(item => item.children[0]?.children[0]?.textContent === name)
  if (!row?.children[index]) throw new Error(`Missing project row: ${name}`)
  return row.children[index]!
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: value => resolve(value) }
}

it('never resumes a different buffer because the library active id is stale', async () => {
  make(); await settle(); documents.project = project('b')
  button('Paper a').click(); await settle()
  expect(resume).not.toHaveBeenCalled(); expect(documents.save).toHaveBeenCalledOnce()
  expect(api.activate).toHaveBeenCalledWith('a'); expect(documents.project?.root).toBe('/fixture/a')
})
it('resumes the actual current project even while the displayed active id is stale', async () => {
  documents.project = project('b'); const panel = make(); await settle()
  await panel.refresh(); button('Paper b').click(); await settle()
  expect(resume).toHaveBeenCalledOnce(); expect(documents.save).not.toHaveBeenCalled(); expect(api.activate).not.toHaveBeenCalled()
  expect(button('Paper b', 1).disabled).toBe(true)
})
it('feature detects a missing bridge without replacing existing project controls', async () => {
  make(null); await settle(); expect(get('project-library-status').textContent).toContain('未接入')
  expect(api.list).not.toHaveBeenCalled(); expect(get('project-library-refresh').disabled).toBe(true)
  expect(get('project-open').handlers.size).toBe(0); expect(get('project-create').handlers.size).toBe(0)
})
it('initializes once, lists remembered entrances and never auto opens or creates a project', async () => {
  const panel = make(); panel.initialize(); await settle()
  expect(api.list).toHaveBeenCalledOnce(); expect(api.onChanged).toHaveBeenCalledOnce(); expect(api.activate).not.toHaveBeenCalled()
  expect(adopt).not.toHaveBeenCalled(); expect(get('project-library-list').children).toHaveLength(2)
})
it('renders active project, full path tooltip and explicit non-destructive removal labels', async () => {
  make(); await settle(); const active = button('Paper a'), other = button('Paper b')
  expect(active.attributes.get('aria-current')).toBe('true'); expect(active.disabled).toBe(false)
  expect(other.title).toBe('/fixture/b'); expect(button('Paper a', 1).disabled).toBe(true)
  expect(button('Paper b', 1).title).toContain('不删除'); expect(other.attributes.get('aria-label')).toContain('切换')
})
it('shows an empty library without automatically reopening an old paper', async () => {
  state = { projects: [], activeId: null }; make(); await settle()
  expect(get('project-library-status').textContent).toContain('添加论文'); expect(get('project-library-status').hidden).toBe(false)
  expect(api.activate).not.toHaveBeenCalled()
})
it('omits the persistent normal notice while retaining removal tooltips and confirmation', async () => {
  const panel = make(); await settle()
  expect(get('project-library-status').textContent).toBe(''); expect(get('project-library-status').hidden).toBe(true)
  expect(button('Paper b', 1).title).toContain('不删除')
  await panel.refresh()
  expect(get('project-library-status').hidden).toBe(true)
})
it('keeps actual list errors visible and clears their space after a successful retry', async () => {
  const panel = make(); await settle(); vi.mocked(api.list).mockRejectedValueOnce(new Error('read failure'))
  await panel.refresh(); expect(get('project-library-status').hidden).toBe(false)
  await panel.refresh(); expect(get('project-library-status').textContent).toBe('')
  expect(get('project-library-status').hidden).toBe(true)
})
it('saves first, activates only an opaque id and adopts the committed result', async () => {
  make(); await settle(); button('Paper b').click(); await settle()
  expect(documents.save).toHaveBeenCalledOnce(); expect(api.activate).toHaveBeenCalledExactlyOnceWith('b')
  expect(vi.mocked(documents.save).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.activate).mock.invocationCallOrder[0]!)
  expect(adopt).toHaveBeenCalledOnce(); expect(documents.project?.id).toBe('b')
  expect(button('Paper b').attributes.get('aria-current')).toBe('true')
  expect(vi.mocked(run).mock.calls[0]?.[2]).toBe(true)
})
it('stops when saving fails and never asks to discard a dirty draft', async () => {
  make(); await settle(); Object.assign(documents.buffer, { dirty: true }); vi.mocked(documents.save).mockResolvedValue(false)
  button('Paper b').click(); await settle(); expect(api.activate).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled()
  expect(dialogs.confirm).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledWith(expect.stringContaining('保存未完成'))
})
it('allows switching after a dirty draft was saved without advancing the edit version', async () => {
  make(); await settle(); Object.assign(documents.buffer, { dirty: true })
  vi.mocked(documents.save).mockImplementation(async () => { Object.assign(documents.buffer, { dirty: false }); return true })
  button('Paper b').click(); await settle(); expect(api.activate).toHaveBeenCalledOnce()
})
it('rejects save success that leaves newer dirty edits or a conflict', async () => {
  make(); await settle(); Object.assign(documents.buffer, { dirty: true }); button('Paper b').click(); await settle()
  expect(api.activate).not.toHaveBeenCalled(); Object.assign(documents.buffer, { dirty: false, conflict: true })
  button('Paper b').click(); await settle(); expect(api.activate).not.toHaveBeenCalled()
})
it('does not activate after edits or a project switch occurred during saving', async () => {
  const pending = deferred<boolean>(); vi.mocked(documents.save).mockReturnValue(pending.promise)
  make(); await settle(); button('Paper b').click(); await flush(); expect(documents.save).toHaveBeenCalledOnce()
  documents.buffer.editVersion += 1; documents.project = project('other'); pending.resolve(true); await settle()
  expect(api.activate).not.toHaveBeenCalled()
})
it('preserves the draft and reports a rejected save or missing-directory activation', async () => {
  make(); await settle(); vi.mocked(documents.save).mockRejectedValueOnce(new Error('本地保存失败'))
  button('Paper b').click(); await settle(); expect(api.activate).not.toHaveBeenCalled()
  vi.mocked(api.activate).mockRejectedValue(new Error('目录已移除'))
  button('Paper b').click(); await settle(); expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('目录已移除'))
  expect(documents.project?.id).toBe('a')
})
it('leaves the current document unchanged after a canceled activation', async () => {
  vi.mocked(api.activate).mockResolvedValue(null); make(); await settle(); button('Paper b').click(); await settle()
  expect(adopt).not.toHaveBeenCalled(); expect(documents.project?.id).toBe('a')
})
it('does not overlap activations and does not stick busy when Workbench skips an action', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.activate).mockReturnValue(pending.promise)
  make(); await settle(); workbenchBusy = true; button('Paper b').click(); await flush()
  expect(api.activate).not.toHaveBeenCalled(); workbenchBusy = false; button('Paper b').click(); await flush()
  expect(api.activate).toHaveBeenCalledOnce(); expect(button('Paper b').disabled).toBe(true)
  button('Paper b').click(); pending.resolve(project('b')); await settle(); expect(api.activate).toHaveBeenCalledOnce()
})
it('ignores obsolete list reads while using change notifications for the latest state', async () => {
  const panel = make(); await settle(); const old = deferred<ProjectLibraryState>()
  vi.mocked(api.list).mockReturnValueOnce(old.promise); const previous = panel.refresh()
  state = { projects: [entry('c')], activeId: null }; changed?.(); await flush()
  old.resolve({ projects: [entry('stale')], activeId: 'stale' }); await previous
  expect(button('Paper c').children[0]!.textContent).toBe('Paper c'); expect(get('project-library-list').children).toHaveLength(1)
})
it('removes only a non-active entrance after confirmation, without opening or deleting the project', async () => {
  make(); await settle(); button('Paper b', 1).click(); await settle()
  expect(dialogs.confirm).toHaveBeenCalledWith('从项目列表移出？', expect.stringContaining('不会删除硬盘目录'))
  expect(api.forget).toHaveBeenCalledExactlyOnceWith('b'); expect(api.activate).not.toHaveBeenCalled(); expect(documents.save).not.toHaveBeenCalled()
  expect(get('project-library-list').children).toHaveLength(1); expect(documents.project?.id).toBe('a')
})
it('never forgets the active project or proceeds after declined confirmation', async () => {
  make(); await settle(); button('Paper a', 1).click(); await settle(); expect(api.forget).not.toHaveBeenCalled()
  vi.mocked(dialogs.confirm).mockResolvedValue(false); button('Paper b', 1).click(); await settle(); expect(api.forget).not.toHaveBeenCalled()
})
it('rechecks active identity after a pending forget confirmation', async () => {
  const confirm = deferred<boolean>(); vi.mocked(dialogs.confirm).mockReturnValue(confirm.promise)
  make(); await settle(); button('Paper b', 1).click(); await flush()
  state = { ...state, activeId: 'b' }; changed?.(); await flush(); confirm.resolve(true); await settle()
  expect(api.forget).not.toHaveBeenCalled()
})
it('locks stale entries on list failure and recovers by explicit refresh', async () => {
  const panel = make(); await settle(); vi.mocked(api.list).mockRejectedValueOnce(new Error('入口文件不可读'))
  await panel.refresh(); expect(button('Paper b').disabled).toBe(true); expect(get('project-library-status').textContent).toContain('读取失败')
  get('project-library-refresh').click(); await flush(); expect(button('Paper b').disabled).toBe(false)
})
it('renders metadata as text instead of HTML and releases old row handlers when refreshing', async () => {
  state.projects[1]!.name = '<img onerror=evil>'; const panel = make(); await settle()
  const old = button('<img onerror=evil>'); expect(old.children[0]!.innerHTML).toBe(''); expect(old.handlers.size).toBe(1)
  await panel.refresh(); expect(old.handlers.size).toBe(0); expect(button('<img onerror=evil>').children[0]!.textContent).toContain('<img')
})
it('rejects actions while closing and resumes notification refresh after a canceled close', async () => {
  const panel = make(); await settle(); panel.setClosing(true); button('Paper b').click(); changed?.(); await flush()
  expect(api.activate).not.toHaveBeenCalled(); state = { projects: [entry('c')], activeId: null }
  panel.setClosing(false); await flush(); expect(button('Paper c').disabled).toBe(false)
})
it('blocks activation if the close handshake changed before the save completed', async () => {
  const pending = deferred<boolean>(); vi.mocked(documents.save).mockReturnValue(pending.promise)
  const panel = make(); await settle(); button('Paper b').click(); await flush()
  panel.setClosing(true); panel.setClosing(false); pending.resolve(true); await settle(); expect(api.activate).not.toHaveBeenCalled()
})
it('does not discard Main committed activation solely because a close was canceled', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.activate).mockReturnValue(pending.promise)
  const panel = make(); await settle(); button('Paper b').click(); await flush(); expect(api.activate).toHaveBeenCalledOnce()
  panel.setClosing(true); panel.setClosing(false); const committed = project('b'); state = { ...state, activeId: 'b' }
  pending.resolve(committed); await settle(); expect(adopt).toHaveBeenCalledExactlyOnceWith(committed)
})
it('waits in real Documents.adopt during closing and reconciles Main commit after cancel', async () => {
  documents = new Documents({ setDirty: vi.fn() } as unknown as WorkspaceApi, {
    show: vi.fn(), state: vi.fn(), files: vi.fn(), project: vi.fn(), notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true), input: vi.fn().mockResolvedValue(null) })
  const original = project('a'); documents.project = original; adopt = vi.fn(next => documents.adopt(next))
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.activate).mockReturnValue(pending.promise)
  const panel = make(); await settle(); button('Paper b').click(); await flush(); expect(api.activate).toHaveBeenCalledOnce()
  documents.setClosing(true); panel.setClosing(true); const committed = project('b'); pending.resolve(committed); await flush()
  expect(adopt).toHaveBeenCalledOnce(); expect(documents.project).toBe(original)
  documents.setClosing(false); panel.setClosing(false); await settle(); expect(documents.project).toBe(committed)
})
it('does not overwrite a changed project or newer draft with a late successful activation', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.activate).mockReturnValue(pending.promise)
  make(); await settle(); button('Paper b').click(); await flush(); expect(api.activate).toHaveBeenCalledOnce()
  documents.project = project('other'); documents.buffer.editVersion += 1; Object.assign(documents.buffer, { dirty: true })
  pending.resolve(project('b')); await settle(); expect(adopt).not.toHaveBeenCalled(); expect(documents.project?.id).toBe('other')
})
it('disposes subscriptions/listeners and ignores a late activation without further UI effects', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.activate).mockReturnValue(pending.promise)
  const panel = make(); await settle(); button('Paper b').click(); await flush(); const old = button('Paper b')
  panel.dispose(); panel.dispose(); pending.resolve(project('b')); await settle()
  expect(adopt).not.toHaveBeenCalled(); expect(unsubscribe).toHaveBeenCalledOnce(); expect(old.handlers.size).toBe(0)
  expect(get('project-library-refresh').handlers.size).toBe(0); expect(get('project-library-search').handlers.size).toBe(0)
  const calls = vi.mocked(api.list).mock.calls.length
  changed?.(); await flush(); expect(api.list).toHaveBeenCalledTimes(calls)
})
it('shows per-project GitHub, local or issue badges as display-only metadata', async () => {
  state.projects = [{ ...entry('a'), github: { owner: 'lab', name: 'paper-a' } }, { ...entry('b'), github: null },
    { ...entry('c'), github: { owner: 'old', name: 'paper-c' }, syncIssue: true }]
  make(); await settle()
  expect(button('Paper a').children[1]!.textContent).toBe('GitHub'); expect(button('Paper a').children[1]!.title).toBe('lab/paper-a')
  expect(button('Paper b').children[1]!.textContent).toBe('本地'); expect(button('Paper c').children[1]!.textContent).toBe('关联异常')
  expect(api.activate).not.toHaveBeenCalled()
})
function cloudProvider(papers: { owner: string; name: string }[] = []) {
  const provider = { account: true, shown: true, signedIn: () => provider.account, visible: () => provider.shown,
    list: vi.fn(async (): Promise<{ owner: string; name: string }[] | null> => papers), download: vi.fn() }
  return provider
}
function makeWithCloud(cloud: CloudPapers): ProjectLibraryPanel {
  const panel = new ProjectLibraryPanel(api, documents, dialogs, run, adopt, notify, resume, cloud)
  panels.push(panel); panel.initialize(); return panel
}
const names = (): string[] => get('project-library-list').children.map(row => row.children[0]?.children[0]?.textContent ?? row.textContent)
it('shows local-only, linked and cloud-only papers together and says which can be synced or downloaded', async () => {
  state.projects = [{ ...entry('a'), github: { owner: 'lab', name: 'paper-a' } }, { ...entry('b'), github: null }]
  const cloud = cloudProvider([{ owner: 'Lab', name: 'Paper-A' }, { owner: 'lab', name: 'thesis' }, { owner: 'lab', name: 'thesis' }])
  makeWithCloud(cloud); await settle()
  expect(cloud.list).toHaveBeenCalledOnce(); expect(names()).toEqual(['Paper a', 'Paper b', 'lab/thesis'])
  expect(button('Paper a').children[1]!.textContent).toBe('GitHub'); expect(button('Paper a').children[3]!.textContent).toBe('可同步')
  expect(button('Paper b').children[1]!.textContent).toBe('本地'); expect(button('Paper b').children[3]!.textContent).toBe('未上传到云端')
  const row = button('lab/thesis')
  expect(row.children[1]!.textContent).toBe('云端'); expect(row.children[1]!.attributes.get('data-kind')).toBe('cloud')
  expect(row.children[3]!.textContent).toBe('尚未下载'); expect(row.children).toHaveLength(4)
  // The "last modified" column of a cloud-only paper holds no action: its time is unknown until it is downloaded.
  expect(row.children[2]!.className).toBe('pl-modified'); expect(row.children[2]!.textContent).toBe('—')
  expect(row.children[2]!.attributes.get('aria-hidden')).toBe('true')
  const download = button('lab/thesis', 1)
  expect(download.className).toBe('pl-download'); expect(download.textContent).toBe('下载'); expect(download.title).toBe('下载到本地')
  expect(download.attributes.get('aria-label')).toBe('下载 lab/thesis 到本地')
  expect(get('project-library-cloud').textContent).toBe('本机 2 篇，其中 1 篇已关联云端、可同步；另有 1 篇只在云端，可下载到本地。')
  expect(cloud.download).not.toHaveBeenCalled(); download.click()
  expect(cloud.download).toHaveBeenCalledExactlyOnceWith({ owner: 'lab', name: 'thesis' })
  expect(api.activate).not.toHaveBeenCalled(); expect(documents.save).not.toHaveBeenCalled()
})
it('reads the cloud list only for a signed-in visible home page, on explicit refresh or an account change, never on file notifications', async () => {
  const cloud = cloudProvider([{ owner: 'lab', name: 'thesis' }]); cloud.account = false
  const panel = makeWithCloud(cloud); await settle()
  expect(cloud.list).not.toHaveBeenCalled(); expect(get('project-library-cloud').textContent).toContain('登录 GitHub 后')
  expect(names()).toEqual(['Paper a', 'Paper b'])
  cloud.account = true; cloud.shown = false; panel.accountChanged(); await settle(); expect(cloud.list).not.toHaveBeenCalled()
  cloud.shown = true; await panel.refresh(true); await settle(); expect(cloud.list).toHaveBeenCalledOnce(); expect(names()).toContain('lab/thesis')
  changed?.(); await settle(); await panel.refresh(); await settle(); expect(cloud.list).toHaveBeenCalledOnce(); expect(names()).toContain('lab/thesis')
  get('project-library-refresh').click(); await settle(); expect(cloud.list).toHaveBeenCalledTimes(2)
  panel.accountChanged(); await settle(); expect(cloud.list).toHaveBeenCalledTimes(3)
  cloud.account = false; panel.accountChanged(); await settle()
  expect(cloud.list).toHaveBeenCalledTimes(3); expect(names()).toEqual(['Paper a', 'Paper b'])
})
it('reads a deferred cloud list once the blocking dialog has closed, but never repeats a list that was already read', async () => {
  const cloud = cloudProvider([{ owner: 'lab', name: 'thesis' }]); cloud.shown = false
  const panel = makeWithCloud(cloud); await settle(); panel.accountChanged(); await settle(); expect(cloud.list).not.toHaveBeenCalled()
  cloud.shown = true; panel.resumeCloud(); await settle(); expect(cloud.list).toHaveBeenCalledOnce(); expect(names()).toContain('lab/thesis')
  panel.resumeCloud(); await settle(); expect(cloud.list).toHaveBeenCalledOnce()
  cloud.account = false; panel.accountChanged(); panel.resumeCloud(); await settle(); expect(cloud.list).toHaveBeenCalledOnce()
})
it('keeps local projects usable when the cloud read fails, and ignores a result that arrives after sign-out', async () => {
  const cloud = cloudProvider(); cloud.list.mockRejectedValueOnce(new Error('network diagnostic'))
  const panel = makeWithCloud(cloud); await settle()
  expect(get('project-library-cloud').textContent).toContain('云端论文读取失败'); expect(get('project-library-cloud').textContent).toContain('刷新')
  expect(button('Paper b').disabled).toBe(false); expect(names()).toEqual(['Paper a', 'Paper b'])
  const late = deferred<{ owner: string; name: string }[]>(); cloud.list.mockReturnValueOnce(late.promise)
  get('project-library-refresh').click(); await flush(); expect(get('project-library-cloud').textContent).toContain('正在读取云端论文')
  cloud.account = false; panel.accountChanged(); late.resolve([{ owner: 'lab', name: 'thesis' }]); await settle()
  expect(names()).toEqual(['Paper a', 'Paper b']); expect(get('project-library-cloud').textContent).toContain('登录 GitHub 后')
})
it('filters cloud-only papers with the same search and locks their download while closing or after disposal', async () => {
  const cloud = cloudProvider([{ owner: 'lab', name: 'thesis' }, { owner: 'lab', name: 'notes' }])
  const panel = makeWithCloud(cloud); await settle()
  get('project-library-search').input('  THESIS '); expect(names()).toEqual(['lab/thesis'])
  get('project-library-search').input('zzz'); expect(get('project-library-list').children[0]!.className).toBe('pl-empty')
  get('project-library-search').input(''); expect(names()).toEqual(['Paper a', 'Paper b', 'lab/thesis', 'lab/notes'])
  panel.setClosing(true); expect(button('lab/thesis', 1).disabled).toBe(true)
  panel.setClosing(false); await settle(); const download = button('lab/notes', 1); expect(download.disabled).toBe(false)
  panel.dispose(); download.click(); expect(cloud.download).not.toHaveBeenCalled()
})
it('puts every row action in its own column so local and cloud rows share one column layout', async () => {
  const cloud = cloudProvider([{ owner: 'lab', name: 'thesis' }]); makeWithCloud(cloud); await settle()
  const markup = get('project-library').innerHTML
  expect(markup).toContain('<div class="pl-columns-main"><span>项目名称</span><span>存储位置</span><span>最后修改</span></div><span>操作</span>')
  const rows = get('project-library-list').children
  expect(rows.map(row => row.children.map(node => node.className))).toEqual([['pl-open', 'pl-forget'], ['pl-open', 'pl-forget'], ['pl-open pl-cloud', 'pl-download']])
  for (const row of rows) expect(row.children[0]!.children.map(node => node.className)).toEqual(['pl-name', 'pl-badge', 'pl-modified', 'pl-note'])
  for (const locale of ['en', 'ko'] as const) for (const text of ['操作', '移出']) expect(translate(text, locale), text).not.toMatch(/[㐀-鿿]/)
  // A worded button, not a bare "×": it only removes the entry from this list and never deletes files.
  const forget = button('Paper b', 1)
  expect(forget.textContent).toBe('移出'); expect(forget.title).toBe('移出列表，不删除硬盘文件')
  expect(forget.attributes.get('aria-label')).toBe('从列表移出 Paper b，不删除文件')
  expect(button('Paper a', 1).textContent).toBe('移出'); expect(button('Paper a', 1).disabled).toBe(true) // the current project
})
it('gives the header and the rows the same column tracks and centres the status, time and action columns', () => {
  const css = readFileSync('src/renderer/project-library-style.css', 'utf8')
  const rule = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`)
    expect(start, selector).toBeGreaterThanOrEqual(0)
    return css.slice(start, css.indexOf('}', start))
  }
  const outer = 'grid-template-columns: minmax(0,1fr) var(--pl-action); column-gap: 10px;'
  expect(rule('#project-library .pl-columns')).toContain(outer); expect(rule('#project-library .pl-project')).toContain(outer)
  const inner = 'grid-template-columns: var(--pl-columns); column-gap: 12px;'
  expect(rule('#project-library .pl-columns-main')).toContain(inner); expect(rule('#project-library .pl-open')).toContain(inner)
  // Row: 1px border + 6px padding on the right, 1px border on the left; the header mirrors both with padding.
  expect(rule('#project-library .pl-project')).toContain('padding-right: 6px;'); expect(rule('#project-library .pl-project')).toContain('border: 1px solid')
  expect(rule('#project-library .pl-columns')).toContain('padding: 8px 7px 10px 1px;')
  expect(rule('#project-library .pl-columns-main')).toContain('padding-inline: 18px;'); expect(rule('#project-library .pl-open')).toContain('padding: 14px 18px;')
  expect(rule('#project-library .pl-columns-main > span + span, #project-library .pl-columns > span')).toContain('text-align: center;')
  expect(rule('#project-library .pl-open > .pl-badge')).toContain('justify-self: center;')
  expect(rule('#project-library .pl-note')).toContain('text-align: center;'); expect(rule('#project-library .pl-modified')).toContain('text-align: center;')
  // Both row actions are the same worded button shape; only their colours differ.
  const action = rule('#project-library .pl-forget, #project-library .pl-download')
  for (const part of ['align-self: center;', 'justify-self: center;', 'min-height: 30px;', 'padding: 5px 14px;', 'border-radius: 8px;', 'font-size: 12px;']) expect(action).toContain(part)
  expect(css).not.toContain('\n#project-library .pl-forget {') // no separate icon-sized rule for the remove button
})
it('explains the cloud states in all three languages and keeps the legacy panel free of cloud reads', async () => {
  make(); await settle(); expect(get('project-library-cloud').hidden).toBe(true)
  for (const locale of ['en', 'ko'] as const) for (const text of ['云端', '可同步', '未上传到云端', '需检查关联', '尚未下载', '下载到本地', '正在读取云端论文…',
    '登录 GitHub 后，这里会同时显示你在云端的论文。', '本机 2 篇，其中 1 篇已关联云端、可同步；另有 1 篇只在云端，可下载到本地。',
    '云端论文读取失败：', '本地项目不受影响，可点“刷新”重试。', '下载 lab/thesis 到本地', '此项目只在云端，尚未下载到这台电脑',
    '已关联云端', '当前账号不可同步', '可能已在本机', '读取云端论文'])
    expect(translate(text, locale), text).not.toMatch(/[㐀-鿿]/)
  expect(translate('下载 lab/thesis 到本地', 'en')).toContain('lab/thesis')
})
it('translates the failure reason together with its frame instead of leaving it in the source language', async () => {
  const cloud = cloudProvider(); cloud.list.mockRejectedValueOnce(new Error('尚无项目'))
  setLocale('en'); try {
    makeWithCloud(cloud); await settle()
    expect(get('project-library-cloud').textContent).toBe('Could not load cloud papers: No projects yet Local projects are unaffected. Choose “Refresh” to try again.')
  } finally { setLocale('zh-CN') }
})
it('claims a paper can sync only when the signed-in account lists it, and flags cloud rows a broken local link may already hold', async () => {
  state.projects = [{ ...entry('a'), github: { owner: 'lab', name: 'paper-a' } }, { ...entry('b'), github: { owner: 'other', name: 'paper-b' } }]
  const cloud = cloudProvider([{ owner: 'lab', name: 'paper-a' }, { owner: 'lab', name: 'thesis' }]); cloud.account = false
  const panel = makeWithCloud(cloud); await settle()
  expect(button('Paper a').children[3]!.textContent).toBe('已关联云端'); expect(button('Paper b').children[3]!.textContent).toBe('已关联云端')
  cloud.account = true; panel.accountChanged(); await settle()
  expect(button('Paper a').children[3]!.textContent).toBe('可同步'); expect(button('Paper b').children[3]!.textContent).toBe('当前账号不可同步')
  expect(get('project-library-cloud').textContent).toBe('本机 2 篇，其中 1 篇已关联云端、可同步；另有 1 篇只在云端，可下载到本地。')
  expect(button('lab/thesis').children[3]!.textContent).toBe('尚未下载')
  state = { ...state, projects: [...state.projects, { ...entry('c'), github: null, syncIssue: true }] }; changed?.(); await settle()
  expect(button('Paper c').children[3]!.textContent).toBe('需检查关联'); expect(button('lab/thesis').children[3]!.textContent).toBe('可能已在本机')
})
it('never overlaps two cloud reads and retries a read that could not start once the app is idle again', async () => {
  const cloud = cloudProvider([{ owner: 'lab', name: 'thesis' }]), first = deferred<{ owner: string; name: string }[] | null>()
  cloud.list.mockReturnValueOnce(first.promise)
  const panel = makeWithCloud(cloud); await flush(); expect(cloud.list).toHaveBeenCalledOnce()
  get('project-library-refresh').click(); get('project-library-refresh').click(); panel.resumeCloud(); await flush()
  expect(cloud.list).toHaveBeenCalledOnce() // still the single read in flight
  first.resolve(null); await settle() // it could not start because another action was running
  expect(names()).toEqual(['Paper a', 'Paper b']); expect(get('project-library-cloud').hidden).toBe(true)
  panel.resumeCloud(); await settle(); expect(cloud.list).toHaveBeenCalledTimes(2); expect(names()).toContain('lab/thesis')
  cloud.list.mockResolvedValueOnce(null); get('project-library-refresh').click(); await settle()
  expect(cloud.list).toHaveBeenCalledTimes(3); expect(names()).toContain('lab/thesis') // a skipped refresh keeps the list already shown
})
it('leaves the existing right-side sync control as the sole settings entrance with no left-side duplicate', async () => {
  const opened = vi.fn(); get('cloud-open').addEventListener('click', opened)
  const panel = make(); await settle(); await panel.refresh()
  for (const row of get('project-library-list').children) {
    expect(row.children).toHaveLength(2)
    expect(row.children.map(node => node.className)).toEqual(['pl-open', 'pl-forget'])
  }
  expect(get('project-library').innerHTML).not.toContain('cloud-open'); expect(get('cloud-open').handlers.size).toBe(1)
  expect(opened).not.toHaveBeenCalled(); get('cloud-open').click(); expect(opened).toHaveBeenCalledOnce()
})
it('switches the project safely without implicitly opening settings or adding a left sync action', async () => {
  const opened = vi.fn(); get('cloud-open').addEventListener('click', opened)
  make(); await settle(); button('Paper b').click(); await settle()
  expect(api.activate).toHaveBeenCalledExactlyOnceWith('b'); expect(documents.project?.id).toBe('b')
  const row = get('project-library-list').children.find(item => item.children[0]?.children[0]?.textContent === 'Paper b')!
  expect(row.children).toHaveLength(2); expect(row.children[0]!.attributes.get('aria-current')).toBe('true')
  expect(opened).not.toHaveBeenCalled(); expect(get('cloud-open').handlers.size).toBe(1)
})
it('renders a separate all-projects dashboard without fold/current or duplicated open/create controls', async () => {
  make(); await settle(); const markup = get('project-library').innerHTML
  expect(markup).toContain('全部项目'); expect(markup).toContain('id="project-library-search"')
  expect(markup).toContain('最后修改'); expect(markup).not.toContain('<span>最近打开</span>')
  for (const id of ['project-library-toggle', 'project-library-current', 'project-open', 'project-create']) expect(markup).not.toContain(`id="${id}"`)
  expect(get('project-open').handlers.size).toBe(0); expect(get('project-create').handlers.size).toBe(0)
})
it('scopes the sunlit dashboard card styles without touching editor layout or external project actions', () => {
  const css = readFileSync('src/renderer/project-library-style.css', 'utf8')
  expect(css).toContain('background: #ffffff'); expect(css).toContain('#project-library .pl-columns')
  expect(css).toContain('#project-library .pl-modified'); expect(css).toContain('focus-visible')
  expect(css).not.toMatch(/\.workspace|\.files-panel|#project-open|#project-create|is-collapsed|@import|url\(/)
})
it('shows real last-modified metadata and keeps opened recency only in the tooltip', async () => {
  const modifiedAt = '2024-01-02T03:04:05.000Z'
  state.projects[1]!.lastModifiedAt = modifiedAt
  make(); await settle(); const modified = button('Paper b').children[2]!
  expect(modified.className).toBe('pl-modified'); expect(modified.dateTime).toBe(modifiedAt)
  expect(modified.title).toContain(`最后修改：${modifiedAt}`)
  expect(modified.title).toContain(`最近打开：${entry('b').lastOpenedAt}`)
  expect(modified.textContent).not.toBe('未知'); expect(button('Paper b').children).toHaveLength(4) // name, location badge, modified time, sync note
})
it.each([undefined, null, 'not-a-time', '2024-01-02'])('never substitutes lastOpenedAt for unknown or malformed modification metadata (%s)', async value => {
  state.projects[1]!.lastModifiedAt = value; make(); await settle()
  const modified = button('Paper b').children[2]!
  expect(modified.textContent).toBe('未知'); expect(modified.dateTime).toBe('')
  expect(modified.title).toContain('最后修改时间未知'); expect(modified.title).toContain(entry('b').lastOpenedAt)
})
it('does not let malformed opened metadata erase the independently valid modification time', async () => {
  state.projects[1]!.lastOpenedAt = 'not-a-time'; state.projects[1]!.lastModifiedAt = '2024-01-02T03:04:05.000Z'
  make(); await settle(); const modified = button('Paper b').children[2]!
  expect(modified.dateTime).toBe('2024-01-02T03:04:05.000Z'); expect(modified.title).toContain('最近打开时间未知')
})
it('filters project names locally with whitespace and case handling and restores all rows when cleared', async () => {
  make(); await settle(); get('project-library-search').input('  PAPER B  ')
  expect(get('project-library-list').children).toHaveLength(1); expect(button('Paper b').children[0]!.textContent).toBe('Paper b')
  get('project-library-search').input(''); expect(get('project-library-list').children).toHaveLength(2)
  get('project-library-search').input('/fixture/'); expect(get('project-library-list').children[0]!.className).toBe('pl-empty')
  expect(get('project-library-list').children[0]!.textContent).toBe('没有匹配的项目')
})
it('keeps search transient and makes no authorization, selection, save or storage requests', async () => {
  const storage = { getItem: vi.fn(), setItem: vi.fn() }; vi.stubGlobal('localStorage', storage)
  make(); await settle(); const reads = vi.mocked(api.list).mock.calls.length
  get('project-library-search').input('b'); get('project-library-search').input('<img'); get('project-library-search').input('')
  expect(api.list).toHaveBeenCalledTimes(reads); expect(api.activate).not.toHaveBeenCalled(); expect(api.forget).not.toHaveBeenCalled()
  expect(documents.save).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
  expect(dialogs.confirm).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled()
})
it('retains the query across refresh notifications without reopening or resuming any paper', async () => {
  const panel = make(); await settle(); get('project-library-search').input('PAPER B')
  await panel.refresh(); changed?.(); await flush()
  expect(get('project-library-search').value).toBe('PAPER B'); expect(get('project-library-list').children).toHaveLength(1)
  expect(button('Paper b').children[0]!.textContent).toBe('Paper b'); expect(api.activate).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled()
})
it('can open a filtered non-active result through the same save-first opaque-id activation', async () => {
  make(); await settle(); get('project-library-search').input('b'); button('Paper b').click(); await settle()
  expect(documents.save).toHaveBeenCalledOnce(); expect(api.activate).toHaveBeenCalledExactlyOnceWith('b')
  expect(adopt).toHaveBeenCalledOnce(); expect(resume).not.toHaveBeenCalled()
})
it('resumes the active editor locally without saving, resetting or re-adopting even a dirty conflicted draft', async () => {
  make(); await settle(); const buffer = documents.buffer, current = documents.project
  Object.assign(buffer, { dirty: true, conflict: true }); button('Paper a').click()
  expect(resume).toHaveBeenCalledOnce(); expect(documents.buffer).toBe(buffer); expect(documents.project).toBe(current)
  expect(buffer.dirty).toBe(true); expect(buffer.conflict).toBe(true)
  expect(api.activate).not.toHaveBeenCalled(); expect(documents.save).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled(); expect(dialogs.confirm).not.toHaveBeenCalled()
})
it('does not resume while another paper activation is busy, while closing or after disposal', async () => {
  const saving = deferred<boolean>(); vi.mocked(documents.save).mockReturnValue(saving.promise)
  const panel = make(); await settle(); button('Paper b').click(); await flush()
  const active = button('Paper a'); expect(active.disabled).toBe(true); active.disabled = false; active.click()
  expect(resume).not.toHaveBeenCalled(); saving.resolve(false); await settle()
  panel.setClosing(true); button('Paper a').disabled = false; button('Paper a').click(); expect(resume).not.toHaveBeenCalled()
  panel.setClosing(false); await settle(); const old = button('Paper a'); panel.dispose(); old.click()
  expect(resume).not.toHaveBeenCalled(); expect(old.handlers.size).toBe(0)
})
it('opens through Main instead of resuming a nonexistent editor when a stale active ID remains', async () => {
  documents.project = null; make(); await settle(); const active = button('Paper a')
  expect(active.disabled).toBe(false); active.click(); await settle()
  expect(resume).not.toHaveBeenCalled(); expect(api.activate).toHaveBeenCalledWith('a')
  expect(adopt).toHaveBeenCalledOnce(); expect(documents.project).toEqual(project('a'))
})
it('does not require a successful library re-read merely to resume the already-open local editor', async () => {
  const panel = make(); await settle(); vi.mocked(api.list).mockRejectedValueOnce(new Error('read failure')); await panel.refresh()
  expect(button('Paper b').disabled).toBe(true); expect(button('Paper a').disabled).toBe(false)
  button('Paper a').click(); expect(resume).toHaveBeenCalledOnce(); expect(api.activate).not.toHaveBeenCalled()
})
it('keeps the optional resume callback backward-compatible with existing six-argument callers', async () => {
  const panel = new ProjectLibraryPanel(api, documents, dialogs, run, adopt, notify)
  panels.push(panel); panel.initialize(); await settle(); expect(() => button('Paper a').click()).not.toThrow()
  expect(api.activate).not.toHaveBeenCalled(); expect(documents.save).not.toHaveBeenCalled()
})
it('blocks search input during close handshake and restores the in-memory query after a canceled close', async () => {
  const panel = make(); await settle(); get('project-library-search').input('b'); panel.setClosing(true)
  expect(get('project-library-search').disabled).toBe(true); get('project-library-search').input('a')
  panel.setClosing(false); await settle()
  expect(get('project-library-search').disabled).toBe(false); expect(get('project-library-search').value).toBe('b')
  expect(get('project-library-list').children).toHaveLength(1); expect(button('Paper b').children[0]!.textContent).toBe('Paper b')
})
