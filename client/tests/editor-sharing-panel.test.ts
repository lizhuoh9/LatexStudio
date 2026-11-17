/// <reference lib="dom" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CloudApi, CloudWorkspaceStatus } from '../src/shared/cloud-contracts'
import type { DesktopLinksApi } from '../src/shared/desktop-links-contracts'
import type { ProjectInfo } from '../src/shared/workspace-contracts'
import { SharingPanel } from '../src/renderer/sharing-panel'
import { CollaborationModel } from '../src/renderer/collaboration-model'
import type { Documents } from '../src/renderer/documents'
import type { RunAction } from '../src/renderer/sync-panel'
import { setLocale, translate } from '../src/shared/i18n'
import { readFileSync } from 'node:fs'

class NodeMock {
  textContent = ''; value = ''; hidden = false; disabled = false; open = false; innerHTML = ''; type = ''
  dataset: Record<string, string> = {}; children: NodeMock[] = []; focus = vi.fn(); select = vi.fn()
  handlers = new Map<string, Set<(event: Event) => void>>()
  addEventListener(type: string, listener: (event: Event) => void): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: Event) => void): void { this.handlers.get(type)?.delete(listener) }
  emit(type: string, event = new Event(type, { cancelable: true })): void {
    for (const listener of this.handlers.get(type) ?? []) listener(event)
    if (type === 'close') for (const listener of documentHandlers.get(type) ?? []) listener(event)
  }
  click(): void { if (!this.disabled) this.emit('click') }
  showModal(): void { this.open = true }
  close(): void { if (this.open) { this.open = false; this.emit('close') } }
  append(...nodes: NodeMock[]): void { this.children.push(...nodes) }
  replaceChildren(...nodes: NodeMock[]): void { this.children = nodes }
  querySelectorAll(): NodeMock[] { return this.children.flatMap(node => [...(node.dataset.joinInvitation ? [node] : []), ...node.querySelectorAll()]) }
}
const nodes = new Map<string, NodeMock>(), documentHandlers = new Map<string, Set<(event: Event) => void>>()
function get(id: string): NodeMock { if (!nodes.has(id)) nodes.set(id, new NodeMock()); return nodes.get(id)! }
const project = (id: string): ProjectInfo => ({ id, name: id, root: `/fixture/${id}`, files: [], defaultMain: null })
const cloudStatus = (extra: Partial<CloudWorkspaceStatus> = {}): CloudWorkspaceStatus => ({ configured: true, signedIn: true,
  account: { id: 1, login: 'alice', name: null }, connection: { projectId: 42, owner: 'alice', name: 'paper', branch: 'main' },
  autoSync: false, lastSyncedAt: null, message: '', ...extra })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject }
}
let api: CloudApi, links: DesktopLinksApi, documents: Documents, model: CollaborationModel, actions: Promise<void>[]
let emitLink: (link: string) => void, allowed: boolean
let adopt: ReturnType<typeof vi.fn<(next: ProjectInfo) => Promise<void>>>, login: ReturnType<typeof vi.fn<() => void>>, setup: ReturnType<typeof vi.fn<() => void>>
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>, cancel: ReturnType<typeof vi.fn<() => Promise<unknown>>>
const panels: SharingPanel[] = []
function receiveAccount(id: number | null): void {
  model.receive({ phase: id ? 'signed-in' : 'signed-out', account: id ? { id, login: `user${id}`, name: '分享' } : null,
    authorization: null, expiresAt: id ? Date.now() + 3600000 : null, sessionOnly: true, message: '' })
}
beforeEach(() => {
  nodes.clear(); documentHandlers.clear(); actions = []; allowed = true; setLocale('zh-CN')
  vi.stubGlobal('document', { getElementById: get, createElement: () => new NodeMock(),
    querySelector: () => [...nodes.values()].find(node => node.open) ?? null,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (!documentHandlers.has(type)) documentHandlers.set(type, new Set()); documentHandlers.get(type)!.add(listener)
    }, removeEventListener: (type: string, listener: (event: Event) => void) => documentHandlers.get(type)?.delete(listener) })
  clipboard = vi.fn(async (_text: string) => undefined); vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } })
  api = { status: vi.fn().mockResolvedValue(cloudStatus()), openAuthorization: vi.fn().mockResolvedValue(undefined),
    openInvitations: vi.fn().mockResolvedValue(undefined), projects: vi.fn().mockResolvedValue([]),
    createPrivateProject: vi.fn(), linkProject: vi.fn(), downloadProject: vi.fn(), joinProject: vi.fn().mockResolvedValue(project('joined')),
    shareProject: vi.fn().mockResolvedValue('https://github.com/alice/paper'), inviteCollaborator: vi.fn().mockResolvedValue({ message: '邀请已发送' }),
    invitations: vi.fn().mockResolvedValue([]), acceptInvitation: vi.fn().mockResolvedValue({ message: '邀请已接受' }), sync: vi.fn(), setAutoSync: vi.fn() }
  emitLink = () => undefined
  links = { pending: vi.fn().mockResolvedValue(null), acknowledge: vi.fn().mockResolvedValue(undefined),
    onLink: vi.fn(listener => { emitLink = listener; return vi.fn() }) }
  model = new CollaborationModel(true); receiveAccount(1)
  documents = { project: project('original'), buffer: { path: 'main.tex', dirty: false, conflict: false, editVersion: 1 },
    save: vi.fn().mockResolvedValue(true) } as unknown as Documents
  adopt = vi.fn(async next => { documents.project = next }); login = vi.fn(); setup = vi.fn(); cancel = vi.fn(async () => undefined)
})
afterEach(() => { for (const panel of panels.splice(0)) panel.dispose(); setLocale('zh-CN'); vi.unstubAllGlobals() })
function make(bridge: CloudApi | undefined = api): SharingPanel {
  const run: RunAction = (_label, action) => { if (allowed) actions.push(action()) }
  const panel = new SharingPanel(bridge, links, documents, model, run, adopt, login, setup, () => allowed, cancel)
  panels.push(panel); return panel
}
async function flush(): Promise<void> { for (let i = 0; i < 40; i++) await Promise.resolve() }
async function settle(): Promise<void> { await flush(); while (actions.length) await Promise.all(actions.splice(0)); await flush() }
function input(link = 'latexstudio://join/alice/paper'): void { get('join-link').value = link; get('join-link').emit('input') }

it('initializes without any cloud, login, download, clipboard or repository write', async () => {
  make(); await settle()
  expect(api.status).not.toHaveBeenCalled(); expect(api.projects).not.toHaveBeenCalled(); expect(api.joinProject).not.toHaveBeenCalled()
  expect(api.createPrivateProject).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled(); expect(clipboard).not.toHaveBeenCalled()
})
it('explicit Share reveals a validated same-repository app link without another create or upload', async () => {
  const panel = make(); panel.openShare(); await settle()
  expect(get('share-dialog').open).toBe(true); expect(get('share-ready').hidden).toBe(false)
  expect(get('share-link').value).toBe('latexstudio://join/alice/paper'); expect(api.shareProject).toHaveBeenCalledOnce()
  expect(api.projects).not.toHaveBeenCalled(); expect(api.createPrivateProject).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled()
})
it('keeps setup available for an unlinked project and does not invent a sharing link', async () => {
  vi.mocked(api.status).mockResolvedValue(cloudStatus({ connection: null })); const panel = make(); panel.openShare(); await settle()
  expect(api.shareProject).not.toHaveBeenCalled(); expect(get('share-link').value).toBe(''); expect(get('share-setup').hidden).toBe(false)
  get('share-setup').click(); expect(setup).toHaveBeenCalledOnce(); expect(get('share-dialog').open).toBe(false)
})
it.each(['https://github.com/bob/other', 'https://elsewhere.invalid/alice/paper', 'https://github.com/alice/paper?secret=CANARY'])('rejects mismatched or invalid share response %s', async source => {
  vi.mocked(api.shareProject).mockResolvedValue(source); const panel = make(); panel.openShare(); await settle()
  expect(get('share-link').value).toBe(''); expect(get('share-ready').hidden).toBe(true); expect(get('share-error').hidden).toBe(false)
  expect(get('share-error').value).not.toContain('CANARY')
})
it('copies only on explicit click and selects the link if clipboard access is denied', async () => {
  const panel = make(); panel.openShare(); await settle(); expect(clipboard).not.toHaveBeenCalled()
  get('share-copy').click(); await settle(); expect(clipboard).toHaveBeenCalledExactlyOnceWith('latexstudio://join/alice/paper')
  clipboard.mockRejectedValue(new Error('private clipboard diagnostic')); get('share-copy').click(); await settle()
  expect(get('share-link').select).toHaveBeenCalled(); expect(get('share-copy-status').textContent).toContain('手动复制')
  expect(get('share-copy-status').textContent).not.toContain('private clipboard')
})
it('ignores clipboard completion from a closed and reopened sharing dialog', async () => {
  const result = deferred<void>(); clipboard.mockReturnValue(result.promise)
  const panel = make(); panel.openShare(); await settle(); get('share-copy').click(); get('share-close').click()
  panel.openShare(); await settle(); result.resolve(); await flush()
  expect(get('share-copy-status').textContent).toBe('')
})
it('invalidates delayed sharing reads after project replacement', async () => {
  const result = deferred<string>(); vi.mocked(api.shareProject).mockReturnValue(result.promise)
  const panel = make(); panel.openShare(); await flush(); documents.project = project('different'); panel.projectChanged()
  result.resolve('https://github.com/alice/paper'); await settle()
  expect(get('share-link').value).toBe(''); expect(get('share-dialog').open).toBe(false)
})
it('requires an explicit login and resumes only the requested share after account verification', async () => {
  receiveAccount(null); const panel = make(); panel.openShare(); await settle(); expect(api.status).not.toHaveBeenCalled()
  get('share-sign-in').click(); expect(login).toHaveBeenCalledOnce(); expect(get('share-dialog').open).toBe(false)
  receiveAccount(2); panel.accountChanged(); await settle(); expect(get('share-ready').hidden).toBe(false)
})
it('does not consume a pending URI until ready and interactive, and never downloads from it automatically', async () => {
  allowed = false; const panel = make(); emitLink('latexstudio://join/alice/paper'); panel.markReady(); await settle()
  expect(get('join-dialog').open).toBe(false); expect(links.acknowledge).not.toHaveBeenCalled()
  allowed = true; panel.flushPending(); await settle()
  expect(get('join-dialog').open).toBe(true); expect(get('join-link').value).toBe('latexstudio://join/alice/paper')
  expect(links.acknowledge).toHaveBeenCalledExactlyOnceWith('latexstudio://join/alice/paper'); expect(api.joinProject).not.toHaveBeenCalled(); expect(login).not.toHaveBeenCalled()
})
it('retains the newest intake instead of overwriting it with an older pending response', async () => {
  const initial = deferred<string | null>(); vi.mocked(links.pending).mockReturnValue(initial.promise)
  const panel = make(); emitLink('latexstudio://join/alice/latest'); initial.resolve('latexstudio://join/alice/old'); await flush(); panel.markReady()
  expect(get('join-link').value).toBe('latexstudio://join/alice/latest'); expect(api.joinProject).not.toHaveBeenCalled()
})
it('defers intake while another modal is open and invalid URI has no effect', async () => {
  const panel = make(); panel.markReady(); get('cloud-dialog').showModal(); emitLink('latexstudio://join/alice/paper'); await flush()
  expect(get('join-dialog').open).toBe(false); get('cloud-dialog').close(); await settle(); expect(get('join-dialog').open).toBe(true)
  emitLink('javascript:alert(1)'); expect(api.joinProject).not.toHaveBeenCalled()
})
it('joins the exact original repository only after explicit download, and adopts committed ProjectInfo', async () => {
  const panel = make(); panel.openJoin(); input(); await flush(); expect(api.joinProject).not.toHaveBeenCalled()
  get('join-download').click(); await settle()
  expect(api.joinProject).toHaveBeenCalledExactlyOnceWith('latexstudio://join/alice/paper')
  expect(adopt).toHaveBeenCalledExactlyOnceWith(project('joined')); expect(get('join-dialog').open).toBe(false)
  expect(api.createPrivateProject).not.toHaveBeenCalled(); expect(api.linkProject).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled()
})
it('keeps the current workspace when the native folder chooser is canceled', async () => {
  vi.mocked(api.joinProject).mockResolvedValue(null); const panel = make(); panel.openJoin(); input(); get('join-download').click(); await settle()
  expect(adopt).not.toHaveBeenCalled(); expect(documents.project?.id).toBe('original'); expect(get('join-dialog').open).toBe(true)
})
it('does not download when saving a dirty draft fails', async () => {
  Object.assign(documents.buffer, { dirty: true }); vi.mocked(documents.save).mockResolvedValue(false)
  const panel = make(); panel.openJoin(); input(); get('join-download').click(); await settle()
  expect(api.joinProject).not.toHaveBeenCalled(); expect(adopt).not.toHaveBeenCalled(); expect(documents.buffer.dirty).toBe(true)
  expect(get('join-error').value).toContain('草稿已保留')
})
it('keeps a newer dirty draft instead of replacing it with a late project response', async () => {
  const result = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(result.promise)
  const panel = make(); panel.openJoin(); input(); get('join-download').click(); await flush()
  Object.assign(documents.buffer, { dirty: true, editVersion: 2 }); result.resolve(project('joined')); await settle()
  expect(adopt).not.toHaveBeenCalled(); expect(documents.buffer.dirty).toBe(true)
})
it('reconciles an unchanged buffer after Main commit even if account and close epochs changed meanwhile', async () => {
  const result = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(result.promise)
  const panel = make(); panel.openJoin(); input(); get('join-download').click(); await flush()
  panel.setClosing(true); receiveAccount(null); panel.accountChanged(); result.resolve(project('joined')); await settle()
  expect(adopt).toHaveBeenCalledExactlyOnceWith(project('joined'))
})
it('locks link mutation and modal escape during download, but offers explicit transfer cancellation', async () => {
  const result = deferred<ProjectInfo | null>(); vi.mocked(api.joinProject).mockReturnValue(result.promise)
  const panel = make(); panel.openJoin(); input(); get('join-download').click(); await flush()
  expect(get('join-link').disabled).toBe(true); expect(get('join-close').disabled).toBe(true)
  const event = new Event('cancel', { cancelable: true }); get('join-dialog').emit('cancel', event); expect(event.defaultPrevented).toBe(true)
  expect(get('join-cancel-transfer').hidden).toBe(false); get('join-cancel-transfer').click(); await flush(); expect(cancel).toHaveBeenCalledOnce()
  result.resolve(null); await settle(); expect(get('join-link').disabled).toBe(false); expect(adopt).not.toHaveBeenCalled()
})
it('shows only invitations matching the pasted repository and accepts only an explicit valid row', async () => {
  vi.mocked(api.invitations).mockResolvedValue([{ handle: 'wanted', owner: 'alice', name: 'paper', inviter: 'alice' },
    { handle: 'other', owner: 'bob', name: 'private-other', inviter: 'bob' }])
  const panel = make(); panel.openJoin(); input(); get('join-invitations').click(); await settle()
  expect(get('join-invitation-list').children).toHaveLength(1)
  const button = get('join-invitation-list').querySelectorAll()[0]!; button.click(); await settle()
  expect(api.acceptInvitation).toHaveBeenCalledExactlyOnceWith('wanted'); expect(api.joinProject).not.toHaveBeenCalled()
})
it('ignores a stale invitation row after switching to a different link', async () => {
  vi.mocked(api.invitations).mockResolvedValue([{ handle: 'wanted', owner: 'alice', name: 'paper', inviter: 'alice' }])
  const panel = make(); panel.openJoin(); input(); get('join-invitations').click(); await settle()
  const button = get('join-invitation-list').querySelectorAll()[0]!; input('latexstudio://join/bob/other'); button.click(); await settle()
  expect(api.acceptInvitation).not.toHaveBeenCalled()
})
it('keeps user project names and repository coordinates literal in another interface language', async () => {
  setLocale('en'); documents.project = { ...project('original'), name: '分享 <img src=x>' }
  const panel = make(); panel.openShare(); await settle()
  expect(get('share-project-name').textContent).toBe('分享 <img src=x>'); expect(get('share-link').value).toBe('latexstudio://join/alice/paper')
})
it.each(['en', 'ko'] as const)('covers all owned sharing captions and accessibility text in %s', locale => {
  const source = readFileSync('src/renderer/sharing-panel.ts', 'utf8'), template = source.split('const TEMPLATE = `')[1]!.split('`')[0]!
  const captions = [...template.matchAll(/>([^<>]+)</g)].map(match => match[1]!.trim())
  captions.push(...[...template.matchAll(/(?:aria-label|placeholder)="([^"]+)"/g)].map(match => match[1]!))
  const ownText = captions.filter(value => /[㐀-鿿]/.test(value)); expect(ownText.length).toBeGreaterThan(15)
  for (const value of ownText) expect(translate(value, locale), value).not.toMatch(/[㐀-鿿]/)
})
it('declares only the fixed project-link OS scheme in installer metadata', () => {
  const config = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { protocols: unknown } }
  expect(config.build.protocols).toEqual([{ name: 'LatexStudio project links', schemes: ['latexstudio'] }])
})
it('forgets a login abandoned by closing the account dialog, so a later unrelated login opens nothing', async () => {
  receiveAccount(null); const panel = make(); panel.openJoin(); await settle(); get('join-sign-in').click()
  get('cloud-dialog').showModal(); get('cloud-dialog').close() // closed without signing in
  receiveAccount(2); panel.accountChanged(); await settle()
  expect(get('join-dialog').open).toBe(false); expect(api.joinProject).not.toHaveBeenCalled(); expect(api.projects).not.toHaveBeenCalled()
})
it('downloads one chosen cloud paper through the ordinary guarded join, only from that explicit request', async () => {
  const panel = make(); panel.downloadFrom('https://github.com/alice/paper'); await settle()
  expect(api.joinProject).toHaveBeenCalledExactlyOnceWith('latexstudio://join/alice/paper'); expect(get('join-repository').textContent).toBe('alice/paper')
  expect(adopt).toHaveBeenCalledExactlyOnceWith(project('joined')); expect(get('join-dialog').open).toBe(false)
  expect(api.projects).not.toHaveBeenCalled(); expect(api.downloadProject).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled()
})
it('does not start a chosen cloud download while signed out, busy, blocked by another dialog or for an invalid target', async () => {
  const panel = make(); panel.downloadFrom('https://elsewhere.invalid/alice/paper'); await settle(); expect(api.joinProject).not.toHaveBeenCalled()
  get('join-close').click(); get('cloud-dialog').showModal(); panel.downloadFrom('https://github.com/alice/paper'); await settle()
  expect(get('join-dialog').open).toBe(false); expect(api.joinProject).not.toHaveBeenCalled(); get('cloud-dialog').close()
  allowed = false; panel.downloadFrom('https://github.com/alice/paper'); await settle(); expect(api.joinProject).not.toHaveBeenCalled(); allowed = true
  receiveAccount(null); panel.accountChanged(); panel.downloadFrom('https://github.com/alice/paper'); await settle()
  expect(get('join-dialog').open).toBe(true); expect(get('join-status').textContent).toContain('登录'); expect(api.joinProject).not.toHaveBeenCalled()
  Object.assign(documents.buffer, { dirty: true }); vi.mocked(documents.save).mockResolvedValue(false); receiveAccount(1); panel.accountChanged()
  get('join-close').click(); panel.downloadFrom('https://github.com/alice/paper'); await settle()
  expect(api.joinProject).not.toHaveBeenCalled(); expect(get('join-error').value).toContain('草稿已保留')
})
it('keeps all actions inert after dispose and does not acknowledge a late pending result', async () => {
  const initial = deferred<string | null>(); vi.mocked(links.pending).mockReturnValue(initial.promise)
  const panel = make(); panel.markReady(); panel.dispose(); initial.resolve('latexstudio://join/alice/paper'); emitLink('latexstudio://join/alice/paper'); await settle()
  expect(get('join-dialog').open).toBe(false); expect(links.acknowledge).not.toHaveBeenCalled(); expect(api.joinProject).not.toHaveBeenCalled()
})
