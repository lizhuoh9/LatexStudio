import { BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ProjectInfo, RepositoryStatus, TexEnvironment, WorkspaceEvent } from '../../shared/workspace-contracts'
import { WORKSPACE_CHANNELS as C } from '../../shared/workspace-contracts'
import { CredentialVault } from '../github/credentials'
import { GitHubRepository } from '../github/repository'
import { isNetworkProject } from '../local/network'
import { LocalCompiler, detectTexEnvironment } from '../tex/compiler'
import { ProjectService } from '../local/project'
import { WorkspaceVersions } from './versions'
import { isTrustedSettingsSender } from '../url-policy'
import { SAMPLE_TEX } from './sample'
import { WorkspaceRepositoryTransfer } from './repository-transfer'
import { requireCompile, requireSettings, requireText, safeOperationError } from './validation'
import { CLOUD_CHANNELS as G } from '../../shared/cloud-contracts'
import type { GitHubAccountService } from '../collaboration/service'
import { readCloudBinding } from '../github/cloud-binding'
import { CloudRepository } from '../github/cloud-repository'
import { WorkspaceCloud } from './cloud-workflows'
import { githubInstallationUrl } from '../collaboration/configuration'
import { ProjectLibrary, projectIdForRoot } from './project-library'
import { readProjectLastModified } from './project-modification'
import { PROJECT_LIBRARY_CHANNELS as P, type ProjectLibraryState } from '../../shared/project-library-contracts'
import { translate } from '../../shared/i18n'

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent
type RepositoryService = Pick<GitHubRepository, 'status' | 'history' | 'snapshot' | 'connect' | 'disconnect' | 'sync'>

export class WorkspaceController {
  private projectService: ProjectService | null = null
  private activeRoot: string | null = null
  private readonly cloud: WorkspaceCloud | null
  private readonly library: Pick<ProjectLibrary, 'list' | 'remember' | 'resolve' | 'forget'>
  private versions: WorkspaceVersions | null = null
  private compiler: LocalCompiler | null = null
  private repositoryService: RepositoryService | null = null
  private unwatch: (() => void) | null = null
  private dirty = false
  private busy = false
  private readonly vault: CredentialVault
  private readonly environmentAbort = new AbortController()
  private environmentTask: Promise<TexEnvironment> | null = null
  private closing = false
  private editEpoch = 0
  private activeRequests = 0
  private readonly idleWaiters = new Set<() => void>()
  private readonly transfer = new WorkspaceRepositoryTransfer(state => this.send({ kind: 'repository-transfer', state }))
  private closeWait: { id: string; resolve: () => void; timer: NodeJS.Timeout } | null = null

  constructor(private window: BrowserWindow, private url: string, private dataRoot: string,
    private readonly beforeClose?: () => Promise<void>, private readonly accountService?: GitHubAccountService,
    library?: Pick<ProjectLibrary, 'list' | 'remember' | 'resolve' | 'forget'>) {
    this.vault = new CredentialVault(join(dataRoot, 'github-credentials.json'))
    this.library = library ?? new ProjectLibrary(dataRoot)
    this.cloud = accountService ? new WorkspaceCloud(accountService, this.vault, {
      root: () => this.activeRoot,
      openAuthorization: () => shell.openExternal(githubInstallationUrl()),
      openInvitations: () => shell.openExternal('https://github.com/notifications'),
      requireSaved: () => this.requireSaved(), epoch: () => this.editEpoch,
      confirmLeave: () => this.confirmLeave(), directory: title => this.selectDirectory(title),
      confirm: async (message, detail) => {
        const result = await dialog.showMessageBox(this.window, { type: 'question', message: translate(message), detail: translate(detail),
          buttons: [translate('取消'), translate('确认继续')], defaultId: 0, cancelId: 0, noLink: true })
        return result.response === 1 && !this.closing && !this.window.isDestroyed()
      },
      activate: (root, signal, verifySession) => this.activate(root, signal, verifySession),
      refreshRepository: async () => {
        this.repositoryService = await this.repositoryFor(this.activeRoot!)
        this.libraryChanged()
      },
      repository: () => this.requireRepository(),
      transfer: (kind, action) => this.transfer.run(kind, action),
      changed: () => this.send({ kind: 'files-changed', paths: [''] })
    }) : null
  }

  async initialize(): Promise<void> {
    this.registerProjectHandlers()
    this.registerRepositoryHandlers()
    this.registerCloudHandlers()
    this.registerLibraryHandlers()
    ipcMain.on(C.dirty, (event, value: unknown) => {
      if (this.trusted(event) && typeof value === 'boolean') { this.dirty = value; this.editEpoch += 1 }
    })
    ipcMain.on(C.closeAck, (event, id: unknown, dirty: unknown) => {
      if (!this.trusted(event) || typeof dirty !== 'boolean' || id !== this.closeWait?.id) return
      const pending = this.closeWait
      if (!pending) return
      clearTimeout(pending.timer); this.closeWait = null
      this.dirty = dirty
      pending.resolve()
    })
    await this.window.loadURL(this.url)
  }

  private trusted(event: SenderEvent): boolean {
    if (this.window.isDestroyed()) return false
    return isTrustedSettingsSender(event.sender.id, this.window.webContents.id,
      event.senderFrame === this.window.webContents.mainFrame,
      event.senderFrame?.url ?? '', this.url)
  }

  private handle(channel: string, action: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.trusted(event)) throw new Error('此页面不能访问本地项目。')
      if (this.closing) throw new Error('正在确认关闭，请完成关闭确认后再操作。')
      const tracked = channel !== C.environment && channel !== C.transfer && channel !== C.cancelTransfer
      if (tracked) this.activeRequests += 1
      try { return await action(...args) } catch (error) { throw safeOperationError(error) }
      finally { if (tracked) this.activeRequests -= 1; this.notifyIdle() }
    })
  }

  private registerProjectHandlers(): void {
    this.handle(C.project, () => this.projectService?.initialize() ?? null)
    this.handle(C.open, () => this.exclusive(() => this.chooseProject(false)))
    this.handle(C.create, () => this.exclusive(() => this.chooseProject(true)))
    this.handle(C.clone, value => this.exclusive(() => this.cloneProject(value)))
    this.handle(C.files, () => this.requireProject().list())
    this.handle(C.read, path => this.requireProject().read(requireText(path, '文件路径')))
    this.handle(C.save, (path, content, revision) => this.exclusive(() => this.save(path, content, revision)))
    this.handle(C.createFile, (path, content) => this.exclusive(() => this.createFile(path, content)))
    this.handle(C.environment, () => this.environment())
    this.handle(C.compile, value => this.exclusive(() => this.compile(value)))
    this.handle(C.cancelCompile, () => { this.compiler?.cancel() })
  }

  private registerRepositoryHandlers(): void {
    this.handle(C.repository, () => this.repositoryService?.status() ?? this.emptyRepository())
    this.handle(C.connect, value => this.exclusive(() => this.connect(value)))
    this.handle(C.disconnect, () => this.exclusive(async () => {
      await this.requireRepository().disconnect()
      this.libraryChanged()
    }))
    this.handle(C.snapshot, value => this.exclusive(async () => {
      this.requireSaved()
      return this.requireRepository().snapshot(requireText(value, '版本说明', 500))
    }))
    this.handle(C.sync, value => this.exclusive(() => this.sync(value)))
    this.handle(C.history, () => this.repositoryService?.history() ?? [])
    this.handle(C.revisions, () => this.versions?.list() ?? [])
    this.handle(C.revisionDetail, id => this.requireVersions().detail(requireText(id, '版本编号', 16384)))
    this.handle(C.restoreRevision, (id, revision) => this.exclusive(() => this.restoreRevision(id, revision)))
    this.handle(C.transfer, (...args) => {
      if (args.length) throw new Error('项目传输状态不接受参数。')
      return this.transfer.status()
    })
    this.handle(C.cancelTransfer, (...args) => {
      if (args.length) throw new Error('取消项目传输不接受参数。')
      return this.transfer.cancelAndWait()
    })
  }

  private registerCloudHandlers(): void {
    this.handle(G.status, () => this.requireCloud().status())
    this.handle(G.authorization, () => this.requireCloud().openAuthorization())
    this.handle(G.openInvitations, () => this.requireCloud().openInvitations())
    this.handle(G.projects, () => this.exclusive(() => this.requireCloud().projects()))
    this.handle(G.create, name => this.exclusive(() => this.requireCloud().createPrivateProject(requireText(name, '项目名称', 100))))
    this.handle(G.link, handle => this.exclusive(() => this.requireCloud().linkProject(requireText(handle, '项目选择', 512))))
    this.handle(G.download, handle => this.exclusive(() => this.requireCloud().downloadProject(requireText(handle, '项目选择', 512))))
    this.handle(G.join, link => this.exclusive(() => this.requireCloud().joinProject(requireText(link, '分享链接', 2048))))
    this.handle(G.share, () => this.exclusive(() => this.requireCloud().shareProject()))
    this.handle(G.invite, login => this.exclusive(() => this.requireCloud().inviteCollaborator(requireText(login, 'GitHub 用户名', 39))))
    this.handle(G.invitations, () => this.exclusive(() => this.requireCloud().invitations()))
    this.handle(G.accept, handle => this.exclusive(() => this.requireCloud().acceptInvitation(requireText(handle, '邀请选择', 512))))
    this.handle(G.sync, (summary, background) => this.exclusive(() => {
      if (typeof background !== 'boolean') throw new Error('同步模式无效。')
      return this.requireCloud().sync(requireText(summary, '进展说明', 500), background)
    }))
    this.handle(G.auto, enabled => this.exclusive(() => {
      if (typeof enabled !== 'boolean') throw new Error('自动同步设置无效。')
      return this.requireCloud().setAutoSync(enabled)
    }))
  }

  private registerLibraryHandlers(): void {
    this.handle(P.list, (...args) => {
      if (args.length) throw new Error('项目列表不接受路径或其他参数。')
      return this.libraryState()
    })
    this.handle(P.activate, id => this.exclusive(async () => {
      this.requireSaved()
      const project = await this.library.resolve(requireText(id, '项目编号', 64))
      return this.activate(project.root)
    }))
    this.handle(P.forget, id => this.exclusive(async () => {
      await this.library.forget(requireText(id, '项目编号', 64))
      const state = await this.libraryState()
      this.libraryChanged()
      return state
    }))
  }

  private async libraryState(): Promise<ProjectLibraryState> {
    const entries = await this.library.list()
    const projects = await Promise.all(entries.map(async entry => {
      const display = { ...entry, lastModifiedAt: await readProjectLastModified(entry.root) }
      if (!this.accountService) return { ...display, github: null }
      try {
        const binding = await readCloudBinding(entry.root)
        return { ...display, github: binding ? { owner: binding.owner, name: binding.name } : null }
      } catch { return { ...display, github: null, syncIssue: true } }
    }))
    return { projects, activeId: this.activeRoot ? projectIdForRoot(this.activeRoot) : null }
  }

  private libraryChanged(): void {
    if (this.window.isDestroyed()) return
    try { this.window.webContents.send(P.changed) }
    catch { /* Best-effort notification must not turn a committed workspace switch into a rejected response. */ }
  }

  private requireCloud(): WorkspaceCloud {
    if (!this.cloud) throw new Error('当前应用尚未连接普通 GitHub 登录模块；本地论文仍可使用。')
    return this.cloud
  }

  private async repositoryFor(root: string): Promise<RepositoryService> {
    if (this.accountService && await readCloudBinding(root)) return new CloudRepository(root, this.accountService, this.vault)
    return new GitHubRepository(root, this.vault)
  }

  /** An available result is kept; an unavailable or failed one is re-detected so newly prepared TeX is found. */
  private environment(): Promise<TexEnvironment> {
    if (!this.environmentTask) {
      const task = detectTexEnvironment(this.environmentAbort.signal, this.dataRoot)
      this.environmentTask = task
      task.then(result => { if (!result.available && this.environmentTask === task) this.environmentTask = null },
        () => { if (this.environmentTask === task) this.environmentTask = null })
    }
    return this.environmentTask
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('正在处理上一项操作，请等待完成，或先取消编译。')
    this.busy = true
    try { return await action() } finally { this.busy = false; this.notifyIdle() }
  }

  private notifyIdle(): void {
    if (this.busy || this.activeRequests > 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private waitForIdle(): Promise<void> {
    if (!this.busy && this.activeRequests === 0) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.add(resolve) })
  }

  private requireProject(): ProjectService {
    if (!this.projectService) throw new Error('请先打开一个本地论文项目。')
    return this.projectService
  }

  private requireRepository(): RepositoryService {
    if (!this.repositoryService) throw new Error('请先打开一个本地论文项目。')
    return this.repositoryService
  }

  private requireSaved(): void {
    if (this.dirty) throw new Error('请先保存当前编辑内容，再创建版本或同步。')
  }

  private async confirmLeave(): Promise<boolean> {
    if (this.window.isDestroyed()) return false
    if (!this.dirty) return true
    const result = await dialog.showMessageBox(this.window, {
      type: 'warning', message: translate('当前文档有尚未保存的编辑。'),
      detail: translate('返回后可先保存。继续会丢弃编辑器中尚未写入文件的内容，不会删除已有文件。'),
      buttons: [translate('返回保存'), translate('放弃未保存编辑并继续')], defaultId: 0, cancelId: 0
    })
    return result.response === 1
  }

  private async selectDirectory(title: string): Promise<string | null> {
    const selection = await dialog.showOpenDialog(this.window, {
      title: translate(title), properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    const root = selection.canceled ? null : selection.filePaths[0] ?? null
    if (root) await this.requireLocalRoot(root)
    return root
  }

  private async requireLocalRoot(root: string): Promise<void> {
    if (await isNetworkProject(root)) {
      throw new Error('此版本已停用 NAS 共享目录。请选择本机文件夹，通过 GitHub 私有项目合作；原目录及历史未修改。')
    }
  }

  private async chooseProject(create: boolean): Promise<ProjectInfo | null> {
    if (!await this.confirmLeave()) return null
    const root = await this.selectDirectory(create ? '为新示例项目选择空文件夹' : '打开本地论文项目')
    if (!root) return null
    if (create) {
      if ((await readdir(root)).length > 0) throw new Error('新示例需要空文件夹。已有论文请使用“打开项目”。')
      const versions = new WorkspaceVersions(root)
      const project = new ProjectService(root, { beforeWrite: (_project, change) => versions.journal.prepare(change) })
      try { await project.initialize(); await project.create('main.tex', SAMPLE_TEX) }
      finally { project.dispose() }
    }
    return this.activate(root)
  }

  private async activate(root: string, signal?: AbortSignal, verifySession?: () => void): Promise<ProjectInfo> {
    await this.requireLocalRoot(root)
    const versions = new WorkspaceVersions(root)
    const next = new ProjectService(root, { beforeWrite: (_project, change) => versions.journal.prepare(change) })
    let info: ProjectInfo
    let compiler: LocalCompiler | null = null
    let unwatch: (() => void) | null = null
    let repository: RepositoryService
    try {
      info = await next.initialize()
      repository = await this.repositoryFor(info.root)
      if (signal?.aborted) throw new Error('已取消切换项目，现有草稿与工作区保留。')
      compiler = new LocalCompiler(info.root, join(this.dataRoot, 'builds', info.id), this.dataRoot, message => {
        if (this.projectService === next) this.send({ kind: 'compile-log', message })
      })
      unwatch = next.watch(paths => {
        if (this.projectService === next) this.send({ kind: 'files-changed', paths })
      })
      await this.library.remember(info)
      if (signal?.aborted) throw new Error('已取消切换项目，现有草稿与工作区保留。')
      // No await between this session check and the synchronous workspace commit below.
      verifySession?.()
    } catch (error) {
      unwatch?.(); compiler?.dispose(); next.dispose(); throw error
    }
    this.unwatch?.()
    this.compiler?.dispose()
    this.projectService?.dispose()
    this.projectService = next
    this.versions = versions
    this.compiler = compiler
    this.repositoryService = repository
    this.activeRoot = info.root
    this.unwatch = unwatch
    this.dirty = false
    this.libraryChanged()
    return info
  }

  private async cloneProject(value: unknown): Promise<ProjectInfo | null> {
    const settings = requireSettings(value)
    if (!await this.confirmLeave()) return null
    const root = await this.selectDirectory('下载 GitHub 项目到一个空文件夹')
    if (!root) return null
    const repository = new GitHubRepository(root, this.vault)
    try {
      return await this.transfer.run('clone', async signal => {
        await repository.clone(settings, { signal })
        if (signal.aborted) throw new Error('已请求取消下载；可能保留部分文件，当前工作区不切换。')
        return this.activate(root, signal)
      })
    } catch (error) { throw safeOperationError(error, [settings.token]) }
  }

  private async connect(value: unknown): Promise<unknown> {
    const settings = requireSettings(value)
    try {
      return await this.transfer.run('connect', signal => this.requireRepository().connect(settings, { signal }))
    }
    catch (error) { throw safeOperationError(error, [settings.token]) }
  }

  private async save(path: unknown, content: unknown, revision: unknown): Promise<unknown> {
    if (typeof content !== 'string') throw new Error('文档内容格式不正确。')
    const saved = await this.requireProject().save(requireText(path, '文件路径'), content,
      requireText(revision, '文件版本', 128))
    return saved
  }

  private async createFile(path: unknown, content: unknown): Promise<unknown> {
    if (typeof content !== 'string') throw new Error('文档内容格式不正确。')
    return this.requireProject().create(requireText(path, '文件路径'), content)
  }

  private requireVersions(): WorkspaceVersions {
    if (!this.versions) throw new Error('请先打开一个本地论文项目。')
    return this.versions
  }

  private async restoreRevision(id: unknown, revision: unknown): Promise<unknown> {
    this.requireSaved()
    const detail = await this.requireVersions().detail(requireText(id, '版本编号', 16384))
    const expected = requireText(revision, '当前文件版本', 128)
    const project = this.requireProject()
    const current = await project.read(detail.entry.path)
    if (current.revision !== expected) throw new Error('文件已变化，回退冲突；请重新读取比较，不会覆盖。')
    const epoch = this.editEpoch
    const result = await dialog.showMessageBox(this.window, {
      type: 'warning', message: translate(`回退文件 ${detail.entry.path} 到所选版本？`),
      detail: translate(`只改变这一个文件，不是整个项目。当前已保存内容也会留在新版本的修改前内容中；旧历史不会删除。\\n版本：${detail.entry.date} · ${detail.entry.author}`),
      buttons: [translate('取消'), translate('确认回退此文件')], defaultId: 0, cancelId: 0
    })
    if (result.response !== 1 || this.window.isDestroyed()) throw new Error('已取消回退，文件未修改。')
    this.requireSaved()
    if (epoch !== this.editEpoch) throw new Error('确认期间草稿状态已变化，请重新确认回退。')
    const saved = await project.save(detail.entry.path, detail.after, expected,
      { kind: 'restore', summary: `回退至 ${detail.entry.id}` })
    this.send({ kind: 'files-changed', paths: [saved.path] })
    return saved
  }

  private async compile(value: unknown): Promise<unknown> {
    this.requireSaved()
    if (!this.compiler) throw new Error('请先打开一个本地论文项目。')
    return this.compiler.run(requireCompile(value))
  }

  private async sync(value: unknown): Promise<unknown> {
    this.requireSaved()
    const summary = requireText(value, '版本说明', 500)
    const repository = this.requireRepository()
    const status = await repository.status()
    if (!status.connection) throw new Error('请先关联 GitHub 仓库。')
    const preview = status.changes.map(change => change.path).slice(0, 30).join('\n')
    const result = await dialog.showMessageBox(this.window, {
      type: 'question', message: translate(`与 ${status.connection.owner}/${status.connection.repository} 同步？`),
      detail: translate(`${status.changes.length} 个待记录文件改动。同步会保存本地版本并收发远端版本；冲突时不会强制覆盖。\n${preview}`),
      buttons: [translate('取消'), translate('确认同步')], defaultId: 0, cancelId: 0
    })
    if (result.response !== 1) throw new Error('已取消同步确认，不会开始本次同步。')
    this.requireSaved()
    return this.transfer.run('sync', signal => repository.sync(summary, { signal }))
  }

  private emptyRepository(): RepositoryStatus {
    return { connection: null, changes: [], message: '打开本地项目后可关联 GitHub。', conflict: false }
  }

  private send(event: WorkspaceEvent): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(C.event, event)
  }

  private freezeForClose(): Promise<void> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.closeWait?.id !== id) return
        this.closeWait = null
        reject(new Error('工作台未确认草稿状态，已取消关闭。'))
      }, 5000)
      this.closeWait = { id, resolve, timer }
      try { this.send({ kind: 'close-request', requestId: id }) }
      catch { this.clearCloseWait(); reject(new Error('工作台无法确认草稿状态，已取消关闭。')) }
    })
  }

  private clearCloseWait(): void {
    if (this.closeWait) clearTimeout(this.closeWait.timer)
    this.closeWait = null
  }

  private async closeNotice(message: string): Promise<void> {
    if (this.window.isDestroyed()) return
    try { await dialog.showMessageBox(this.window, { type: 'warning', message: translate(message) }) }
    catch { /* A failed native dialog cannot turn an unconfirmed close into success. */ }
  }

  private restoreCloseUi(): void {
    this.closing = false
    if (this.window.isDestroyed()) return
    try { this.window.setEnabled(true) } catch { /* Preserve backend gates even if UI restore fails. */ }
    try { this.send({ kind: 'close-state', closing: false }) } catch { /* No renderer acknowledgement is fabricated. */ }
  }

  private async confirmTransferClose(): Promise<boolean> {
    if (!this.transfer.isActive()) return true
    if (this.window.isDestroyed()) return false
    const result = await dialog.showMessageBox(this.window, {
      type: 'warning', message: translate('项目传输尚未结束，要请求取消并等待后关闭吗？'),
      detail: translate('会等待当前动作及已登记连接清理，不强制停止。部分本地修改或已接收的上传不会自动撤回。'),
      buttons: [translate('保留窗口继续等待'), translate('请求取消并等待关闭')], defaultId: 0, cancelId: 0
    })
    if (result.response !== 1 || this.window.isDestroyed()) return false
    await this.transfer.cancelAndWait()
    return true
  }

  async requestClose(): Promise<boolean> {
    if (this.closing || this.window.isDestroyed()) return false
    if ((this.busy || this.activeRequests > 0) && !this.transfer.isActive()) {
      await this.closeNotice('后台任务尚未完成，请先取消编译或等待操作结束。')
      return false
    }
    this.closing = true
    let accepted = false
    try {
      this.window.setEnabled(false)
      await this.freezeForClose()
      const confirmedEpoch = this.editEpoch
      if (!await this.confirmLeave() || this.window.isDestroyed()) return false
      if (!await this.confirmTransferClose()) return false
      await this.waitForIdle()
      this.transfer.assertCloseReady()
      this.environmentAbort.abort()
      if (this.environmentTask) await this.environmentTask.catch(() => undefined)
      await this.beforeClose?.()
      if (this.window.isDestroyed() || this.busy || this.activeRequests > 0 ||
        (this.dirty && this.editEpoch !== confirmedEpoch)) return false
      this.dispose(); accepted = true
      return true
    } catch {
      await this.closeNotice('未能确认安全关闭，窗口和编辑草稿已保留。')
      return false
    } finally {
      this.clearCloseWait()
      if (!accepted) this.restoreCloseUi()
    }
  }

  dispose(): void {
    this.environmentAbort.abort()
    this.unwatch?.()
    this.unwatch = null
    this.compiler?.dispose()
    this.projectService?.dispose()
  }
}
