import type { DocumentSnapshot, ProjectFile, ProjectInfo, WorkspaceApi } from '../shared/workspace-contracts'
import { EditorBuffer } from './editor-model'

export interface DocumentUi {
  show(content: string, readOnly: boolean): void
  state(buffer: EditorBuffer): void
  files(files: ProjectFile[], active: string): void
  project(project: ProjectInfo): void
  notify(message: string): void
  confirm(title: string, detail: string): Promise<boolean>
  input(title: string, value: string): Promise<string | null>
}

export class Documents {
  readonly buffer = new EditorBuffer()
  project: ProjectInfo | null = null
  private generation = 0
  private closing = false
  private resume = Promise.resolve()
  private releaseResume: (() => void) | null = null

  constructor(private api: WorkspaceApi, private ui: DocumentUi) {}

  setClosing(closing: boolean): void {
    if (this.closing === closing) return
    this.closing = closing
    if (closing) this.resume = new Promise<void>((resolve) => { this.releaseResume = resolve })
    else { this.releaseResume?.(); this.releaseResume = null }
  }

  private async interactive(): Promise<void> { while (this.closing) await this.resume }

  edited(content: string): void {
    if (this.closing) return
    this.buffer.edit(content)
    this.updateState()
  }

  private updateState(): void {
    this.api.setDirty(this.buffer.dirty)
    this.ui.state(this.buffer)
  }

  async mayLeave(): Promise<boolean> {
    return !this.buffer.dirty || await this.ui.confirm('当前文件尚未保存',
      `“${this.buffer.path}”有未保存修改。继续会放弃这个编辑草稿。建议取消后先保存或另存副本。`)
  }

  async adopt(project: ProjectInfo): Promise<void> {
    if (this.closing) await this.interactive()
    this.generation += 1
    this.project = project
    this.buffer.reset()
    this.ui.show('', true)
    this.ui.project(project)
    this.ui.files(project.files, '')
    this.updateState()
    const first = project.defaultMain ?? project.files.find((file) => file.kind === 'text')?.path
    if (first) await this.open(first)
  }

  async open(path: string): Promise<void> {
    if (path === this.buffer.path) return
    const file = this.project?.files.find((item) => item.path === path)
    if (!file || file.kind !== 'text') { this.ui.notify('此文件是二进制附件，保留在本地目录，不作为文本打开。'); return }
    if (!await this.mayLeave()) return
    if (this.closing) await this.interactive()
    const generation = this.generation
    const version = this.buffer.editVersion
    const snapshot = await this.api.readFile(path)
    if (this.closing) await this.interactive()
    if (generation !== this.generation || version !== this.buffer.editVersion) {
      this.ui.notify('读取期间编辑草稿发生变化，已保留草稿；请重新选择文件。'); return
    }
    this.load(snapshot)
  }

  private load(snapshot: DocumentSnapshot): void {
    this.buffer.load(snapshot)
    this.ui.show(snapshot.content, false)
    this.updateState()
    this.ui.files(this.project?.files ?? [], snapshot.path)
  }

  async save(): Promise<boolean> {
    if (this.closing) await this.interactive()
    if (!this.buffer.path) return true
    if (this.buffer.conflict) {
      this.ui.notify('本地文件已被外部修改。为避免覆盖，请先重新载入或另存副本。'); return false
    }
    if (!this.buffer.dirty) return true
    const snapshot = await this.api.saveFile(this.buffer.path, this.buffer.content, this.buffer.revision)
    if (this.closing) await this.interactive()
    if (!this.buffer.saved(snapshot)) return false
    this.updateState()
    this.ui.notify(this.buffer.dirty ? '已保存之前的内容；新输入的修改仍未保存。' : '已保存到本地文件。')
    return true
  }

  async refresh(paths: string[]): Promise<void> {
    if (this.closing) return
    const generation = this.generation
    const files = await this.api.files()
    if (this.closing || generation !== this.generation || !this.project) return
    this.project.files = files
    this.ui.files(files, this.buffer.path)
    const path = this.buffer.path
    if (!path || (!paths.includes(path) && !paths.includes(''))) return
    const version = this.buffer.editVersion
    const current = files.find((file) => file.path === path)
    if (!current || current.kind !== 'text') {
      this.conflict(current ? '当前文件已被替换为文件夹或非文本附件；仍保留编辑内容，可另存副本。'
        : '当前文件已在本地目录中删除；仍保留编辑内容，可另存副本。'); return
    }
    const snapshot = await this.api.readFile(path)
    if (this.closing || generation !== this.generation || path !== this.buffer.path) return
    // Acknowledged writes also produce watcher events. Compare the current CAS
    // baseline BEFORE interpreting dirty/version changes as an external conflict.
    if (snapshot.revision === this.buffer.revision) {
      if (this.buffer.conflict) { this.buffer.conflict = false; this.updateState() }
      return
    }
    if (!this.buffer.acceptReload(snapshot, version)) {
      this.conflict('外部文件发生变化；编辑草稿已保留，请重新载入或另存副本。'); return
    }
    this.ui.show(snapshot.content, false)
    this.updateState()
    this.ui.notify('已载入外部工具保存的新内容。')
  }

  private conflict(message: string): void {
    this.buffer.conflict = true
    this.updateState()
    this.ui.notify(message)
  }

  async reload(): Promise<void> {
    const path = this.buffer.path
    if (!path) return
    if (!this.project?.files.some(file => file.path === path && file.kind === 'text')) {
      this.conflict('当前文件原位置已不存在或已被替换，不能重新载入；编辑内容仍保留，请另存副本或从文件树打开新位置。'); return
    }
    if (!await this.mayLeave()) return
    const generation = this.generation, version = this.buffer.editVersion
    try {
      const snapshot = await this.api.readFile(path)
      if (this.closing) await this.interactive()
      if (generation === this.generation && version === this.buffer.editVersion) this.load(snapshot)
    } catch (error) {
      if (this.closing) await this.interactive()
      if (generation !== this.generation || path !== this.buffer.path || version !== this.buffer.editVersion) return
      if (error instanceof Error && /\bENOENT\b/.test(error.message)) {
        this.conflict('当前文件原位置已不存在，不能重新载入；编辑内容仍保留，请另存副本或从文件树打开新位置。'); return
      }
      throw error
    }
  }

  async create(copy = false): Promise<void> {
    if (!this.project) { this.ui.notify('请先打开或创建一个本地项目。'); return }
    if (!copy && !await this.mayLeave()) return
    const suggested = copy ? this.buffer.path.replace(/(\.[^/.]+)?$/, '.local-copy$1') : 'section.tex'
    const path = await this.ui.input(copy ? '将编辑草稿另存为项目内的副本' : '创建项目内的文本文件', suggested)
    if (!path) return
    const version = this.buffer.editVersion
    const snapshot = await this.api.createFile(path, copy ? this.buffer.content : '')
    if (this.closing) await this.interactive()
    await this.refresh([])
    if (version === this.buffer.editVersion) this.load(snapshot)
    this.ui.notify(`已创建本地文件：${snapshot.path}`)
  }
}
