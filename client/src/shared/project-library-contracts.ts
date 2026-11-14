import type { ProjectInfo } from './workspace-contracts'

/** Locally remembered folder metadata only; no project contents, credentials or remote capability. */
export interface ProjectLibraryEntry {
  id: string
  name: string
  root: string
  lastOpenedAt: string
  /** Runtime-only content-file mtime, or unknown; never persisted or used as sync/write authority. */
  lastModifiedAt?: string | null
  /** Derived by Main for display only, never used as repository authority or persisted by the folder registry. */
  github?: { owner: string; name: string } | null
  syncIssue?: boolean
}
export interface ProjectLibraryState {
  projects: ProjectLibraryEntry[]
  activeId: string | null
}
export interface ProjectLibraryApi {
  list(): Promise<ProjectLibraryState>
  activate(id: string): Promise<ProjectInfo | null>
  forget(id: string): Promise<ProjectLibraryState>
  onChanged(listener: () => void): () => void
}
export const PROJECT_LIBRARY_CHANNELS = {
  list: 'projects:list', activate: 'projects:activate', forget: 'projects:forget', changed: 'projects:changed'
} as const
