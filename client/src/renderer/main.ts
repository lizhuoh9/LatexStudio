import './style.css'
import './setup-style.css'
import './collaboration-style.css'
import './repository-transfer-style.css'
import './cloud-project-style.css'
import './project-library-style.css'
import './file-tree-style.css'
import './version-panel-style.css'
import './file-outline-style.css'
import './workspace-layout-style.css'
import { WorkbenchLayout } from './workbench-layout'
import { WorkspaceSplitter } from './workspace-splitter'
import { FileOutline } from './file-outline'
import { AccountMenu } from './account-menu'
import type { ProjectLibraryApi } from '../shared/project-library-contracts'
import { ProjectLibraryPanel } from './project-library-panel'
import type { CloudApi } from '../shared/cloud-contracts'
import { CloudProjectPanel } from './cloud-project-panel'
import { SharingPanel } from './sharing-panel'
import { adoptCommittedProject } from './adopt-committed-project'
import type { DesktopLinksApi } from '../shared/desktop-links-contracts'
import agplLicense from '../vendor/ayakaleaf/LICENSE.txt?raw'
import thirdPartyNotices from '../../THIRD_PARTY_NOTICES.md?raw'
import type { ProjectFile, ProjectInfo, TexEngine, TexEnvironment, WorkspaceApi, WorkspaceEvent } from '../shared/workspace-contracts'
import { Documents } from './documents'
import { SourceEditor } from './editor-view'
import { PdfPreview } from './pdf-view'
import { Dialogs } from './dialogs'
import { appendLog, button, element, text } from './dom'
import { renderFiles } from './file-tree'
import { readableError, type EditorBuffer } from './editor-model'
import { SyncPanel, type RunAction } from './sync-panel'
import { SetupPanel } from './setup-panel'
import { environmentNotice } from './setup-model'
import type { TexSetupApi } from '../shared/tex-setup-contracts'
import type { CollaborationApi } from '../shared/collaboration-contracts'
import { CollaborationPanel } from './collaboration-panel'
import { StartupDialog } from './startup-dialog'
import { RepositoryTransferPanel } from './repository-transfer-panel'
import { UpdatePanel } from './update-panel'
import type { UpdateApi } from '../shared/update-contracts'
import { LocalePanel, initializeLocalePreference } from './locale-panel'
import { startDomLocalization, uiAttribute, uiText } from './i18n-dom'
import './i18n-style.css'

declare global { interface Window { paperstudio: WorkspaceApi } }

class Workbench {
  private busy = false
  private compiling = false
  private closing = false
  private frozen = new Map<HTMLElement, boolean>()
  private activeExternal: string[] = []
  private pendingExternal = new Set<string>()
  private environment: TexEnvironment | null = null
  private environmentError = ''
  private setupWasVerified = false
  private setup: SetupPanel
  private collaboration: CollaborationPanel
  private startup: StartupDialog | null = null
  private account: AccountMenu | null = null
  private sync: SyncPanel
  private layout: WorkbenchLayout
  private splitter: WorkspaceSplitter
  private outline: FileOutline | null = null
  private lastOutlineContent: string | null = null
  private lastMainTexList = ''
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private sharing: SharingPanel | null = null
  private cloud: CloudProjectPanel
  private library: ProjectLibraryPanel
  private repositoryTransfer: RepositoryTransferPanel
  private updates: UpdatePanel
  private language: LocalePanel
  private dialogs = new Dialogs()
  private documents: Documents
  private editor: SourceEditor
  private pdf: PdfPreview

  constructor(private api: WorkspaceApi) {
    this.editor = new SourceEditor(element('source-editor'), (content) => {
      if (!this.closing) this.documents.edited(content)
    },
      () => this.run('保存文件', async () => { await this.documents.save() }))
    this.outline = new FileOutline(element('file-outline'), line => this.editor.revealLine(line))
    this.layout = new WorkbenchLayout(() => this.showHome())
    this.splitter = new WorkspaceSplitter()
    this.pdf = new PdfPreview((message) => this.notify(message))
    this.documents = new Documents(api, {
      show: (content, readOnly) => this.editor.show(content, readOnly),
      state: (buffer) => this.renderDocument(buffer), files: (files, active) => this.renderFiles(files, active),
      project: (project) => this.renderProject(project), notify: (message) => this.notify(message),
      confirm: (title, detail) => this.dialogs.confirm(title, detail), input: (title, value) => this.dialogs.input(title, value)
    })
    this.sync = new SyncPanel(api, this.documents, this.dialogs, this.run,
      (project) => this.adopt(project), (message) => this.notify(message))
    const setupApi = (window as Window & { paperstudioSetup?: TexSetupApi }).paperstudioSetup
    this.setup = new SetupPanel(setupApi, () => this.setupChanged())
    const collaborationApi = (window as Window & { paperstudioCollaboration?: CollaborationApi }).paperstudioCollaboration
    this.collaboration = new CollaborationPanel(collaborationApi, undefined, () => { this.startup?.update(); this.account?.update(); this.sharing?.accountChanged() })
    this.account = new AccountMenu(this.collaboration.model, () => {
      if (!this.closing) element<HTMLDialogElement>('cloud-dialog').showModal()
    })
    this.startup = new StartupDialog(this.collaboration.model, () => {
      if (this.closing) return
      const dialog = element<HTMLDialogElement>('cloud-dialog')
      if (!dialog.open) dialog.showModal()
      this.collaboration.startLogin()
    })
    const cloudApi = (window as Window & { paperstudioCloud?: CloudApi }).paperstudioCloud
    this.cloud = new CloudProjectPanel(cloudApi, this.documents, this.dialogs, this.run,
      project => this.adopt(project), message => this.notify(message), login => this.setupSync(login))
    this.initializeSharing(cloudApi)
    const unsubscribeCloud = collaborationApi?.onState(() => { void this.cloud.refresh() })
    const projectApi = (window as Window & { paperstudioProjects?: ProjectLibraryApi }).paperstudioProjects
    this.library = new ProjectLibraryPanel(projectApi, this.documents, this.dialogs, this.run,
      project => this.adopt(project), message => this.notify(message), () => this.showEditor())
    this.repositoryTransfer = new RepositoryTransferPanel(api)
    this.updates = new UpdatePanel((window as Window & { paperstudioUpdates?: UpdateApi }).paperstudioUpdates)
    this.language = new LocalePanel()
    window.addEventListener('unload', () => {
      this.language.dispose()
      this.sharing?.dispose()
      this.editor.destroy()
      this.startup?.dispose()
      this.layout.dispose()
      this.sync.dispose()
      this.splitter.dispose()
      void this.pdf.dispose().catch(() => undefined)
      this.outline?.dispose()
      this.account?.dispose()
      if (this.noticeTimer !== null) clearTimeout(this.noticeTimer)
      this.collaboration.dispose()
      this.cloud.dispose()
      this.library.dispose()
      unsubscribeCloud?.()
      this.repositoryTransfer.dispose()
      this.updates.dispose()
    }, { once: true })
    this.bindActions()
    this.bindClosingInput()
    text('license-text', agplLicense)
    text('notices-text', thirdPartyNotices)
    api.onEvent((event) => this.event(event))
    this.run('初始化本地工作区', async () => {
      try { await this.initialize() } finally { this.sharing?.markReady() }
    })
  }

  private notify(message: string): void {
    text('status', message)
    element('status').hidden = !message
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => { element('status').hidden = true }, 6000)
  }

  private run: RunAction = (label, action, freezeEditor = false) => {
    if (this.closing) return
    if (this.busy) { this.notify('正在处理上一项操作，请稍候。'); return }
    void this.execute(label, action, freezeEditor)
  }

  private async execute(label: string, action: () => Promise<void>, freeze: boolean): Promise<void> {
    const editorPanel = element('editor-panel')
    const previousInert = editorPanel.inert
    this.busy = true
    editorPanel.inert = previousInert || freeze || this.closing
    this.updateControls()
    try { await action() } catch (error) {
      const message = readableError(error)
      this.notify(message)
      appendLog(`\n${label}失败：${message}\n`)
    } finally {
      this.busy = false
      if (this.closing && this.frozen.has(editorPanel)) this.frozen.set(editorPanel, previousInert)
      editorPanel.inert = this.closing || previousInert
      this.updateControls()
      this.flushExternal()
      if (freeze || ['保存文件', '新建文件', '另存副本', '本机编译', '检查本地文件变化'].includes(label)) this.sync.refreshVisible()
      this.sharing?.flushPending()
    }
  }

  private updateControls(): void {
    const locked = this.busy || this.closing
    document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('[data-lock]').forEach((item) => { item.disabled = locked })
    if (!locked) {
      element<HTMLButtonElement>('compile').disabled = !this.documents.project || !this.canCompile() || !element<HTMLSelectElement>('main-file').value
      element<HTMLButtonElement>('file-save').disabled = !this.documents.buffer.path
      element<HTMLButtonElement>('file-create').disabled = !this.documents.project
      element<HTMLButtonElement>('file-reload').disabled = !this.reloadAvailable()
    }
    element<HTMLButtonElement>('cancel-compile').disabled = this.closing || !this.compiling
  }

  private setupSync(login: boolean): void {
    if (this.busy || this.closing || !this.documents.project || document.querySelector('dialog[open]')) return
    if (login) {
      element<HTMLDialogElement>('cloud-dialog').showModal()
      this.collaboration.startLogin()
    } else element('project-settings').click()
  }

  private initializeSharing(api: CloudApi | undefined): void {
    const links = (window as Window & { paperstudioDesktopLinks?: DesktopLinksApi }).paperstudioDesktopLinks
    this.sharing = new SharingPanel(api, links, this.documents, this.collaboration.model, this.run,
      project => this.adopt(project), () => {
        if (this.busy || this.closing || document.querySelector('dialog[open]')) return
        element<HTMLDialogElement>('cloud-dialog').showModal()
        this.collaboration.startLogin()
      }, () => element('project-settings').click(), () => !this.busy && !this.closing && !document.body.inert,
      () => this.api.cancelRepositoryTransfer())
  }

  private bindActions(): void {
    button('project-open', () => this.run('打开本地项目', () => this.switchProject('open'), true))
    button('project-create', () => this.run('创建本地项目', () => this.switchProject('create'), true))
    button('file-save', () => this.run('保存文件', async () => { await this.documents.save() }))
    button('file-create', () => this.run('新建文件', () => this.documents.create()))
    button('file-reload', () => this.run('重新载入', () => this.documents.reload()))
    button('file-copy', () => this.run('另存副本', () => this.documents.create(true)))
    button('compile', () => this.run('本机编译', () => this.compile()))
    element('main-file').addEventListener('change', () => this.compileIdentity())
    button('cancel-compile', () => { void this.api.cancelCompile().catch((error: unknown) => this.notify(readableError(error))) })
    button('log-clear', () => text('log', ''))
    button('pdf-previous', () => { if (!this.closing) void this.pdf.move(-1).catch(error => this.notify(readableError(error))) })
    button('pdf-next', () => { if (!this.closing) void this.pdf.move(1).catch(error => this.notify(readableError(error))) })
    button('pdf-smaller', () => { if (!this.closing) void this.pdf.scale(-0.1).catch(error => this.notify(readableError(error))) })
    button('pdf-larger', () => { if (!this.closing) void this.pdf.scale(0.1).catch(error => this.notify(readableError(error))) })
    button('about-open', () => element<HTMLDialogElement>('about-dialog').showModal())
    button('dashboard-help', () => element<HTMLDialogElement>('about-dialog').showModal())
    button('project-share', () => { if (!this.busy && !this.closing) this.sharing?.openShare() })
    for (const id of ['home-join', 'project-join']) button(id, () => {
      if (this.busy || this.closing) return
      element<HTMLDetailsElement>('account-menu').open = false
      this.sharing?.openJoin()
    })
    for (const command of ['undo', 'redo', 'bold', 'italic', 'search'] as const) {
      button(`edit-${command}`, () => { if (!this.closing && !this.busy) this.editor.runCommand(command) })
    }
    button('project-settings', () => {
      if (this.closing || !this.documents.project) return
      element<HTMLDialogElement>('project-dialog').showModal()
      void this.cloud.refresh()
    })
    button('project-close', () => element<HTMLDialogElement>('project-dialog').close())
    for (const id of ['cloud-dialog', 'project-dialog']) {
      element(id).addEventListener('close', () => { element<HTMLInputElement>('github-token').value = '' })
    }
  }

  private async initialize(): Promise<void> {
    this.repositoryTransfer.initialize()
    this.setup.initialize()
    this.cloud.initialize()
    this.library.initialize()
    this.collaboration.initialize()
    this.startup?.open()
    void this.loadEnvironment()
    const project = await this.api.project()
    if (project) await this.adopt(project)
    else this.layout.showHome()
  }

  private showHome(): void {
    if (this.closing || this.busy) return
    // Home is a view switch, not a project close: keep the active dirty buffer and its close protection.
    this.cloud.projectChanged()
    this.sync.projectChanged()
    this.layout.showHome()
    void this.library.refresh()
  }

  private showEditor(): void {
    if (this.closing || !this.documents.project) return
    this.layout.showEditor()
    void this.cloud.refresh()
    this.sync.refreshVisible()
    this.editor.focus()
  }

  private async loadEnvironment(): Promise<void> {
    try {
      this.environment = await this.api.environment()
      this.environmentError = ''
      const engine = element<HTMLSelectElement>('engine')
      for (const option of engine.options) option.disabled = !this.environment.engines.includes(option.value as TexEngine)
      engine.value = this.environment.engines[0] ?? 'pdflatex'
    } catch (error) {
      this.environment = null
      this.environmentError = readableError(error)
    } finally { this.renderEnvironment(); this.updateControls() }
  }

  private canCompile(): boolean { return this.setup.verified && this.environment?.available === true }

  private setupChanged(): void {
    this.renderEnvironment()
    this.updateControls()
    if (this.closing) return
    const verified = this.setup.verified
    if (verified && (!this.setupWasVerified || this.environmentError)) void this.loadEnvironment()
    this.setupWasVerified = verified
  }

  private renderEnvironment(): void {
    const notice = environmentNotice(this.canCompile(), this.setup.verified,
      this.environment?.available ?? null, this.environmentError, this.setup.summary)
    text('environment', notice.message)
    element('environment-summary').hidden = notice.hidden
    element('environment-summary').classList.toggle('missing', notice.problem || this.setup.attention)
    const issue = this.environmentError || (this.setup.verified && this.environment?.available === false
      ? readableError(new Error(this.environment.description)) : '')
    text('setup-native-detail', issue)
    element('setup-native-detail').hidden = !issue
  }

  private async switchProject(kind: 'open' | 'create'): Promise<void> {
    if (!await this.documents.mayLeave()) return
    const project = kind === 'open' ? await this.api.openProject() : await this.api.createProject()
    if (project) await this.adopt(project)
  }

  private async adopt(project: ProjectInfo): Promise<void> {
    this.pendingExternal.clear()
    await adoptCommittedProject(project, () => this.pdf.clear(), next => this.documents.adopt(next), message => this.notify(message))
    this.showEditor()
    void this.library.refresh()
    text('log', `已打开本地项目：${project.name}\n`)
    this.sync.refreshVisible()
  }

  private renderProject(project: ProjectInfo): void {
    this.cloud.projectChanged()
    this.sharing?.projectChanged()
    this.sync.projectChanged()
    element('project-actions').hidden = false
    text('project-settings-name', project.name)
    element<HTMLDialogElement>('project-dialog').close()
    text('project-name', project.name)
    element('project-root').title = project.root
    element('project-name').title = project.root
    text('file-tree-context', project.name)
    element('file-tree-context').title = project.root
  }

  private reloadAvailable(): boolean {
    return Boolean(this.documents.project?.files.some(file => file.path === this.documents.buffer.path && file.kind === 'text'))
  }

  private renderDocument(buffer: EditorBuffer): void {
    if (this.lastOutlineContent !== buffer.content) {
      this.lastOutlineContent = buffer.content
      this.outline?.update(buffer.content)
    }
    if (buffer.path) text('active-file', buffer.path)
    else uiText(element('active-file'), '源文件')
    text('save-state', buffer.path ? (buffer.dirty ? '● 未保存' : '已保存到本地') : '未打开文件')
    element('save-state').classList.toggle('dirty', buffer.dirty)
    element('external-warning').hidden = !buffer.conflict
    text('external-message', this.reloadAvailable() ? '文件在外部发生变化。编辑内容已保留，请比较后重新载入或另存副本。'
      : `“${buffer.path}”原位置已不存在或被替换。编辑内容已保留，请另存副本，或从文件树打开新位置。`)
    element('editor-empty').hidden = Boolean(buffer.path)
    this.updateControls()
  }

  private renderFiles(files: ProjectFile[], active: string): void {
    const projectId = this.documents.project?.id ?? ''
    renderFiles(files, active, (path) => this.run('打开文件', () => this.documents.open(path)), projectId)
    const select = element<HTMLSelectElement>('main-file')
    const texFiles = files.filter((file) => file.kind === 'text' && /\.tex$/i.test(file.path))
    const key = `${projectId}\0${texFiles.map((file) => file.path).join('\0')}`
    if (key !== this.lastMainTexList) {
      const sameProject = this.lastMainTexList.startsWith(`${projectId}\0`)
      this.lastMainTexList = key
      const previous = (sameProject ? select.value : '') || this.documents.project?.defaultMain || ''
      select.replaceChildren(...texFiles.map((file) => {
        const option = document.createElement('option'); option.value = file.path; option.textContent = file.path; return option
      }))
      if ([...select.options].some((option) => option.value === previous)) select.value = previous
    }
    this.compileIdentity()
  }

  private compileIdentity(): void {
    const main = element<HTMLSelectElement>('main-file').value
    const compile = element<HTMLButtonElement>('compile')
    uiText(compile, main ? `▶ 编译 ${main.split('/').at(-1)}` : '▶ 编译')
    uiAttribute(compile, 'title', main ? `主文件：${main} · 项目根目录：${this.documents.project?.root ?? ''}` : '请先打开含有主文件的论文项目')
    uiAttribute(compile, 'aria-label', main ? `编译主文件 ${main}` : '编译论文')
  }

  private async compile(): Promise<void> {
    if (!this.canCompile()) { this.setup.open(); this.notify('编译组件尚未就绪，请查看组件状态。'); return }
    if (!await this.documents.save()) return
    if (this.documents.buffer.dirty) { this.notify('保存期间又有新输入，请再次保存后编译。'); return }
    this.compiling = true; this.updateControls(); text('log', '')
    try {
      const result = await this.api.compile({ mainFile: element<HTMLSelectElement>('main-file').value,
        engine: element<HTMLSelectElement>('engine').value as TexEngine })
      text('log', result.log.slice(-160000))
      if (!result.ok && !result.canceled) this.layout.showLog()
      this.notify(result.canceled ? '已取消本次编译。' : result.ok
        ? `本机编译完成 · ${(result.durationMs / 1000).toFixed(1)} 秒` : '本次编译未成功，请查看日志。预览仍保留上次成功的结果。')
      // Not awaited: PDF.js paints via requestAnimationFrame, which Chromium pauses while the window is hidden or
      // covered. The finished compile must not stay "in progress" until the user looks at the window again.
      if (result.ok && result.pdf) void this.pdf.show(result.pdf).catch(() => undefined)
    } finally { this.compiling = false; this.updateControls() }
  }

  private bindClosingInput(): void {
    for (const type of ['click', 'keydown', 'beforeinput', 'submit', 'cancel']) {
      document.addEventListener(type, (event) => {
        if (!this.closing) return
        event.preventDefault()
        event.stopImmediatePropagation()
      }, true)
    }
  }

  private setClosing(closing: boolean): void {
    if (this.closing === closing) return
    this.closing = closing
    this.documents.setClosing(closing)
    this.setup.setClosing(closing)
    this.collaboration.setClosing(closing)
    this.account?.setClosing(closing)
    this.sync.setClosing(closing)
    this.startup?.setClosing(closing)
    this.layout.setClosing(closing)
    this.splitter.setClosing(closing)
    this.outline?.setClosing(closing)
    this.cloud.setClosing(closing)
    this.sharing?.setClosing(closing)
    this.library.setClosing(closing)
    this.repositoryTransfer.setClosing(closing)
    this.updates.setClosing(closing)
    this.language.setClosing(closing)
    if (closing) {
      for (const node of [document.body, element('editor-panel'), ...document.querySelectorAll<HTMLDialogElement>('dialog')]) {
        this.frozen.set(node, node.inert)
        node.inert = true
      }
      for (const path of this.activeExternal) this.pendingExternal.add(path)
    } else {
      for (const [node, inert] of this.frozen) node.inert = inert
      this.frozen.clear()
    }
    this.updateControls()
    if (!closing) { this.setupChanged(); this.notify('已取消关闭，可继续编辑。'); this.flushExternal(); this.sharing?.flushPending() }
  }

  private event(event: WorkspaceEvent): void {
    if (event.kind === 'close-request') {
      this.setClosing(true)
      this.api.acknowledgeClose(event.requestId, this.documents.buffer.dirty)
      return
    }
    if (event.kind === 'close-state') { this.setClosing(event.closing); return }
    if (event.kind === 'repository-transfer') { this.repositoryTransfer.receive(event.state); return }
    if (event.kind === 'compile-log') { appendLog(event.message); return }
    if (event.kind === 'sync-progress') { this.notify(event.message); return }
    for (const path of event.paths) this.pendingExternal.add(path)
    this.flushExternal()
  }

  private flushExternal(): void {
    if (this.closing || this.busy || !this.documents.project || this.pendingExternal.size === 0) return
    const paths = [...this.pendingExternal]
    this.pendingExternal.clear()
    this.activeExternal = paths
    this.run('检查本地文件变化', async () => {
      try { await this.documents.refresh(paths) } finally { this.activeExternal = [] }
    })
  }
}

async function startWorkbench(): Promise<void> {
  await initializeLocalePreference(window.paperstudioPreferences)
  const disposeLocalization = startDomLocalization()
  window.addEventListener('unload', disposeLocalization, { once: true })
  if (typeof window.paperstudio?.project === 'function') new Workbench(window.paperstudio)
  else { text('status', '无法连接本机工作区。请通过 LatexStudio 桌面应用启动。'); element('status').hidden = false }
}
void startWorkbench()
