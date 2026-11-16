import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAccountService } from '../src/main/collaboration/service'
import type { CollaborationState } from '../src/shared/collaboration-contracts'
import type { CredentialVault } from '../src/main/github/credentials'
import { WorkspaceCloud, type CloudWorkflowHost } from '../src/main/workspace/cloud-workflows'

const st = vi.hoisted(() => ({ binding: vi.fn(), connect: vi.fn(), clone: vi.fn(), roots: [] as string[] }))
vi.mock('../src/main/github/cloud-binding', () => ({ readCloudBinding: st.binding }))
vi.mock('../src/main/github/repository', () => ({ GitHubRepository: class {
  constructor(root: string) { st.roots.push(root) }
  connectWithAccess(...args: unknown[]) { return st.connect(...args) }
  cloneWithAccess(...args: unknown[]) { return st.clone(...args) }
} }))
const binding = { projectId: 1, owner: 'alice', name: 'paper', branch: 'main', accountId: 7 }
const project = { id: 1, installationId: 9, owner: 'alice', name: 'paper', private: true }
const session = (): CollaborationState => ({ phase: 'signed-in', account: { id: 7, login: 'alice', name: null },
  expiresAt: 9000, message: 'ready', authorization: null, sessionOnly: true })

function fixture() {
  let root: string | null = '/fixture/local', dirty = false, epoch = 0, sessionActive = true
  const account = {
    captureSessionGuard: vi.fn(() => () => { if (!sessionActive) throw new Error('登录会话已变化') }),
    status: vi.fn(session), projectSelections: vi.fn().mockResolvedValue([{ handle: 'selected', project }]),
    createPrivateProject: vi.fn().mockResolvedValue({ id: 1, owner: 'alice', name: 'paper', private: true, accessible: true }),
    withSelectedProjectAccess: vi.fn(async (_handle, action) => action({ project })),
    withProjectAccess: vi.fn(async (_id, action) => action({ project })),
    projectForLink: vi.fn().mockResolvedValue({ handle: 'linked', project }),
    inviteCollaborator: vi.fn().mockResolvedValue({ status: 'invited' }),
    invitations: vi.fn().mockResolvedValue([{ handle: 'invitation', projectId: 1, owner: 'alice', name: 'paper', inviter: 'alice' }]),
    acceptInvitation: vi.fn().mockResolvedValue({ ...project, accessible: true })
  }
  const repo = { status: vi.fn(), sync: vi.fn().mockResolvedValue({ status: { connection: {}, conflict: false },
    uploaded: true, downloaded: false, message: 'done' }) }
  const host = {
    root: () => root, epoch: () => epoch, openAuthorization: vi.fn().mockResolvedValue(undefined),
    openInvitations: vi.fn().mockResolvedValue(undefined),
    requireSaved: () => { if (dirty) throw new Error('先保存') },
    confirmLeave: vi.fn().mockResolvedValue(true), directory: vi.fn().mockResolvedValue('/fixture/download'),
    confirm: vi.fn().mockResolvedValue(true), activate: vi.fn().mockResolvedValue({ root: '/fixture/download' }),
    refreshRepository: vi.fn(), repository: () => repo, changed: vi.fn(),
    transfer: vi.fn(async (_kind, action) => action(new AbortController().signal))
  }
  const cloud = new WorkspaceCloud(account as unknown as GitHubAccountService, {} as CredentialVault, host as CloudWorkflowHost)
  return { cloud, account, host, repo, dirty: (value: boolean) => { dirty = value },
    invalidate: () => { sessionActive = false }, edit: () => { epoch++ }, root: (value: string | null) => { root = value } }
}

beforeEach(() => { vi.clearAllMocks(); st.roots.length = 0; st.binding.mockReset().mockResolvedValue(null); st.connect.mockResolvedValue(undefined); st.clone.mockResolvedValue(undefined) })

describe('ordinary private GitHub workspace orchestration', () => {
  it('opens only the host-controlled App authorization entry', async () => {
    const f = fixture(); await f.cloud.openAuthorization()
    expect(f.host.openAuthorization).toHaveBeenCalledOnce()
    expect(f.account.createPrivateProject).not.toHaveBeenCalled()
  })

  it('creates with only a name and connects a freshly selected private project without uploading', async () => {
    const f = fixture()
    expect(await f.cloud.createPrivateProject('paper')).toMatchObject({ connected: true, project: { private: true } })
    expect(f.account.createPrivateProject.mock.calls[0]![0]).toBe('paper')
    expect(f.account.withSelectedProjectAccess).toHaveBeenCalledWith('selected', expect.any(Function), expect.any(Object))
    expect(st.connect).toHaveBeenCalledOnce()
    expect(f.repo.sync).not.toHaveBeenCalled()
  })

  it('does not connect or upload if a created response is unexpectedly public', async () => {
    const f = fixture(); f.account.createPrivateProject.mockResolvedValueOnce({ ...project, private: false, accessible: true })
    await expect(f.cloud.createPrivateProject('paper')).rejects.toThrow('无法确认仓库为私有')
    expect(f.account.projectSelections).not.toHaveBeenCalled()
    expect(st.connect).not.toHaveBeenCalled(); expect(f.repo.sync).not.toHaveBeenCalled()
  })

  it('reports installation authorization needed without repeating creation', async () => {
    const f = fixture(); f.account.createPrivateProject.mockResolvedValueOnce({ ...project, accessible: false })
    expect(await f.cloud.createPrivateProject('paper')).toMatchObject({ connected: false, message: expect.stringContaining('不要重复创建') })
    expect(f.account.createPrivateProject).toHaveBeenCalledOnce(); expect(st.connect).not.toHaveBeenCalled()
  })

  it('blocks cloud creation without a local project or with dirty edits/existing binding', async () => {
    const f = fixture(); f.root(null)
    await expect(f.cloud.createPrivateProject('paper')).rejects.toThrow('本地论文')
    f.root('/fixture/local'); f.dirty(true)
    await expect(f.cloud.createPrivateProject('paper')).rejects.toThrow('先保存')
    f.dirty(false); st.binding.mockResolvedValue(binding)
    await expect(f.cloud.createPrivateProject('paper')).rejects.toThrow('已关联')
    expect(f.account.createPrivateProject).not.toHaveBeenCalled()
  })

  it('refuses public selections even when the session can read them', async () => {
    const f = fixture(); f.account.withSelectedProjectAccess.mockImplementationOnce(async (_handle, action) => action({ project: { ...project, private: false } }))
    await expect(f.cloud.linkProject('selected')).rejects.toThrow('私有项目')
    expect(st.connect).not.toHaveBeenCalled()
  })

  it('downloads through a fresh selected capability then switches projects only on completion', async () => {
    const f = fixture()
    expect(await f.cloud.joinProject('https://github.com/alice/paper')).toMatchObject({ root: '/fixture/download' })
    expect(f.account.projectForLink).toHaveBeenCalledWith('https://github.com/alice/paper')
    expect(f.account.withSelectedProjectAccess.mock.calls[0]![0]).toBe('linked')
    expect(st.clone).toHaveBeenCalledOnce(); expect(f.host.activate).toHaveBeenCalledOnce()
  })

  it.each(['latexstudio://join/alice/paper.git', 'https://github.com/alice/paper.git/'])('joins %s through the original selected private repository and local chooser', async link => {
    const f = fixture(), literal = { ...project, name: 'paper.git' }
    f.account.projectForLink.mockResolvedValueOnce({ handle: 'literal-dot-git', project: literal })
    f.account.withSelectedProjectAccess.mockImplementationOnce(async (_handle, action) => action({ project: literal }))
    expect(await f.cloud.joinProject(link)).toMatchObject({ root: '/fixture/download' })
    expect(f.account.projectForLink).toHaveBeenCalledExactlyOnceWith('https://github.com/alice/paper.git')
    expect(f.host.confirmLeave).toHaveBeenCalledOnce()
    expect(f.host.directory).toHaveBeenCalledExactlyOnceWith('选择空文件夹下载 GitHub 私有论文项目')
    expect(f.host.transfer).toHaveBeenCalledWith('clone', expect.any(Function))
    expect(f.account.withSelectedProjectAccess).toHaveBeenCalledWith('literal-dot-git', expect.any(Function), expect.any(Object))
    expect(st.roots).toEqual(['/fixture/download'])
    expect(st.clone.mock.calls[0]![0]).toEqual({ project: literal })
    expect(f.host.activate).toHaveBeenCalledWith('/fixture/download', expect.any(AbortSignal), expect.any(Function))
    expect(f.account.createPrivateProject).not.toHaveBeenCalled(); expect(st.connect).not.toHaveBeenCalled()
    expect(f.repo.sync).not.toHaveBeenCalled()
  })

  it.each(['latexstudio://join/alice/paper?x=1', 'latexstudio://join/alice/%2e%2e',
    'https://PRIVATE@github.com/alice/paper', 'file:///paper'])('rejects %s before account lookup or native directory work', async link => {
    const f = fixture()
    await expect(f.cloud.joinProject(link)).rejects.toThrow('项目分享链接无效')
    expect(f.account.projectForLink).not.toHaveBeenCalled(); expect(f.host.confirmLeave).not.toHaveBeenCalled()
    expect(f.host.directory).not.toHaveBeenCalled(); expect(f.host.transfer).not.toHaveBeenCalled()
    expect(st.clone).not.toHaveBeenCalled(); expect(f.host.root()).toBe('/fixture/local')
  })

  it.each(['draft-declined', 'folder-canceled'] as const)('keeps original project/root/binding when join is %s', async reason => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    if (reason === 'draft-declined') f.host.confirmLeave.mockResolvedValueOnce(false)
    else f.host.directory.mockResolvedValueOnce(null)
    expect(await f.cloud.joinProject('latexstudio://join/alice/paper')).toBeNull()
    expect(f.host.root()).toBe('/fixture/local')
    expect(await f.cloud.status()).toMatchObject({ connection: { projectId: 1, owner: 'alice', name: 'paper', branch: 'main' } })
    expect(f.account.withSelectedProjectAccess).not.toHaveBeenCalled(); expect(st.roots).toEqual([])
    expect(st.clone).not.toHaveBeenCalled(); expect(f.host.activate).not.toHaveBeenCalled()
    expect(f.account.createPrivateProject).not.toHaveBeenCalled(); expect(st.connect).not.toHaveBeenCalled()
    if (reason === 'draft-declined') expect(f.host.directory).not.toHaveBeenCalled()
  })

  it('keeps subsequent edit/sync on the downloaded original binding, never creates a new repository', async () => {
    const f = fixture()
    f.host.activate.mockImplementationOnce(async (root: string) => {
      f.root(root); st.binding.mockResolvedValue(binding); return { root }
    })
    await f.cloud.joinProject('latexstudio://join/alice/paper')
    f.dirty(true); await expect(f.cloud.sync('edit', false)).rejects.toThrow('先保存')
    f.dirty(false); await expect(f.cloud.sync('edit', false)).resolves.toMatchObject({ uploaded: true })
    expect(f.host.root()).toBe('/fixture/download')
    expect(await f.cloud.shareProject()).toBe('https://github.com/alice/paper')
    expect(f.repo.sync).toHaveBeenCalledExactlyOnceWith('edit', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(f.account.createPrivateProject).not.toHaveBeenCalled(); expect(st.connect).not.toHaveBeenCalled()
    expect(f.host.directory).toHaveBeenCalledOnce()
  })

  it('carries a true session guard through activation and does not switch on a late logout', async () => {
    const f = fixture()
    f.host.activate.mockImplementationOnce(async (_root: string, _signal: AbortSignal, check: () => void) => {
      f.invalidate(); check()
      return { root: '/fixture/download' }
    })
    await expect(f.cloud.downloadProject('selected')).rejects.toThrow('登录会话已变化')
    expect(f.account.captureSessionGuard).toHaveBeenCalledOnce()
  })

  it('does not activate when owned access cleanup rejects after clone', async () => {
    const f = fixture()
    f.account.withSelectedProjectAccess.mockImplementationOnce(async (_handle, action) => {
      await action({ project }); throw new Error('cleanup failed')
    })
    await expect(f.cloud.downloadProject('selected')).rejects.toThrow('cleanup failed')
    expect(f.host.activate).not.toHaveBeenCalled()
  })

  it('does not discard drafts or switch a failed/canceled download', async () => {
    const f = fixture(); f.host.confirmLeave.mockResolvedValueOnce(false)
    expect(await f.cloud.downloadProject('selected')).toBeNull(); expect(st.clone).not.toHaveBeenCalled()
    st.clone.mockRejectedValueOnce(new Error('network'))
    await expect(f.cloud.downloadProject('selected')).rejects.toThrow('network')
    expect(f.host.activate).not.toHaveBeenCalled()
  })

  it('shares only a newly authorized matching private repository link', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    expect(await f.cloud.shareProject()).toBe('https://github.com/alice/paper')
    st.binding.mockResolvedValueOnce({ ...binding, name: 'paper.git' })
    f.account.withProjectAccess.mockImplementationOnce(async (_id, action) => action({ project: { ...project, name: 'paper.git' } }))
    expect(await f.cloud.shareProject()).toBe('https://github.com/alice/paper.git')
    f.account.withProjectAccess.mockImplementationOnce(async (_id, action) => action({ project: { ...project, owner: 'other' } }))
    await expect(f.cloud.shareProject()).rejects.toThrow('身份或私有状态变化')
  })

  it('confirms invitations and acceptance and whitelists list results', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    f.host.confirm.mockResolvedValueOnce(false)
    await expect(f.cloud.inviteCollaborator('bob')).rejects.toThrow('取消邀请')
    expect(f.account.inviteCollaborator).not.toHaveBeenCalled()
    expect(await f.cloud.inviteCollaborator('bob')).toMatchObject({ message: expect.stringContaining('邀请已发送') })
    expect(await f.cloud.invitations()).toEqual([{ handle: 'invitation', owner: 'alice', name: 'paper', inviter: 'alice' }])
    expect(await f.cloud.acceptInvitation('invitation')).toMatchObject({ message: expect.stringContaining('已接受') })
  })

  it('rechecks session and every binding field after invitation confirmation', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    f.host.confirm.mockImplementationOnce(async () => { f.invalidate(); return true })
    await expect(f.cloud.inviteCollaborator('bob')).rejects.toThrow('登录会话已变化')
    expect(f.account.inviteCollaborator).not.toHaveBeenCalled()
    const g = fixture()
    g.host.confirm.mockImplementationOnce(async () => {
      st.binding.mockResolvedValue({ ...binding, branch: 'changed' }); return true
    })
    await expect(g.cloud.inviteCollaborator('bob')).rejects.toThrow('关联变化')
    expect(g.account.inviteCollaborator).not.toHaveBeenCalled()
  })

  it('passes the exact confirmed owner/name to fresh admin authorization', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    await f.cloud.inviteCollaborator('bob')
    expect(f.account.inviteCollaborator).toHaveBeenCalledWith(1, 'bob', {}, { owner: 'alice', name: 'paper' })
  })

  it('uses the explicit Sync action without a second popup and still requires saved drafts', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding); f.dirty(true)
    await expect(f.cloud.sync('progress', false)).rejects.toThrow('先保存')
    expect(f.repo.sync).not.toHaveBeenCalled()
    f.dirty(false)
    await expect(f.cloud.sync('progress', false)).resolves.toMatchObject({ uploaded: true })
    expect(f.host.confirm).not.toHaveBeenCalled()
    expect(f.repo.sync).toHaveBeenCalledOnce()
  })

  it.each(['edit', 'project', 'session'] as const)('rechecks %s after async sync preparation without sending files', async kind => {
    const f = fixture()
    st.binding.mockImplementationOnce(async () => {
      if (kind === 'edit') f.edit()
      else if (kind === 'project') f.root('/fixture/other')
      else f.invalidate()
      return binding
    })
    await expect(f.cloud.sync('progress', false)).rejects.toThrow(kind === 'session' ? '登录会话已变化' : '状态变化')
    expect(f.repo.sync).not.toHaveBeenCalled()
    expect(f.host.confirm).not.toHaveBeenCalled()
  })

  it('requires explicit session consent for background sync and stops after the first error', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    await expect(f.cloud.sync('progress', true)).rejects.toThrow('自动同步')
    expect(await f.cloud.setAutoSync(true)).toMatchObject({ autoSync: true })
    expect(await f.cloud.sync('progress', true)).toMatchObject({ uploaded: true })
    expect(f.host.changed).toHaveBeenCalledOnce()
    f.repo.sync.mockRejectedValueOnce(new Error('unknown push acknowledgement'))
    await expect(f.cloud.sync('progress', true)).rejects.toThrow('unknown push')
    expect(await f.cloud.status()).toMatchObject({ autoSync: false })
    await expect(f.cloud.sync('progress', true)).rejects.toThrow('自动同步')
    expect(f.repo.sync).toHaveBeenCalledTimes(2)
  })

  it('stops auto sync on conflict, changed project or session expiry', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    await f.cloud.setAutoSync(true)
    f.repo.sync.mockResolvedValueOnce({ status: { connection: {}, conflict: true }, uploaded: false, downloaded: false, message: 'conflict' })
    await f.cloud.sync('progress', true); expect((await f.cloud.status()).autoSync).toBe(false)
    await f.cloud.setAutoSync(true); f.root('/fixture/other'); expect((await f.cloud.status()).autoSync).toBe(false)
    f.root('/fixture/local'); await f.cloud.setAutoSync(true)
    f.account.status.mockReturnValueOnce({ ...session(), phase: 'signed-out', account: null })
    expect((await f.cloud.status()).autoSync).toBe(false)
  })
})
