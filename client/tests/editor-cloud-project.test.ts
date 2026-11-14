/// <reference lib="dom" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { CloudApi, CloudWorkspaceStatus } from '../src/shared/cloud-contracts'
import type { ProjectInfo, WorkspaceApi } from '../src/shared/workspace-contracts'
import { Documents } from '../src/renderer/documents'
import type { Dialogs } from '../src/renderer/dialogs'
import type { RunAction } from '../src/renderer/sync-panel'
import { CloudProjectPanel } from '../src/renderer/cloud-project-panel'

class NodeMock {
  id = ''; textContent = ''; value = ''; title = ''; hidden = false; disabled = false; readOnly = false; type = ''; dataset: Record<string, string> = {}
  children: NodeMock[] = []; attributes = new Map<string, string>(); handlers = new Set<() => void>(); markup = ''
  focus = vi.fn(); select = vi.fn()
  set innerHTML(markup: string) {
    this.markup = markup
    for (const match of markup.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const node = get(match[1]!); node.readOnly = /\breadonly\b/.test(match[0]); this.children.push(node)
    }
  }
  get innerHTML(): string { return this.markup }
  append(...nodes: NodeMock[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: NodeMock[]): void { this.children = nodes }
  addEventListener(_type: string, action: () => void): void { this.handlers.add(action) }
  removeEventListener(_type: string, action: () => void): void { this.handlers.delete(action) }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  querySelectorAll(): NodeMock[] {
    return this.children.flatMap(node => [...(node.dataset.cpChoice ? [node] : []), ...node.querySelectorAll()])
  }
  click(): void { if (!this.disabled) for (const action of this.handlers) action() }
}
const nodes = new Map<string, NodeMock>()
function get(id: string): NodeMock {
  if (!nodes.has(id)) { const node = new NodeMock(); node.id = id; nodes.set(id, node) }
  return nodes.get(id)!
}
const project = (id = 'one'): ProjectInfo => ({ id, name: id, root: `/fixture/${id}`, files: [], defaultMain: null })
const status = (extra: Partial<CloudWorkspaceStatus> = {}): CloudWorkspaceStatus => ({ configured: true, signedIn: true,
  account: { id: 1, login: 'writer', name: null }, connection: { projectId: 2, owner: 'writer', name: 'paper', branch: 'main' },
  autoSync: false, lastSyncedAt: null, message: '已关联', ...extra })
let api: CloudApi
let documents: Documents
let dialogs: Dialogs
let adopt: (project: ProjectInfo) => Promise<void>
let notify: (message: string) => void
let tasks: Promise<void>[]
let run: RunAction
let workbenchBusy: boolean
const panels: CloudProjectPanel[] = []
beforeEach(() => {
  vi.useFakeTimers(); nodes.clear(); tasks = []; workbenchBusy = false
  vi.stubGlobal('document', { getElementById: get, createElement: () => new NodeMock() })
  api = { status: vi.fn().mockResolvedValue(status()), projects: vi.fn().mockResolvedValue([
    { handle: 'opaque-selection', project: { id: 2, installationId: 5, owner: 'writer', name: 'paper', private: true } }]),
    createPrivateProject: vi.fn().mockResolvedValue({ project: { id: 2, owner: 'writer', name: 'paper', private: true }, connected: true, message: '私有项目已创建' }),
    linkProject: vi.fn().mockResolvedValue(status()), downloadProject: vi.fn().mockResolvedValue(project('download')),
    joinProject: vi.fn().mockResolvedValue(project('joined')), shareProject: vi.fn().mockResolvedValue('https://github.com/writer/paper'),
    inviteCollaborator: vi.fn().mockResolvedValue({ message: '邀请已发送' }),
    invitations: vi.fn().mockResolvedValue([{ handle: 'opaque-invitation', owner: 'owner', name: 'paper', inviter: 'collaborator' }]),
    acceptInvitation: vi.fn().mockResolvedValue({ message: '邀请已接受' }),
    sync: vi.fn().mockResolvedValue({ uploaded: true, downloaded: true, message: '同步完成', status: { connection: null, changes: [], message: '', conflict: false } }),
    setAutoSync: vi.fn(async enabled => status({ autoSync: enabled })), openAuthorization: vi.fn().mockResolvedValue(undefined), openInvitations: vi.fn().mockResolvedValue(undefined) }
  documents = { project: project(), buffer: { dirty: false, conflict: false, editVersion: 1, path: 'main.tex' },
    save: vi.fn().mockResolvedValue(true), refresh: vi.fn().mockResolvedValue(undefined) } as unknown as Documents
  dialogs = { confirm: vi.fn().mockResolvedValue(true) } as unknown as Dialogs
  adopt = vi.fn(async next => { documents.project = next; documents.buffer.editVersion += 1 })
  notify = vi.fn()
  run = vi.fn((_label, action) => { if (!workbenchBusy) tasks.push(action()) })
})
afterEach(() => { for (const panel of panels.splice(0)) panel.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })
function make(bridge: CloudApi | null = api): CloudProjectPanel {
  const panel = new CloudProjectPanel(bridge ?? undefined, documents, dialogs, run, adopt, notify)
  panels.push(panel); panel.initialize(); return panel
}
async function flush(): Promise<void> { for (let i = 0; i < 15; i += 1) await Promise.resolve() }
async function settle(): Promise<void> { await flush(); await Promise.all(tasks.splice(0)) }
async function click(id: string): Promise<void> { get(`cp-${id}`).click(); await settle() }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: value => resolve(value) }
}
function rowButton(list: string, label: string): NodeMock {
  const button = get(`cp-${list}`).children.flatMap(row => row.children).find(node => node.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  return button
}

it('has a missing optional bridge with disabled controls and no background requests', async () => {
  make(null); await settle(); await click('create'); await vi.advanceTimersByTimeAsync(60_000)
  expect(get('cp-status').textContent).toContain('未接入'); expect(get('cp-create').disabled).toBe(true)
  expect(api.status).not.toHaveBeenCalled(); expect(api.createPrivateProject).not.toHaveBeenCalled()
})
it('initializes idempotently with status only; no discovery, uploads or public option', async () => {
  const panel = make(); panel.initialize(); await settle()
  expect(api.status).toHaveBeenCalledOnce(); expect(api.projects).not.toHaveBeenCalled(); expect(api.invitations).not.toHaveBeenCalled()
  expect(api.createPrivateProject).not.toHaveBeenCalled(); expect(get('cloud-project-workspace').innerHTML).not.toContain('type="checkbox"')
  expect(get('cp-share-link').readOnly).toBe(true)
})
it('hides main-page sync without a selected paper and guards even a stale synthetic click', async () => {
  documents.project = null; make(); await settle()
  expect(get('project-sync').hidden).toBe(true); expect(get('project-sync-status').hidden).toBe(true)
  expect(get('project-sync').disabled).toBe(true); expect(get('project-sync-status').textContent).toBe('')
  get('project-sync').disabled = false; get('project-sync').click(); await settle()
  expect(api.sync).not.toHaveBeenCalled(); expect(documents.save).not.toHaveBeenCalled(); expect(dialogs.confirm).not.toHaveBeenCalled()
})
it('uses the same saved guarded path for main-page current-paper sync and settings sync', async () => {
  documents.project = project('Paper A'); make(); await settle(); get('cp-summary').value = 'current progress'
  expect(get('project-sync').hidden).toBe(false); expect(get('project-sync').disabled).toBe(false)
  expect(get('project-sync').textContent).toBe('同步当前论文'); expect(get('project-sync').title).toContain('Paper A')
  expect(get('project-sync-status').textContent).toBe('Paper A · writer/paper')
  expect(get('project-sync').attributes.get('aria-label')).toContain('Paper A')
  get('project-sync').click(); await settle()
  expect(api.sync).toHaveBeenCalledExactlyOnceWith('current progress', false)
  expect(documents.refresh).toHaveBeenCalledWith(['']); expect(api.status).toHaveBeenCalledTimes(3)
  expect(dialogs.confirm).toHaveBeenCalledWith('同步当前论文？', expect.stringContaining('不会强制覆盖'))
  await click('sync'); expect(api.sync).toHaveBeenCalledTimes(2)
  expect(get('cloud-project-workspace').innerHTML).toContain('同步当前论文')
  expect(get('cloud-project-workspace').innerHTML).not.toContain('同步全部')
})
it.each([
  { configured: false }, { signedIn: false, account: null }, { connection: null }
])('disables both current-paper sync actions for an unavailable binding/account: %j', async extra => {
  vi.mocked(api.status).mockResolvedValue(status(extra)); make(); await settle()
  expect(get('project-sync').hidden).toBe(false); expect(get('project-sync').disabled).toBe(true)
  expect(get('cp-sync').disabled).toBe(true); get('project-sync').disabled = false; get('project-sync').click(); await settle()
  expect(api.sync).not.toHaveBeenCalled()
})
it('shows unavailable current-paper sync without a bridge and blocks requests while busy or closing', async () => {
  const missing = make(null); await settle()
  expect(get('project-sync').disabled).toBe(true); expect(get('project-sync-status').textContent).toContain('同步不可用')
  missing.dispose(); const panel = make(); await settle()
  const confirmation = deferred<boolean>(); vi.mocked(dialogs.confirm).mockReturnValue(confirmation.promise)
  get('project-sync').click(); await flush(); expect(get('project-sync').disabled).toBe(true)
  expect(get('project-sync-status').textContent).toContain('处理中')
  panel.setClosing(true); get('project-sync').click(); confirmation.resolve(true); await settle()
  expect(api.sync).not.toHaveBeenCalled(); expect(get('project-sync').disabled).toBe(true)
})
it('disables current-paper sync until the latest status refresh completes', async () => {
  const panel = make(); await settle(); const pending = deferred<CloudWorkspaceStatus>()
  vi.mocked(api.status).mockReturnValueOnce(pending.promise); const reading = panel.refresh(); await flush()
  expect(get('project-sync').disabled).toBe(true); expect(get('cp-sync').disabled).toBe(true)
  get('project-sync').disabled = false; get('project-sync').click(); await flush(); expect(api.sync).not.toHaveBeenCalled()
  pending.resolve(status()); await reading; expect(get('project-sync').disabled).toBe(false)
})
it('blocks main-page sync on save failure or draft conflict without discarding edits', async () => {
  make(); await settle(); Object.assign(documents.buffer, { dirty: true }); vi.mocked(documents.save).mockResolvedValue(false)
  get('project-sync').click(); await settle(); expect(documents.save).toHaveBeenCalledOnce(); expect(api.sync).not.toHaveBeenCalled()
  Object.assign(documents.buffer, { dirty: false, conflict: true }); get('project-sync').click(); await settle()
  expect(api.sync).not.toHaveBeenCalled(); expect(get('cp-message').textContent).toContain('冲突')
})
it('immediately clears A state on projectChanged and cannot use its stale sync control for B', async () => {
  documents.project = project('A'); const panel = make(); await settle(); await click('share'); await click('projects')
  vi.mocked(api.status).mockResolvedValue(status({ autoSync: true })); await click('auto')
  get('cp-message').textContent = 'A result'; get('cp-summary').value = 'A summary'; get('cp-login').value = 'A-user'
  const old = deferred<CloudWorkspaceStatus>(); vi.mocked(api.status).mockReturnValueOnce(old.promise)
  const readingA = panel.refresh(); await flush(); documents.project = project('B'); documents.buffer.editVersion += 1
  // Even before Main calls projectChanged, an old enabled DOM control cannot reuse A's state.
  get('project-sync').disabled = false; get('project-sync').click(); await flush(); expect(api.sync).not.toHaveBeenCalled()
  panel.projectChanged()
  expect(get('project-sync').disabled).toBe(true); expect(get('project-sync').title).toContain('B')
  expect(get('cp-connected').hidden).toBe(true); expect(get('cp-status').textContent).toBe(''); expect(get('cp-message').textContent).toBe('')
  for (const id of ['share-link', 'summary', 'login']) expect(get(`cp-${id}`).value).toBe('')
  expect(get('cp-project-list').children).toHaveLength(0); expect(get('cp-invitation-list').children).toHaveLength(0)
  const fresh = deferred<CloudWorkspaceStatus>(); vi.mocked(api.status).mockReturnValueOnce(fresh.promise)
  const readingB = panel.refresh(); old.resolve(status()); await readingA
  expect(get('project-sync').disabled).toBe(true); expect(get('project-sync-status').textContent).not.toContain('writer/paper')
  fresh.resolve(status({ connection: { projectId: 9, owner: 'writer-b', name: 'paper-b', branch: 'main' }, autoSync: true })); await readingB
  expect(get('project-sync').disabled).toBe(false); expect(get('project-sync-status').textContent).toBe('B · writer-b/paper-b')
  await vi.advanceTimersByTimeAsync(90_000); await settle(); expect(api.sync).not.toHaveBeenCalled()
})
it('invalidates an A sync confirmation before B status arrives, without any sync-all fallback', async () => {
  const panel = make(); await settle(); const confirmation = deferred<boolean>()
  vi.mocked(dialogs.confirm).mockReturnValueOnce(confirmation.promise)
  get('project-sync').click(); await flush(); expect(dialogs.confirm).toHaveBeenCalledOnce()
  documents.project = project('B'); documents.buffer.editVersion += 1; panel.projectChanged()
  confirmation.resolve(true); await settle(); expect(api.sync).not.toHaveBeenCalled(); expect(get('project-sync').disabled).toBe(true)
})
it('creates a private project only after explicit confirmation and passes just its name', async () => {
  make(); await settle(); get('cp-name').value = 'my-paper'; await click('create')
  expect(api.createPrivateProject).toHaveBeenCalledExactlyOnceWith('my-paper')
  expect(dialogs.confirm).toHaveBeenCalledWith('创建私有合作项目？', expect.stringContaining('不会默默上传'))
  expect(api.sync).not.toHaveBeenCalled()
  expect(vi.mocked(run).mock.calls.every(call => call[2] === true)).toBe(true)
})
it('does not repeat unlinked creation and offers official authorization rather than PAT entry', async () => {
  vi.mocked(api.createPrivateProject).mockResolvedValue({ project: { id: 2, owner: 'writer', name: 'paper', private: true }, connected: false, message: '请授权应用' })
  make(); await settle(); get('cp-name').value = 'paper'; await click('create'); await click('create')
  await vi.advanceTimersByTimeAsync(90_000); await settle()
  expect(api.createPrivateProject).toHaveBeenCalledOnce(); expect(get('cp-message').textContent).toContain('不会自动重复创建')
  await click('authorization'); expect(api.openAuthorization).toHaveBeenCalledExactlyOnceWith()
})
it('rejects non-ASCII names or declined upload confirmation without creating', async () => {
  make(); await settle(); get('cp-name').value = '中文论文'; await click('create')
  expect(api.createPrivateProject).not.toHaveBeenCalled(); get('cp-name').value = 'paper'
  vi.mocked(dialogs.confirm).mockResolvedValue(false); await click('create'); expect(api.createPrivateProject).not.toHaveBeenCalled()
})
it('saves dirty drafts first and never discards or mutates when saving fails', async () => {
  make(); await settle(); Object.assign(documents.buffer, { dirty: true }); vi.mocked(documents.save).mockResolvedValue(false)
  get('cp-name').value = 'paper'; await click('create'); await click('join'); await click('auto'); await click('sync')
  expect(documents.save).toHaveBeenCalledTimes(4); expect(api.createPrivateProject).not.toHaveBeenCalled()
  expect(api.joinProject).not.toHaveBeenCalled(); expect(api.setAutoSync).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled()
  expect(get('cp-message').textContent).toContain('草稿已保留')
})
it('does not mutate if edits advance while a dirty save completes', async () => {
  make(); await settle(); Object.assign(documents.buffer, { dirty: true })
  const save = deferred<boolean>(); vi.mocked(documents.save).mockReturnValue(save.promise)
  get('cp-name').value = 'paper'; get('cp-create').click(); documents.buffer.editVersion += 1; save.resolve(true); await settle()
  expect(api.createPrivateProject).not.toHaveBeenCalled()
})
it('renders opaque selections and downloads only after an explicit action', async () => {
  make(); await settle(); await click('projects'); expect(api.downloadProject).not.toHaveBeenCalled()
  rowButton('project-list', '下载到本地').click(); await settle()
  expect(api.downloadProject).toHaveBeenCalledExactlyOnceWith('opaque-selection'); expect(adopt).toHaveBeenCalledOnce()
})
it('links a selected project without implicitly syncing it', async () => {
  make(); await settle(); await click('projects'); rowButton('project-list', '关联当前论文').click(); await settle()
  expect(api.linkProject).toHaveBeenCalledExactlyOnceWith('opaque-selection'); expect(api.sync).not.toHaveBeenCalled()
})
it('keeps the new project and draft when a previous download responds late', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.downloadProject).mockReturnValue(pending.promise)
  make(); await settle(); await click('projects'); rowButton('project-list', '下载到本地').click(); await flush()
  expect(api.downloadProject).toHaveBeenCalledOnce()
  documents.project = project('other'); documents.buffer.editVersion += 1; pending.resolve(project('late')); await settle()
  expect(adopt).not.toHaveBeenCalled()
})
it('adopts an acknowledged import after a canceled close instead of discarding Main commit', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(pending.promise)
  const panel = make(); await settle(); get('cp-join-link').value = 'https://github.com/owner/paper'; get('cp-join').click(); await flush()
  expect(api.joinProject).toHaveBeenCalledOnce()
  panel.setClosing(true); panel.setClosing(false); const committed = project('committed'); pending.resolve(committed); await settle()
  expect(adopt).toHaveBeenCalledExactlyOnceWith(committed); expect(documents.project).toBe(committed)
})
it('keeps a draft changed during an in-flight join and never adopts its result', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(pending.promise)
  make(); await settle(); get('cp-join').click(); await flush(); expect(api.joinProject).toHaveBeenCalledOnce()
  documents.buffer.editVersion += 1; Object.assign(documents.buffer, { dirty: true })
  pending.resolve(project('late')); await settle(); expect(adopt).not.toHaveBeenCalled()
})
it('shows permission failures and never treats a link as private authorization', async () => {
  vi.mocked(api.joinProject).mockRejectedValue(new Error('没有项目权限'))
  make(); await settle(); get('cp-join-link').value = 'https://github.com/owner/paper'; await click('join')
  expect(api.joinProject).toHaveBeenCalledExactlyOnceWith('https://github.com/owner/paper'); expect(adopt).not.toHaveBeenCalled()
  expect(get('cp-message').textContent).toContain('项目权限')
})
it('shares only a readonly selectable link and sends a username invitation explicitly', async () => {
  make(); await settle(); await click('share'); expect(get('cp-share-link').value).toBe('https://github.com/writer/paper')
  expect(get('cp-share-link').select).toHaveBeenCalledOnce(); get('cp-login').value = 'co-writer'; await click('invite')
  expect(api.inviteCollaborator).toHaveBeenCalledExactlyOnceWith('co-writer')
})
it('requires explicit acceptance and does not download when accepting an invitation', async () => {
  make(); await settle(); await click('invitations'); expect(api.acceptInvitation).not.toHaveBeenCalled()
  rowButton('invitation-list', '接受邀请').click(); await settle()
  expect(api.acceptInvitation).toHaveBeenCalledExactlyOnceWith('opaque-invitation'); expect(api.downloadProject).not.toHaveBeenCalled()
})
it('refreshes documents and status after a manual sync and never sends public flags', async () => {
  make(); await settle(); get('cp-summary').value = 'writing progress'; await click('sync')
  expect(api.sync).toHaveBeenCalledExactlyOnceWith('writing progress', false); expect(documents.refresh).toHaveBeenCalledWith([''])
  expect(api.status).toHaveBeenCalledTimes(3)
})
it('auto sync is opt-in, runs on 30s boundaries, and stops after its first failure', async () => {
  const panel = make(); await settle(); await vi.advanceTimersByTimeAsync(30_000); expect(api.sync).not.toHaveBeenCalled()
  vi.mocked(api.status).mockResolvedValue(status({ autoSync: true })); await click('auto')
  await vi.advanceTimersByTimeAsync(29_999); expect(api.sync).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); await settle(); expect(api.sync).toHaveBeenCalledExactlyOnceWith('保存写作进展', true)
  vi.mocked(api.sync).mockRejectedValue(new Error('权限已撤销')); await vi.advanceTimersByTimeAsync(30_000); await settle()
  expect(get('cp-message').textContent).toContain('同步已停止')
  await vi.advanceTimersByTimeAsync(90_000); await settle(); expect(api.sync).toHaveBeenCalledTimes(2)
  await panel.refresh(); expect(get('cp-auto').textContent).toContain('开启')
})
it('skips auto sync for dirty, conflict, workbench busy, closing, changed project and signed-out states', async () => {
  const panel = make(); await settle(); vi.mocked(api.status).mockResolvedValue(status({ autoSync: true })); await click('auto')
  Object.assign(documents.buffer, { dirty: true }); await vi.advanceTimersByTimeAsync(30_000)
  Object.assign(documents.buffer, { dirty: false, conflict: true }); await vi.advanceTimersByTimeAsync(30_000)
  documents.buffer.conflict = false; workbenchBusy = true; await vi.advanceTimersByTimeAsync(30_000)
  workbenchBusy = false; panel.setClosing(true); await vi.advanceTimersByTimeAsync(30_000); panel.setClosing(false)
  documents.project = project('other'); await vi.advanceTimersByTimeAsync(30_000)
  vi.mocked(api.status).mockResolvedValue(status({ signedIn: false, account: null, autoSync: false })); await panel.refresh()
  await vi.advanceTimersByTimeAsync(30_000); await settle(); expect(api.sync).not.toHaveBeenCalled()
})
it('uses the latest readonly status result, clears account-bound choices and ignores late closing responses', async () => {
  const panel = make(); await settle(); await click('projects')
  const old = deferred<CloudWorkspaceStatus>(); vi.mocked(api.status).mockReturnValueOnce(old.promise)
  const previous = panel.refresh(); vi.mocked(api.status).mockResolvedValue(status({ signedIn: false, account: null, connection: null }))
  await panel.refresh(); old.resolve(status()); await previous
  expect(get('cp-create').disabled).toBe(true); expect(get('cp-project-list').children).toHaveLength(0)
  const late = deferred<CloudWorkspaceStatus>(); vi.mocked(api.status).mockReturnValue(late.promise)
  const closing = panel.refresh(); panel.setClosing(true); late.resolve(status()); await closing
  expect(get('cp-create').disabled).toBe(true)
})
it('disposes listeners and timers without further requests or late effects', async () => {
  const panel = make(); await settle(); panel.dispose(); await click('refresh'); await vi.advanceTimersByTimeAsync(90_000)
  expect(api.status).toHaveBeenCalledOnce(); expect(get('cp-create').handlers.size).toBe(0)
})
it('does not resume backend auto mode without explicit opt-in in this panel session', async () => {
  vi.mocked(api.status).mockResolvedValue(status({ autoSync: true })); make(); await settle()
  await vi.advanceTimersByTimeAsync(90_000); await settle(); expect(api.sync).not.toHaveBeenCalled()
})
it('does not overlap pending automatic syncs and allows explicit stopping afterward', async () => {
  const pending = deferred<Awaited<ReturnType<CloudApi['sync']>>>()
  make(); await settle(); vi.mocked(api.status).mockResolvedValue(status({ autoSync: true })); await click('auto')
  vi.mocked(api.sync).mockReturnValue(pending.promise); await vi.advanceTimersByTimeAsync(30_000)
  await vi.advanceTimersByTimeAsync(60_000); expect(api.sync).toHaveBeenCalledOnce()
  pending.resolve({ status: { connection: null, changes: [], message: '', conflict: false }, uploaded: false, downloaded: false, message: '完成' })
  await settle(); await click('auto'); expect(api.setAutoSync).toHaveBeenLastCalledWith(false)
  await vi.advanceTimersByTimeAsync(30_000); await settle(); expect(api.sync).toHaveBeenCalledOnce()
})
it('offers fixed official invitations fallback and never accepts automatically', async () => {
  make(); await settle(); await click('invitations-web')
  expect(api.openInvitations).toHaveBeenCalledExactlyOnceWith(); expect(api.acceptInvitation).not.toHaveBeenCalled()
})
it('reports conflicts without calling the cloud and never runs actions while closing', async () => {
  const panel = make(); await settle(); documents.buffer.conflict = true
  await click('sync'); expect(api.sync).not.toHaveBeenCalled(); expect(get('cp-message').textContent).toContain('冲突')
  panel.setClosing(true); get('cp-name').value = 'paper'; await click('create'); await click('authorization')
  expect(api.createPrivateProject).not.toHaveBeenCalled(); expect(api.openAuthorization).not.toHaveBeenCalled()
})
it('fails readonly status safely and prevents unsigned or unavailable mutations', async () => {
  vi.mocked(api.status).mockRejectedValue(new Error('fixture failed'))
  const panel = make(); await settle(); expect(get('cp-status').textContent).toContain('读取失败')
  await click('create'); expect(api.createPrivateProject).not.toHaveBeenCalled()
  vi.mocked(api.status).mockResolvedValue(status({ configured: false })); await panel.refresh()
  expect(get('cp-create').disabled).toBe(true)
})
it('clears a previous account share link and renders returned labels only as text', async () => {
  const panel = make(); await settle(); await click('share')
  vi.mocked(api.projects).mockResolvedValue([{ handle: 'opaque', project: { id: 2, installationId: 5, owner: '<img onerror=evil>', name: '<script>evil</script>', private: true } }])
  await click('projects'); const label = get('cp-project-list').children[0]!.children[0]!
  expect(label.textContent).toContain('<script>'); expect(label.innerHTML).toBe('')
  vi.mocked(api.status).mockResolvedValue(status({ account: { id: 55, login: 'other', name: null } })); await panel.refresh()
  expect(get('cp-share-link').value).toBe(''); expect(get('cp-project-list').children).toHaveLength(0)
})
it('reconciles a committed download even when logout status arrives before its IPC response', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.downloadProject).mockReturnValue(pending.promise)
  const panel = make(); await settle(); await click('projects'); rowButton('project-list', '下载到本地').click(); await flush()
  expect(api.downloadProject).toHaveBeenCalledOnce()
  vi.mocked(api.status).mockResolvedValue(status({ signedIn: false, account: null, connection: null, autoSync: false }))
  await panel.refresh(); const committed = project('committed'); pending.resolve(committed); await settle()
  expect(adopt).toHaveBeenCalledExactlyOnceWith(committed); expect(documents.project).toBe(committed)
  expect(get('cp-create').disabled).toBe(true)
})
it('lets real Documents.adopt wait for canceled closing before reconciling the committed project', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(pending.promise)
  documents = new Documents({ setDirty: vi.fn() } as unknown as WorkspaceApi, {
    show: vi.fn(), state: vi.fn(), files: vi.fn(), project: vi.fn(), notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true), input: vi.fn().mockResolvedValue(null) })
  const original = project('original'); documents.project = original
  adopt = vi.fn(next => documents.adopt(next))
  const panel = make(); await settle(); get('cp-join').click(); await flush(); expect(api.joinProject).toHaveBeenCalledOnce()
  documents.setClosing(true); panel.setClosing(true)
  const committed = project('committed'); pending.resolve(committed); await flush()
  expect(adopt).toHaveBeenCalledExactlyOnceWith(committed); expect(documents.project).toBe(original)
  documents.edited('blocked while closing'); expect(documents.buffer.dirty).toBe(false)
  documents.setClosing(false); panel.setClosing(false); await settle()
  expect(documents.project).toBe(committed)
})
it('still rejects a committed result if the local edit version advanced even without a dirty draft', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(pending.promise)
  make(); await settle(); get('cp-join').click(); await flush(); expect(api.joinProject).toHaveBeenCalledOnce()
  documents.buffer.editVersion += 1; pending.resolve(project('committed')); await settle()
  expect(adopt).not.toHaveBeenCalled()
})
it('does not adopt a late committed result after this renderer panel was disposed', async () => {
  const pending = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(pending.promise)
  const panel = make(); await settle(); get('cp-join').click(); await flush(); expect(api.joinProject).toHaveBeenCalledOnce()
  panel.dispose(); pending.resolve(project('committed')); await settle(); expect(adopt).not.toHaveBeenCalled()
})

const longFailure = 'GitHub 拒绝创建仓库（403）。' + '请核对安装授权和账号策略；未确认实际原因。'.repeat(12) + '\n远端可能已发生变化，不要重复创建。'
async function failCreation(): Promise<CloudProjectPanel> {
  vi.mocked(api.createPrivateProject).mockRejectedValue(new Error(longFailure))
  const panel = make(); await settle(); get('cp-name').value = 'paper'; await click('create'); return panel
}
it('retains the entire multiline creation failure after timers and readonly refresh without retrying', async () => {
  const panel = await failCreation(); const detail = get('cp-error-detail')
  expect(get('cp-error').hidden).toBe(false); expect(detail.value).toBe('操作未完成：' + longFailure)
  expect(detail.readOnly).toBe(true); expect(get('cp-error').focus).toHaveBeenCalledOnce()
  expect(get('cp-message').textContent.length).toBeLessThanOrEqual(181) // Full text appears once, in the copyable field.
  expect(get('cp-message').textContent).not.toBe(detail.value)
  await vi.advanceTimersByTimeAsync(90_000); await panel.refresh()
  expect(detail.value).toBe('操作未完成：' + longFailure); expect(get('cp-error').hidden).toBe(false)
  expect(api.createPrivateProject).toHaveBeenCalledOnce()
})
it('copies details only on an explicit click, then dismisses locally without any retry', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText } })
  await failCreation(); expect(writeText).not.toHaveBeenCalled(); await click('error-copy')
  expect(writeText).toHaveBeenCalledExactlyOnceWith('操作未完成：' + longFailure)
  expect(get('cp-error-copy-status').textContent).toBe('已复制详情')
  await click('error-dismiss'); expect(get('cp-error').hidden).toBe(true); expect(get('cp-error-detail').value).toBe('')
  expect(api.createPrivateProject).toHaveBeenCalledOnce()
})
it('offers manual selection when clipboard access fails without leaking its exception', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('private clipboard failure')) } })
  await failCreation(); await click('error-copy')
  expect(get('cp-error-detail').select).toHaveBeenCalledOnce()
  expect(get('cp-error-copy-status').textContent).toBe('复制未完成，已选中全文，可手动复制。')
  expect(get('cp-error-detail').value).not.toContain('private clipboard failure')
})
it('ignores late copy feedback across project reset and blocks copying while closing', async () => {
  const pending = deferred<void>(), writeText = vi.fn().mockReturnValue(pending.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } }); const panel = await failCreation()
  get('cp-error-copy').click(); await flush(); documents.project = project('other'); panel.projectChanged()
  pending.resolve(undefined); await flush()
  expect(get('cp-error').hidden).toBe(true); expect(get('cp-error-copy-status').textContent).toBe('')
  panel.setClosing(true); get('cp-error-copy').disabled = false; get('cp-error-copy').click(); await flush()
  expect(writeText).toHaveBeenCalledOnce()
})
it('redacts credentials and renders failure content as plain readonly text, never HTML', async () => {
  vi.mocked(api.createPrivateProject).mockRejectedValue(new Error('<img onerror=evil> ghu_fixtureSecretToken'))
  make(); await settle(); get('cp-name').value = 'paper'; await click('create')
  expect(get('cp-error-detail').value).toContain('<img onerror=evil> [已隐藏凭据]')
  expect(get('cp-error-detail').innerHTML).toBe('')
})
it('provides non-ellipsized wrapping, scrollable selectable details and a multiline notice', () => {
  const cloud = readFileSync('src/renderer/cloud-project-style.css', 'utf8')
  const layout = readFileSync('src/renderer/workspace-layout-style.css', 'utf8')
  expect(cloud).toContain('#cp-error[hidden] { display: none; }')
  expect(cloud).toMatch(/#cp-error-detail \{[^}]*overflow: auto;[^}]*white-space: pre-wrap;[^}]*user-select: text;/)
  expect(layout).toMatch(/\.workbench-notice \{[^}]*text-overflow: clip; white-space: pre-wrap;/)
})
