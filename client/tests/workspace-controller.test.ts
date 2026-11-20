import type { BrowserWindow } from 'electron'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshot, ProjectInfo } from '../src/shared/workspace-contracts'
import type { ProjectLibraryEntry } from '../src/shared/project-library-contracts'
import type { GitHubAccountService } from '../src/main/collaboration/service'
import { PROJECT_LIBRARY_CHANNELS as P } from '../src/shared/project-library-contracts'
import { WORKSPACE_CHANNELS as C } from '../src/shared/workspace-contracts'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>
type Message = (event: unknown, ...args: unknown[]) => void
const st = vi.hoisted(() => ({
  handles: new Map<string, Handler>(), events: new Map<string, Message>(),
  frame: { url: 'file:///app/workspace.html' }, select: vi.fn(), prompt: vi.fn(), send: vi.fn(),
  load: vi.fn(), save: vi.fn(), compile: vi.fn(), cancel: vi.fn(), dispose: vi.fn(),
  environment: vi.fn(), enabled: vi.fn(), rendererDirty: false, autoAck: true,
  versions: vi.fn(), versionDetail: vi.fn(), prepare: vi.fn(), beforeInitialize: vi.fn(), network: vi.fn(),
  remember: vi.fn(), binding: vi.fn(), saveAs: vi.fn(), fingerprint: vi.fn(),
  failRoot: '', failWatch: '', watchers: [] as Array<{ root: string; listener: (paths: string[]) => void }>
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/fixture/${name}` },
  ipcMain: {
    handle: (channel: string, handler: Handler) => st.handles.set(channel, handler),
    on: (channel: string, handler: Message) => st.events.set(channel, handler)
  },
  dialog: { showOpenDialog: st.select, showMessageBox: st.prompt, showSaveDialog: st.saveAs }
}))

vi.mock('../src/main/local/network', () => ({ isNetworkProject: st.network }))

vi.mock('../src/main/local/project', () => ({
  ProjectService: class {
    constructor(private root: string) {}
    async initialize() {
      await st.beforeInitialize(this.root)
      if (this.root === st.failRoot) throw new Error('项目无法打开。')
      return { id: this.root, name: this.root, root: this.root, files: [], defaultMain: 'main.tex' }
    }
    async list() { return [] }
    async fingerprint() { return st.fingerprint(this.root) }
    async read(path: string) { return { path, content: 'text', revision: 'old' } }
    save(path: string, content: string, revision: string, options?: unknown) {
      return options ? st.save(path, content, revision, options) : st.save(path, content, revision)
    }
    async create(path: string, content: string) { return { path, content, revision: 'new' } }
    watch(listener: (paths: string[]) => void) {
      if (this.root === st.failWatch) throw new Error('无法观察文件。')
      st.watchers.push({ root: this.root, listener })
      return () => undefined
    }
    dispose() { st.dispose() }
  }
}))

vi.mock('../src/main/workspace/versions', () => ({
  WorkspaceVersions: class {
    journal = { prepare: st.prepare }
    list() { return st.versions() }
    detail(id: string) { return st.versionDetail(id) }
  }
}))

vi.mock('../src/main/workspace/project-library', () => ({
  projectIdForRoot: (root: string) => `project:${root}`,
  ProjectLibrary: class {
    entries = new Map<string, ProjectLibraryEntry>()
    async list() { return [...this.entries.values()] }
    async remember(info: ProjectInfo) {
      await st.remember(info)
      const id = `project:${info.root}`
      this.entries.set(id, { id, name: info.name, root: info.root, lastOpenedAt: '2026-11-13T00:00:00.000Z' })
      return id
    }
    async resolve(id: string) {
      const entry = this.entries.get(id)
      if (!entry) throw new Error('未找到已添加的项目。')
      return entry
    }
    async forget(id: string) { this.entries.delete(id) }
  }
}))
vi.mock('../src/main/github/cloud-binding', async original => ({
  ...await original<typeof import('../src/main/github/cloud-binding')>(), readCloudBinding: st.binding
}))

vi.mock('../src/main/tex/compiler', () => ({
  detectTexEnvironment: (...args: unknown[]) => st.environment(...args),
  LocalCompiler: class {
    run(request: unknown) { return st.compile(request) }
    cancel() { st.cancel() }
    dispose() { st.dispose() }
  }
}))

vi.mock('../src/main/github/credentials', () => ({ CredentialVault: class {} }))
vi.mock('../src/main/github/repository', () => ({
  GitHubRepository: class {
    async status() { return { connection: null, changes: [], message: '', conflict: false } }
    async connect(settings: { token: string }) { throw new Error(`fixture error ${settings.token}`) }
    async clone() { return undefined }
    async disconnect() { return undefined }
    async snapshot() { return null }
    async sync() { return undefined }
    async history() { return [] }
  }
}))

import { WorkspaceController } from '../src/main/workspace/controller'

function sender() { return { sender: { id: 19 }, senderFrame: st.frame } }
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = st.handles.get(channel)
  if (!handler) throw new Error('Missing handler')
  return handler(sender(), ...args)
}
function dirty(value: boolean): void { st.rendererDirty = value; st.events.get(C.dirty)?.(sender(), value) }
function select(root: string): void { st.select.mockResolvedValueOnce({ canceled: false, filePaths: [root] }) }
async function controller(account?: GitHubAccountService): Promise<WorkspaceController> {
  const window = {
    isDestroyed: () => false, loadURL: st.load, setEnabled: st.enabled,
    webContents: { id: 19, mainFrame: st.frame, send: st.send }
  } as unknown as BrowserWindow
  const result = new WorkspaceController(window, st.frame.url, '/fixture/data', undefined, account)
  await result.initialize()
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  st.handles.clear(); st.events.clear(); st.watchers.length = 0
  st.frame.url = 'file:///app/workspace.html'; st.failRoot = ''; st.failWatch = ''
  st.select.mockReset().mockResolvedValue({ canceled: true, filePaths: [] })
  st.prompt.mockReset().mockResolvedValue({ response: 0 })
  st.load.mockResolvedValue(undefined)
  st.beforeInitialize.mockReset().mockResolvedValue(undefined)
  st.network.mockReset().mockResolvedValue(false)
  st.remember.mockReset().mockResolvedValue(undefined)
  st.binding.mockReset().mockResolvedValue(null)
  st.saveAs.mockReset().mockResolvedValue({ canceled: true })
  st.fingerprint.mockReset().mockResolvedValue('sources-1')
  st.rendererDirty = false; st.autoAck = true
  st.environment.mockReset().mockResolvedValue({ available: false, engines: [], description: 'fixture' })
  st.send.mockImplementation((_channel: string, event: { kind: string; requestId?: string }) => {
    if (event.kind === 'close-request' && st.autoAck) {
      queueMicrotask(() => st.events.get(C.closeAck)?.(sender(), event.requestId, st.rendererDirty))
    }
  })
  st.save.mockReset().mockImplementation(async (path: string, content: string) => ({ path, content, revision: 'new' }))
  st.compile.mockReset().mockResolvedValue({ ok: true, canceled: false, log: '', pdf: null, durationMs: 1 })
  st.versions.mockReset().mockResolvedValue([])
  st.versionDetail.mockReset().mockResolvedValue({
    entry: { id: 'version', path: 'main.tex', author: 'User A', date: '2026-11-13T00:00:00.000Z' },
    before: 'before', after: 'historical'
  })
})

describe('trusted local workspace integration', () => {
  it('starts empty without opening any files or network projects', async () => {
    await controller()
    expect(await invoke(C.project)).toBeNull()
    expect(await invoke(C.repository)).toMatchObject({ connection: null, changes: [] })
    expect(await invoke(C.history)).toEqual([])
    expect(await invoke(C.revisions)).toEqual([])
    expect(st.select).not.toHaveBeenCalled()
    expect(await invoke(P.list)).toEqual({ projects: [], activeId: null })
  })

  it('rejects a foreign window, a child frame and a changed URL', async () => {
    await controller()
    const handler = st.handles.get(C.project)!
    await expect(handler({ ...sender(), sender: { id: 9 } })).rejects.toThrow('不能访问')
    await expect(handler({ ...sender(), senderFrame: { ...st.frame } })).rejects.toThrow('不能访问')
    st.frame.url = 'https://example.invalid/'
    await expect(handler(sender())).rejects.toThrow('不能访问')
  })

  it('keeps the active project when a replacement cannot initialize or watch', async () => {
    await controller(); select('old'); await invoke(C.open)
    st.failRoot = 'broken'; select('broken')
    await expect(invoke(C.open)).rejects.toThrow('项目无法打开')
    expect(await invoke(C.project)).toMatchObject({ root: 'old' })
    st.failWatch = 'unwatched'; select('unwatched')
    await expect(invoke(C.open)).rejects.toThrow('无法观察文件')
    expect(await invoke(C.project)).toMatchObject({ root: 'old' })
  })

  it('keeps Main on the old root when the account changes during asynchronous activation', async () => {
    const app = await controller(); select('old'); await invoke(C.open)
    let release!: () => void, active = true
    const gate = new Promise<void>(resolve => { release = resolve })
    st.beforeInitialize.mockImplementation((root: string) => root === 'next' ? gate : Promise.resolve())
    const activate = app as unknown as { activate(root: string, signal: AbortSignal, verify: () => void): Promise<unknown> }
    const switching = activate.activate('next', new AbortController().signal, () => {
      if (!active) throw new Error('登录会话已变化')
    })
    await vi.waitFor(() => expect(st.beforeInitialize).toHaveBeenCalledWith('next'))
    active = false; release()
    await expect(switching).rejects.toThrow('登录会话已变化')
    expect(await invoke(C.project)).toMatchObject({ root: 'old' })
  })

  it('rejects retired NAS roots before creating files or replacing the active workspace', async () => {
    await controller(); select('old'); await invoke(C.open)
    st.beforeInitialize.mockClear(); st.prepare.mockClear()
    st.network.mockResolvedValue(true)
    select('network')
    await expect(invoke(C.open)).rejects.toThrow('已停用 NAS')
    expect(st.beforeInitialize).not.toHaveBeenCalled()
    expect(st.prepare).not.toHaveBeenCalled()
    expect(await invoke(C.project)).toMatchObject({ root: 'old' })
    st.beforeInitialize.mockClear(); select('network')
    await expect(invoke(C.create)).rejects.toThrow('原目录及历史未修改')
    expect(st.beforeInitialize).not.toHaveBeenCalled()
    expect(st.prepare).not.toHaveBeenCalled()
  })

  it('does not register retired NAS presence or active-file IPC', async () => {
    await controller()
    expect(st.events.has('workspace:active-file')).toBe(false)
    expect(st.send).not.toHaveBeenCalledWith(C.event, expect.objectContaining({ kind: 'presence' }))
  })

  it('filters stale watcher events after switching projects', async () => {
    await controller(); select('old'); await invoke(C.open)
    const old = st.watchers[0]!
    select('new'); await invoke(C.open)
    old.listener(['private.tex'])
    expect(st.send).not.toHaveBeenCalledWith(C.event, expect.anything())
    st.watchers[1]!.listener(['main.tex'])
    expect(st.send).toHaveBeenCalledWith(C.event, { kind: 'files-changed', paths: ['main.tex'] })
  })

  it('never clears dirty edits merely because an earlier save finished', async () => {
    const app = await controller(); select('old'); await invoke(C.open)
    let finish!: (value: DocumentSnapshot) => void
    st.save.mockImplementation(() => new Promise<DocumentSnapshot>(resolve => { finish = resolve }))
    dirty(true)
    const saving = invoke(C.save, 'main.tex', 'saved', 'old')
    dirty(true)
    finish({ path: 'main.tex', content: 'saved', revision: 'new' })
    await saving
    expect(await app.requestClose()).toBe(false)
    expect(st.prompt).toHaveBeenCalled()
  })

  it('blocks history and compilation until unsaved edits are saved', async () => {
    await controller(); select('old'); await invoke(C.open); dirty(true)
    await expect(invoke(C.snapshot, 'Version')).rejects.toThrow('先保存')
    await expect(invoke(C.compile, { mainFile: 'main.tex', engine: 'pdflatex' })).rejects.toThrow('先保存')
    expect(st.compile).not.toHaveBeenCalled()
  })

  it('saves only Main\'s own last successful PDF to the path chosen in the native dialog', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'latexstudio-pdf-'))
    try {
      await controller(); select('old'); await invoke(C.open)
      await expect(invoke(C.savePdf)).rejects.toThrow('还没有编译成功的 PDF')
      st.compile.mockResolvedValueOnce({ ok: false, canceled: false, log: 'failed', pdf: null, durationMs: 1 })
      await invoke(C.compile, { mainFile: 'chapters/thesis.tex', engine: 'pdflatex' })
      await expect(invoke(C.savePdf)).rejects.toThrow('还没有编译成功的 PDF')
      st.compile.mockResolvedValueOnce({ ok: true, canceled: false, log: '', pdf: new Uint8Array([37, 80, 68, 70]), durationMs: 1 })
      await invoke(C.compile, { mainFile: 'chapters/thesis.tex', engine: 'pdflatex' })
      expect(await invoke(C.savePdf)).toEqual({ saved: false })
      expect(st.saveAs).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        defaultPath: join('/fixture/downloads', 'thesis.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] }))
      const target = join(folder, 'chosen.pdf')
      st.saveAs.mockResolvedValueOnce({ canceled: false, filePath: target })
      expect(await invoke(C.savePdf)).toEqual({ saved: true, path: target, stale: false })
      expect([...await readFile(target)]).toEqual([37, 80, 68, 70])
      expect(st.saveAs).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ defaultPath: join('/fixture/downloads', 'thesis.pdf') }))
      st.fingerprint.mockResolvedValue('sources-2')
      st.saveAs.mockResolvedValueOnce({ canceled: false, filePath: target })
      expect(await invoke(C.savePdf)).toMatchObject({ saved: true, stale: true })
      expect(st.saveAs).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ defaultPath: join(folder, 'thesis.pdf') }))
      await expect(invoke(C.savePdf, 'C:/elsewhere/evil.pdf')).rejects.toThrow('不接受路径')
      select('beta'); await invoke(C.open)
      await expect(invoke(C.savePdf)).rejects.toThrow('还没有编译成功的 PDF')
    } finally { await rm(folder, { recursive: true, force: true }) }
  })

  it('prevents closing or switching while a compile is running, but permits cancellation', async () => {
    const app = await controller(); select('old'); await invoke(C.open)
    let finish!: (value: unknown) => void
    st.compile.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const running = invoke(C.compile, { mainFile: 'main.tex', engine: 'pdflatex' })
    await expect(invoke(C.open)).rejects.toThrow('上一项操作')
    expect(await app.requestClose()).toBe(false)
    await invoke(C.cancelCompile)
    expect(st.cancel).toHaveBeenCalledOnce()
    finish({ ok: false, canceled: true, log: '', pdf: null, durationMs: 1 })
    await running
  })

  it('requires native confirmation before abandoning an unsaved buffer', async () => {
    await controller(); select('old'); await invoke(C.open); dirty(true)
    select('new')
    expect(await invoke(C.open)).toBeNull()
    expect(await invoke(C.project)).toMatchObject({ root: 'old' })
  })

  it('coalesces environmental probes and preserves new edits while close awaits cleanup', async () => {
    const app = await controller()
    let finish!: (value: unknown) => void
    st.environment.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = invoke(C.environment)
    const second = invoke(C.environment)
    expect(st.environment).toHaveBeenCalledOnce()
    const closing = app.requestClose()
    await vi.waitFor(() => expect((st.environment.mock.calls[0]![0] as AbortSignal).aborted).toBe(true))
    await expect(invoke(C.open)).rejects.toThrow('确认关闭')
    dirty(true)
    finish({ available: false, engines: [], description: 'fixture' })
    await Promise.all([first, second])
    expect(await closing).toBe(false)
    expect(st.dispose).not.toHaveBeenCalled()
    expect(st.enabled).toHaveBeenLastCalledWith(true)
  })

  it('refuses closing if the renderer never acknowledges its draft state', async () => {
    vi.useFakeTimers()
    try {
      const app = await controller(); st.autoAck = false
      const closing = app.requestClose()
      await vi.advanceTimersByTimeAsync(5000)
      expect(await closing).toBe(false)
      expect(st.enabled).toHaveBeenLastCalledWith(true)
      expect(st.send).toHaveBeenLastCalledWith(C.event, { kind: 'close-state', closing: false })
    } finally { vi.useRealTimers() }
  })

  it('accepts only the matching trusted-frame close acknowledgement', async () => {
    const app = await controller(); st.autoAck = false
    const closing = app.requestClose()
    const request = st.send.mock.calls.at(-1)![1] as { requestId: string }
    const ack = st.events.get(C.closeAck)!
    ack(sender(), 'wrong-nonce', false)
    ack({ ...sender(), sender: { id: 77 } }, request.requestId, false)
    await expect(invoke(C.project)).rejects.toThrow('确认关闭')
    ack(sender(), request.requestId, false)
    expect(await closing).toBe(true)
  })

  it('lists versions and restores only after native confirmation with CAS and a new restore record', async () => {
    await controller(); select('old'); await invoke(C.open)
    st.versions.mockResolvedValue([{ id: 'version' }])
    expect(await invoke(C.revisions)).toEqual([{ id: 'version' }])
    expect(await invoke(C.revisionDetail, 'version')).toMatchObject({ after: 'historical' })
    st.prompt.mockResolvedValueOnce({ response: 1 })
    expect(await invoke(C.restoreRevision, 'version', 'old')).toMatchObject({ content: 'historical' })
    expect(st.save).toHaveBeenCalledWith('main.tex', 'historical', 'old',
      { kind: 'restore', summary: '回退至 version' })
    expect(st.send).toHaveBeenCalledWith(C.event, { kind: 'files-changed', paths: ['main.tex'] })
  })

  it('rejects dirty drafts, stale target revisions and canceled restores without saving', async () => {
    await controller(); select('old'); await invoke(C.open)
    dirty(true)
    await expect(invoke(C.restoreRevision, 'version', 'old')).rejects.toThrow('先保存')
    dirty(false)
    await expect(invoke(C.restoreRevision, 'version', 'stale')).rejects.toThrow('回退冲突')
    await expect(invoke(C.restoreRevision, 'version', 'old')).rejects.toThrow('取消回退')
    expect(st.save).not.toHaveBeenCalled()
  })

  it('rechecks draft epoch after restore confirmation even when the final dirty flag is false', async () => {
    await controller(); select('old'); await invoke(C.open)
    st.prompt.mockImplementationOnce(async () => { dirty(true); dirty(false); return { response: 1 } })
    await expect(invoke(C.restoreRevision, 'version', 'old')).rejects.toThrow('草稿状态已变化')
    expect(st.save).not.toHaveBeenCalled()
  })

  it('retains concurrent external-change errors after restore confirmation', async () => {
    await controller(); select('old'); await invoke(C.open)
    st.prompt.mockResolvedValueOnce({ response: 1 })
    st.save.mockRejectedValueOnce(new Error('保存冲突'))
    await expect(invoke(C.restoreRevision, 'version', 'old')).rejects.toThrow('保存冲突')
  })

  it('remembers multiple project folders and switches only by registered id', async () => {
    await controller(); select('alpha'); await invoke(C.open); select('beta'); await invoke(C.open)
    expect(await invoke(P.list)).toMatchObject({ activeId: 'project:beta',
      projects: [{ root: 'alpha' }, { root: 'beta' }] })
    expect(await invoke(P.activate, 'project:alpha')).toMatchObject({ root: 'alpha' })
    expect(await invoke(C.project)).toMatchObject({ root: 'alpha' })
    await expect(invoke(P.activate, 'C:/unregistered')).rejects.toThrow('未找到')
    expect(await invoke(C.project)).toMatchObject({ root: 'alpha' })
  })

  it('blocks project switches with dirty drafts or an active operation', async () => {
    await controller(); select('alpha'); await invoke(C.open); select('beta'); await invoke(C.open)
    dirty(true)
    await expect(invoke(P.activate, 'project:alpha')).rejects.toThrow('先保存')
    expect(await invoke(C.project)).toMatchObject({ root: 'beta' })
    dirty(false)
    let finish!: (value: unknown) => void
    st.compile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const compiling = invoke(C.compile, { mainFile: 'main.tex', engine: 'pdflatex' })
    await expect(invoke(P.activate, 'project:alpha')).rejects.toThrow('上一项操作')
    finish({ ok: true, canceled: false, log: '', pdf: null, durationMs: 1 }); await compiling
  })

  it('does not switch the workspace when remembering its metadata fails', async () => {
    await controller(); select('alpha'); await invoke(C.open)
    st.remember.mockRejectedValueOnce(new Error('项目列表无法保存'))
    select('beta'); await expect(invoke(C.open)).rejects.toThrow('无法保存')
    expect(await invoke(C.project)).toMatchObject({ root: 'alpha' })
  })

  it('forgets an inactive entry without reinitializing or deleting its project', async () => {
    await controller(); select('alpha'); await invoke(C.open); select('beta'); await invoke(C.open)
    st.beforeInitialize.mockClear()
    expect(await invoke(P.forget, 'project:alpha')).toMatchObject({ activeId: 'project:beta', projects: [{ root: 'beta' }] })
    expect(st.beforeInitialize).not.toHaveBeenCalled()
    expect(await invoke(C.project)).toMatchObject({ root: 'beta' })
    expect(st.send).toHaveBeenCalledWith(P.changed)
  })

  it('keeps every project GitHub association separate and treats bad metadata as display-only error', async () => {
    const bindings = new Map([['alpha', { projectId: 1, owner: 'alice', name: 'paper-a', branch: 'main', accountId: 7 }],
      ['beta', { projectId: 2, owner: 'alice', name: 'paper-b', branch: 'main', accountId: 7 }]])
    st.binding.mockImplementation(async (root: string) => bindings.get(root) ?? null)
    await controller({} as GitHubAccountService)
    select('alpha'); await invoke(C.open); select('beta'); await invoke(C.open)
    expect(await invoke(P.list)).toMatchObject({ projects: [
      { root: 'alpha', github: { owner: 'alice', name: 'paper-a' } },
      { root: 'beta', github: { owner: 'alice', name: 'paper-b' } }
    ] })
    st.binding.mockRejectedValueOnce(new Error('bad metadata'))
    expect(await invoke(P.list)).toMatchObject({ projects: [{ root: 'alpha', syncIssue: true }, { root: 'beta', github: { name: 'paper-b' } }] })
  })

  it('guards project-library IPC with the same exact trusted-frame policy', async () => {
    await controller()
    for (const channel of [P.list, P.activate, P.forget]) {
      await expect(st.handles.get(channel)!({ ...sender(), sender: { id: 1 } }, 'project:alpha')).rejects.toThrow('不能访问')
    }
    await expect(invoke(P.list, 'arbitrary path')).rejects.toThrow('不接受')
  })

  it('redacts authorization inputs even if a lower layer mistakenly puts them in errors', async () => {
    await controller(); select('old'); await invoke(C.open)
    const error = invoke(C.connect, { url: 'https://github.com/example/paper', token: 'fixture-value' })
    await expect(error).rejects.toThrow('[已隐藏]')
    await expect(error).rejects.not.toThrow('fixture-value')
  })
})
