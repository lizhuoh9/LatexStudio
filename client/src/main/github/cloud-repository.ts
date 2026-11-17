import type { GitHubConnection, GitHubSettings, HistoryEntry, RepositoryStatus, SyncResult } from '../../shared/workspace-contracts'
import type { GitHubAccountService } from '../collaboration/service'
import { CollaborationError } from '../collaboration/validation'
import type { CredentialVault } from './credentials'
import { assertCloudAccess, readCloudBinding, type CloudBinding } from './cloud-binding'
import { GitHubRepository } from './repository'
import { GitHubError, publicError } from './policy'
import { snapshotRepositoryOperationOptions, type RepositoryOperationOptions } from './repository-operation'

/** Ordinary App routing. Binding is not authority; each sync obtains a fresh revocable write lease.
 * Tokens remain exclusively in the account service. Offline status/history/snapshots require no login.
 */
export class CloudRepository {
  private readonly repository: GitHubRepository
  private pending: Promise<unknown> = Promise.resolve()

  /** `confirmed` answers from the device's own record whether the user established or confirmed this exact link here.
   * The link file travels with the folder, so every route to an upload is refused until that is true.
   */
  constructor(private readonly root: string,
    private readonly accountService: Pick<GitHubAccountService, 'withWritableProjectAccess'>, vault: CredentialVault,
    private readonly confirmed: (binding: CloudBinding) => Promise<boolean>) {
    this.repository = new GitHubRepository(root, vault)
  }

  status(): Promise<RepositoryStatus> { return this.serial(() => this.repository.status()) }
  history(): Promise<HistoryEntry[]> { return this.serial(() => this.repository.history()) }
  snapshot(summary: string): Promise<HistoryEntry | null> { return this.serial(() => this.repository.snapshot(summary)) }
  disconnect(): Promise<void> { return this.serial(() => this.repository.disconnectApp()) }
  connect(_settings: GitHubSettings, _options: RepositoryOperationOptions = {}): Promise<GitHubConnection> {
    return Promise.reject(new GitHubError('普通合作使用 App 登录，不接受 PAT 覆盖关联。'))
  }

  sync(summary: string, options: RepositoryOperationOptions = {}): Promise<SyncResult> {
    let captured: Readonly<RepositoryOperationOptions>
    try { captured = snapshotRepositoryOperationOptions(options) } catch (error) { return Promise.reject(error) }
    return this.serial(async () => {
      if (captured.signal?.aborted) throw new GitHubError('已取消同步；本地历史仍保留。')
      // Auth or transport failure must not discard unsynced local work.
      await this.repository.snapshot(summary || '同步前保存本地快照')
      const binding = await readCloudBinding(this.root)
      if (!binding) throw new GitHubError('普通协作关联已解除；请重新明确选择项目，本地历史仍保留。')
      // Checked before any authorization request. The later reads below must equal the same fresh access as this
      // one, so the link that is uploaded is the link that was confirmed.
      if (!await this.confirmed(binding).catch(() => false)) {
        throw new GitHubError('此文件夹的云端关联尚未在这台设备上确认；请用论文栏的“同步”按钮确认后再试，本地历史仍保留。')
      }
      return this.accountService.withWritableProjectAccess(binding.projectId, async access => {
        access.check()
        if (access.project.private !== true) throw new GitHubError('普通合作仅支持已明确授权的私有项目；未同步。')
        assertCloudAccess(binding, access)
        // Binding must still be unchanged after fresh authorization, before any Git transfer.
        const current = await readCloudBinding(this.root)
        if (!current) throw new GitHubError('授权期间普通协作关联已解除；未同步。')
        assertCloudAccess(current, access)
        return this.repository.syncWithAccess(access, summary, { signal: access.signal, timeoutMs: captured.timeoutMs })
      }, captured)
    })
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action).catch((error: unknown) => {
      if (error instanceof CollaborationError) throw new GitHubError(error.message)
      throw publicError(error)
    })
    this.pending = result.catch(() => undefined)
    return result
  }
}
