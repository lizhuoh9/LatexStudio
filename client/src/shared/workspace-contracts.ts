import type { SyncTexData } from './synctex'

export type TexEngine = 'pdflatex' | 'xelatex' | 'lualatex'

export interface ProjectFile {
  path: string
  kind: 'text' | 'binary' | 'directory'
  size: number
}

export interface ProjectInfo {
  id: string
  name: string
  root: string
  files: ProjectFile[]
  defaultMain: string | null
}

export interface DocumentSnapshot {
  path: string
  content: string
  revision: string
}

export interface TexEnvironment {
  available: boolean
  engines: TexEngine[]
  description: string
}

export interface CompileRequest {
  mainFile: string
  engine: TexEngine
}

export interface CompileResult {
  ok: boolean
  canceled: boolean
  log: string
  pdf: Uint8Array | null
  synctex?: SyncTexData | null
  durationMs: number
}

/** Saving the last successful compile's PDF; `stale` means sources may have changed since that compile. */
export type PdfSaveResult = { saved: false } | { saved: true; path: string; stale: boolean }

export interface GitHubSettings {
  url: string
  token: string
}

export interface GitHubConnection {
  url: string
  owner: string
  repository: string
  login: string
  branch: string
}

export interface FileChange {
  path: string
  kind: 'added' | 'modified' | 'deleted'
}

export interface RepositoryStatus {
  connection: GitHubConnection | null
  changes: FileChange[]
  message: string
  conflict: boolean
}

export interface HistoryEntry {
  id: string
  summary: string
  author: string
  date: string
}

/** Shared, per-file versions. Authors are OS display names, not authenticated identities. */
export interface RevisionEntry {
  id: string
  path: string
  author: string
  date: string
  kind: 'create' | 'save' | 'restore' | 'external'
  summary: string
  beforeRevision: string | null
  afterRevision: string
}

export interface RevisionDetail {
  entry: RevisionEntry
  before: string | null
  after: string
}

export interface SyncResult {
  status: RepositoryStatus
  uploaded: boolean
  downloaded: boolean
  message: string
}

export interface RepositoryTransferState {
  sequence: number
  phase: 'idle' | 'running' | 'cancelling' | 'settled'
  kind: 'connect' | 'clone' | 'sync' | null
  message: string
}

export type WorkspaceEvent =
  | { kind: 'files-changed'; paths: string[] }
  | { kind: 'compile-log'; message: string }
  | { kind: 'sync-progress'; message: string }
  | { kind: 'repository-transfer'; state: RepositoryTransferState }
  | { kind: 'close-request'; requestId: string }
  | { kind: 'close-state'; closing: boolean }

export interface WorkspaceApi {
  project(): Promise<ProjectInfo | null>
  openProject(): Promise<ProjectInfo | null>
  createProject(): Promise<ProjectInfo | null>
  cloneProject(settings: GitHubSettings): Promise<ProjectInfo | null>
  files(): Promise<ProjectFile[]>
  readFile(path: string): Promise<DocumentSnapshot>
  saveFile(path: string, content: string, revision: string): Promise<DocumentSnapshot>
  createFile(path: string, content: string): Promise<DocumentSnapshot>
  environment(): Promise<TexEnvironment>
  compile(request: CompileRequest): Promise<CompileResult>
  cancelCompile(): Promise<void>
  savePdf(): Promise<PdfSaveResult>
  repository(): Promise<RepositoryStatus>
  connectGitHub(settings: GitHubSettings): Promise<GitHubConnection>
  disconnectGitHub(): Promise<void>
  snapshot(summary: string): Promise<HistoryEntry | null>
  sync(summary: string): Promise<SyncResult>
  history(): Promise<HistoryEntry[]>
  revisions(): Promise<RevisionEntry[]>
  revisionDetail(id: string): Promise<RevisionDetail>
  restoreRevision(id: string, revision: string): Promise<DocumentSnapshot>
  repositoryTransfer(): Promise<RepositoryTransferState>
  cancelRepositoryTransfer(): Promise<RepositoryTransferState>
  setDirty(dirty: boolean): void
  acknowledgeClose(requestId: string, dirty: boolean): void
  onEvent(listener: (event: WorkspaceEvent) => void): () => void
}

export const WORKSPACE_CHANNELS = {
  project: 'workspace:project', open: 'workspace:open', create: 'workspace:create',
  clone: 'workspace:clone', files: 'workspace:files', read: 'workspace:read',
  save: 'workspace:save', createFile: 'workspace:create-file', environment: 'workspace:environment',
  compile: 'workspace:compile', cancelCompile: 'workspace:cancel-compile', savePdf: 'workspace:save-pdf', repository: 'workspace:repository',
  connect: 'workspace:connect', disconnect: 'workspace:disconnect', snapshot: 'workspace:snapshot',
  sync: 'workspace:sync', history: 'workspace:history', dirty: 'workspace:dirty',
  revisions: 'workspace:revisions', revisionDetail: 'workspace:revision-detail', restoreRevision: 'workspace:restore-revision',
  transfer: 'workspace:repository-transfer', cancelTransfer: 'workspace:cancel-repository-transfer',
  closeAck: 'workspace:close-ack', event: 'workspace:event'
} as const
