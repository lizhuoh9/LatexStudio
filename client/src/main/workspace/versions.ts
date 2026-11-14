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
    const journal = await this.journal.list()
    const commits = await this.git.list()
    return [...journal, ...commits].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
  }

  detail(id: string): Promise<RevisionDetail> {
    if (id.startsWith('git:')) {
      return this.git.detail(id)
    }
    return this.journal.detail(id)
  }
}
