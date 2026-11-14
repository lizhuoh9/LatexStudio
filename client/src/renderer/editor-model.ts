import type { DocumentSnapshot } from '../shared/workspace-contracts'

/** One in-memory draft; never uses localStorage, including for recovery. */
export class EditorBuffer {
  path = ''
  content = ''
  revision = ''
  savedContent = ''
  editVersion = 0
  conflict = false

  get dirty(): boolean { return this.content !== this.savedContent }

  load(snapshot: DocumentSnapshot): void {
    this.path = snapshot.path
    this.content = snapshot.content
    this.savedContent = snapshot.content
    this.revision = snapshot.revision
    this.conflict = false
    this.editVersion += 1
  }

  reset(): void {
    this.path = ''; this.content = ''; this.savedContent = ''; this.revision = ''
    this.conflict = false; this.editVersion += 1
  }

  edit(content: string): void {
    this.content = content
    this.editVersion += 1
  }

  saved(snapshot: DocumentSnapshot): boolean {
    if (snapshot.path !== this.path) return false
    this.revision = snapshot.revision
    this.savedContent = snapshot.content
    this.conflict = false
    return true
  }

  externalChange(paths: string[]): 'unrelated' | 'reload' | 'conflict' {
    if (!this.path || !paths.includes(this.path)) return 'unrelated'
    if (!this.dirty) return 'reload'
    this.conflict = true
    return 'conflict'
  }

  acceptReload(snapshot: DocumentSnapshot, version: number): boolean {
    if (this.path !== snapshot.path || this.dirty || this.editVersion !== version) return false
    this.load(snapshot)
    return true
  }
}

export function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : '操作未完成，请重试。'
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[已隐藏凭据]')
    .replace(/https:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[已隐藏凭据]@')
    .replace(/\bcommit\b/gi, '快照').replace(/\bpush\b/gi, '上传')
    .replace(/\bpull\b/gi, '下载').replace(/\bbranch\b/gi, '版本线')
    .replace(/\bmerge\b/gi, '合并')
}
