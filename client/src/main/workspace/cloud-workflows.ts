import type { CloudApi, CloudCreateResult, CloudWorkspaceStatus } from '../../shared/cloud-contracts'
import type { ProjectInfo, RepositoryStatus, SyncResult } from '../../shared/workspace-contracts'
import type { GitHubAccountService } from '../collaboration/service'
import { publicProject } from '../collaboration/public-state'
import { GitHubRepository } from '../github/repository'
import { readCloudBinding } from '../github/cloud-binding'
import type { CredentialVault } from '../github/credentials'
import { githubTarget } from '../github/remote-policy'
import type { RepositoryOperationOptions } from '../github/repository-operation'
import { requireText } from './validation'

type TransferKind = 'connect' | 'clone' | 'sync'
export interface CloudWorkflowHost {
  root(): string | null
  openAuthorization(): Promise<void>
  openInvitations(): Promise<void>
  requireSaved(): void
  epoch(): number
  confirmLeave(): Promise<boolean>
  directory(title: string): Promise<string | null>
  confirm(message: string, detail: string): Promise<boolean>
  activate(root: string, signal?: AbortSignal, verifySession?: () => void): Promise<ProjectInfo>
  refreshRepository(): Promise<void>
  repository(): { status(): Promise<RepositoryStatus>; sync(summary: string, options?: RepositoryOperationOptions): Promise<SyncResult> }
  transfer<T>(kind: TransferKind, action: (signal: AbortSignal) => Promise<T>): Promise<T>
  changed(): void
}

/** Main-only orchestration. Account credentials never enter the workspace/renderer contracts. */
export class WorkspaceCloud implements CloudApi {
  private autoConsent: { root: string; accountId: number; expiresAt: number | null } | null = null
  private lastSyncedAt: string | null = null

  constructor(private readonly account: GitHubAccountService, private readonly vault: CredentialVault,
    private readonly host: CloudWorkflowHost) {}

  async status(): Promise<CloudWorkspaceStatus> {
    const session = this.account.status(), root = this.host.root()
    const binding = root ? await readCloudBinding(root) : null
    const signedIn = session.phase === 'signed-in' && session.account !== null
    if (!binding || !this.autoConsent || !signedIn || this.autoConsent.root !== root || this.autoConsent.accountId !== session.account?.id ||
      this.autoConsent.expiresAt !== session.expiresAt) this.autoConsent = null
    return { configured: session.phase !== 'unconfigured', signedIn, account: session.account,
      connection: binding ? { projectId: binding.projectId, owner: binding.owner, name: binding.name, branch: binding.branch } : null,
      autoSync: this.autoConsent !== null, lastSyncedAt: this.lastSyncedAt,
      message: !signedIn ? session.message : binding ? 'GitHub 项目已关联；共享明确同步的提交，本地草稿不会直接上传。' :
        '已登录。打开本地论文后可一键创建私有合作项目，或下载已授权项目。' }
  }

  openAuthorization(): Promise<void> { return this.host.openAuthorization() }
  openInvitations(): Promise<void> { return this.host.openInvitations() }

  async projects() {
    return (await this.account.projectSelections()).filter(value => value.project.private)
      .map(value => ({ handle: value.handle, project: publicProject(value.project) }))
  }

  async createPrivateProject(name: string): Promise<CloudCreateResult> {
    const root = this.requireRoot()
    this.host.requireSaved()
    if (await readCloudBinding(root)) throw new Error('当前论文已关联合作项目，不会再创建仓库。')
    return this.host.transfer('connect', async signal => {
      const created = await this.account.createPrivateProject(requireText(name, '私有项目名称', 100), { signal })
      // Re-check even the internal return shape before linking or uploading any local content.
      if (created.private !== true) throw new Error('无法确认仓库为私有；未关联或上传本地论文，请核对远端。')
      const project = { id: created.id, owner: created.owner, name: created.name, private: true as const }
      if (!created.accessible) return { project, connected: false,
        message: '私有仓库已创建，但尚未确认本 GitHub App 可访问此仓库。请检查网络及 GitHub 安装设置中的授权范围，再刷新项目并关联；不要重复创建。' }
      const selections = await this.account.projectSelections()
      const selected = selections.find(value => value.project.id === created.id && value.project.private)
      if (!selected) return { project, connected: false, message: '私有仓库已创建，授权发现尚未就绪；请刷新项目列表后关联，不要重复创建。' }
      await this.connect(root, selected.handle, signal)
      return { project, connected: true, message: '已创建并关联私有合作项目。论文尚未上传，点击同步或明确开启自动同步后交换文件。' }
    })
  }

  async linkProject(handle: string): Promise<CloudWorkspaceStatus> {
    const root = this.requireRoot()
    this.host.requireSaved()
    await this.host.transfer('connect', signal => this.connect(root, requireText(handle, '项目选择', 512), signal))
    return this.status()
  }

  private async connect(root: string, handle: string, signal: AbortSignal): Promise<void> {
    this.host.requireSaved()
    await this.account.withSelectedProjectAccess(handle, access => {
      if (!access.project.private) throw new Error('普通合作只关联私有项目；不会自动更改仓库的公开状态。')
      return new GitHubRepository(root, this.vault).connectWithAccess(access, { signal })
    }, { signal })
    this.autoConsent = null
    await this.host.refreshRepository()
  }

  async downloadProject(handle: string): Promise<ProjectInfo | null> {
    if (!await this.host.confirmLeave()) return null
    const root = await this.host.directory('选择空文件夹下载 GitHub 私有论文项目')
    if (!root) return null
    return this.host.transfer('clone', async signal => {
      const verifySession = this.account.captureSessionGuard()
      await this.account.withSelectedProjectAccess(requireText(handle, '项目选择', 512), access => {
        if (!access.project.private) throw new Error('普通合作仅下载明确授权的私有项目。')
        return new GitHubRepository(root, this.vault).cloneWithAccess(access, { signal })
      }, { signal })
      if (signal.aborted) throw new Error('已请求取消；可能保留部分下载文件，当前项目不切换。')
      this.autoConsent = null
      verifySession()
      return this.host.activate(root, signal, verifySession)
    })
  }

  async joinProject(link: string): Promise<ProjectInfo | null> {
    const selected = await this.account.projectForLink(requireText(link, '项目分享链接', 2048))
    return this.downloadProject(selected.handle)
  }

  async shareProject(): Promise<string> {
    const binding = await this.requireBinding()
    return this.account.withProjectAccess(binding.projectId, async access => {
      this.checkBinding(binding, access.project)
      return githubTarget(`https://github.com/${binding.owner}/${binding.name}.git`).url.replace(/\.git$/, '')
    })
  }

  async inviteCollaborator(login: string) {
    const binding = await this.requireBinding()
    const root = this.requireRoot(), verifySession = this.account.captureSessionGuard()
    const recipient = requireText(login, '对方的 GitHub 用户名', 39)
    if (!await this.host.confirm(`邀请 ${recipient} 编辑私有项目？`,
      `${binding.owner}/${binding.name} 将授予该账号协作写入权限。对方需接受邀请；分享链接本身不授予权限。`)) {
      throw new Error('已取消邀请，没有发送本次请求。')
    }
    const fresh = await this.requireBinding()
    const keys = ['projectId', 'owner', 'name', 'branch', 'accountId'] as const
    if (root !== this.requireRoot() || keys.some(key => fresh[key] !== binding[key])) {
      throw new Error('确认期间账号或项目关联变化，请重新确认邀请；未发送本次请求。')
    }
    verifySession()
    const result = await this.account.inviteCollaborator(binding.projectId, recipient, {},
      { owner: binding.owner, name: binding.name })
    return { message: result.status === 'already-authorized' ? '该账号已拥有访问权限，无需重复邀请。' :
      '邀请已发送。对方登录自己的账号接受邀请并给 App 授权此仓库后，即可通过项目链接加入。' }
  }

  async invitations() {
    return (await this.account.invitations()).map(value => ({ handle: value.handle, owner: value.owner,
      name: value.name, inviter: value.inviter }))
  }

  async acceptInvitation(handle: string) {
    if (!await this.host.confirm('接受此 GitHub 仓库邀请？',
      '接受后你的账号将成为该私有项目的合作者。不会自动下载、上传论文或替你扩展 App 的仓库授权范围。')) {
      throw new Error('已取消接受邀请。')
    }
    const accepted = await this.account.acceptInvitation(requireText(handle, '邀请选择', 512))
    return { message: accepted.accessible ? '已接受邀请。刷新已授权项目后可下载，或粘贴分享链接加入。' :
      '已接受邀请。还需在 GitHub 为本 App 授权该仓库，再刷新项目；接受邀请不等于安装授权。' }
  }

  async sync(summary: string, background: boolean): Promise<SyncResult> {
    if (typeof background !== 'boolean') throw new Error('同步模式无效。')
    this.host.requireSaved()
    const status = await this.status()
    if (!status.connection || !status.signedIn) throw new Error('请先登录并关联私有合作项目。')
    if (background && !status.autoSync) throw new Error('尚未明确启用本次会话的自动同步。')
    const epoch = this.host.epoch()
    if (!background && !await this.host.confirm('保存并与 GitHub 私有项目同步？',
      `${status.connection.owner}/${status.connection.name}：将提交已保存文件并收发共享版本；不会强推或覆盖未保存草稿。`)) {
      throw new Error('已取消同步。')
    }
    this.host.requireSaved()
    if (epoch !== this.host.epoch()) throw new Error('确认期间编辑状态变化，请重新保存并同步。')
    try {
      const result = await this.host.transfer('sync', signal =>
        this.host.repository().sync(requireText(summary, '进展说明', 500), { signal }))
      if (result.status.conflict) this.autoConsent = null
      else this.lastSyncedAt = new Date().toISOString()
      this.host.changed()
      return result
    } catch (error) {
      // No background retry after an unknown upload acknowledgement or any failure.
      this.autoConsent = null
      throw error
    }
  }

  async setAutoSync(enabled: boolean): Promise<CloudWorkspaceStatus> {
    if (typeof enabled !== 'boolean') throw new Error('自动同步设置无效。')
    if (!enabled) { this.autoConsent = null; return this.status() }
    this.host.requireSaved()
    const root = this.requireRoot(), state = await this.status(), epoch = this.host.epoch()
    if (!state.signedIn || !state.account || !state.connection) throw new Error('请先登录并关联合作项目。')
    if (!await this.host.confirm('为此项目开启本次会话的自动同步？',
      'App 将在联网且草稿已保存时约每 30 秒尝试提交并交换项目文件。首次失败或冲突会停用，不无限重试；关闭、退出或换项目后需重新开启。')) {
      throw new Error('未开启自动同步。')
    }
    this.host.requireSaved()
    if (this.host.root() !== root || this.host.epoch() !== epoch) throw new Error('项目或编辑状态变化，请重新确认。')
    const session = this.account.status()
    if (session.phase !== 'signed-in' || session.account?.id !== state.account.id) throw new Error('登录状态已变化。')
    this.autoConsent = { root, accountId: state.account.id, expiresAt: session.expiresAt }
    return this.status()
  }

  private requireRoot(): string {
    const root = this.host.root()
    if (!root) throw new Error('请先打开或创建本地论文，再建立私有合作项目。')
    return root
  }
  private async requireBinding() {
    const binding = await readCloudBinding(this.requireRoot())
    if (!binding) throw new Error('此论文尚未关联 GitHub 私有合作项目。')
    const session = this.account.status()
    if (session.phase !== 'signed-in' || session.account?.id !== binding.accountId) {
      throw new Error('请登录此本地副本关联的账号，或重新明确关联项目；不会替其他账号发送操作。')
    }
    return binding
  }
  private checkBinding(binding: { projectId: number; owner: string; name: string },
    project: { id: number; owner: string; name: string; private: boolean }): void {
    if (!project.private || project.id !== binding.projectId || project.owner !== binding.owner || project.name !== binding.name) {
      throw new Error('云端项目身份或私有状态变化，请重新核对关联。')
    }
  }
}
