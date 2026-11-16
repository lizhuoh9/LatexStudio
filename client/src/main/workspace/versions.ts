import type { RevisionDetail, RevisionEntry } from '../../shared/workspace-contracts'
import { VersionHistory } from '../local/version-history'
import { GitVersions } from '../github/git-versions'

/** Local save journal plus explicitly synchronized Git commits; neither is a live co-editing session. */
export class WorkspaceVersions {
  readonly journal: VersionHistory
  private readonly git: GitVersions

  constructor(root: string) {
    this.journal = new VersionHistory(root)
    this.git = new GitVersions(root)
  }

  async list(): Promise<RevisionEntry[]> {
    // Two independent read-only sources: read them together, let both settle, and keep the journal's failure first.
    const [journal, commits] = await Promise.allSettled([this.journal.list(), this.git.list()])
    if (journal.status === 'rejected') throw journal.reason
    if (commits.status === 'rejected') throw commits.reason
    return [...journal.value, ...commits.value].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
  }

  detail(id: string): Promise<RevisionDetail> {
    if (id.startsWith('git:')) {
      return this.git.detail(id)
    }
    return this.journal.detail(id)
  }
}
