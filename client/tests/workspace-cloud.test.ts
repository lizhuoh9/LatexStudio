import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubAccountService } from '../src/main/collaboration/service'
import type { CollaborationState } from '../src/shared/collaboration-contracts'
import type { CredentialVault } from '../src/main/github/credentials'
import { WorkspaceCloud, type CloudWorkflowHost } from '../src/main/workspace/cloud-workflows'
import { translate } from '../src/shared/i18n'

const st = vi.hoisted(() => ({ binding: vi.fn(), connect: vi.fn(), clone: vi.fn(), roots: [] as string[] }))
vi.mock('../src/main/github/cloud-binding', () => ({ readCloudBinding: st.binding,
  cloudBindingForAccess: (access: { project: { id: number; owner: string; name: string } }) => ({ projectId: access.project.id,
    owner: access.project.owner, name: access.project.name, branch: 'main', accountId: 7 }) }))
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
  // Existing flows run on links this device already confirmed; the last block covers unconfirmed ones.
  const trust = { has: vi.fn().mockResolvedValue(true), remember: vi.fn().mockResolvedValue(true) }
  const cloud = new WorkspaceCloud(account as unknown as GitHubAccountService, {} as CredentialVault, host as CloudWorkflowHost, trust)
  return { cloud, account, host, repo, trust, dirty: (value: boolean) => { dirty = value },
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

describe('cloud links that were not established on this device', () => {
  const question = '确认此文件夹关联的云端项目是 alice/paper？'
  function unconfirmed() {
    const f = fixture(); st.binding.mockResolvedValue(binding); f.trust.has.mockResolvedValue(false)
    return f
  }

  it('asks once, naming the repository, before the first sync and then records the confirmation', async () => {
    const f = unconfirmed()
    await expect(f.cloud.sync('progress', false)).resolves.toMatchObject({ uploaded: true })
    expect(f.host.confirm).toHaveBeenCalledExactlyOnceWith(question, expect.stringContaining('不是在这台设备上'))
    const detail = f.host.confirm.mock.calls[0]![1] as string
    expect(detail.endsWith('\n文件夹：/fixture/local\n分支：main')).toBe(true)
    expect(detail).not.toContain('不再询问')
    expect(f.trust.has).toHaveBeenCalledWith('/fixture/local', binding)
    expect(f.trust.remember).toHaveBeenCalledExactlyOnceWith('/fixture/local', binding)
    expect(f.trust.remember.mock.invocationCallOrder[0]!).toBeLessThan(f.repo.sync.mock.invocationCallOrder[0]!)
    expect(f.repo.sync).toHaveBeenCalledOnce()
  })

  it.each(['/fixture/local', 'C:\\Users\\someone\\Documents\\My Paper (final)'])('shows the question in English and Korean with the literal folder %s', async root => {
    const f = unconfirmed(); f.root(root); f.host.confirm.mockResolvedValueOnce(false)
    await expect(f.cloud.sync('progress', false)).rejects.toThrow('未确认云端关联')
    const [title, detail] = f.host.confirm.mock.calls[0]! as [string, string]
    expect(translate(title, 'en')).toBe('Confirm that this folder\'s cloud project is alice/paper?')
    expect(translate(detail, 'en')).toMatch(/^This link was not set up through LatexStudio on this device/)
    expect(translate(detail, 'en').endsWith(`\nFolder: ${root}\nBranch: main`)).toBe(true)
    expect(translate(detail, 'ko').endsWith(`\n폴더: ${root}\n브랜치: main`)).toBe(true)
    for (const text of ['未确认云端关联，没有向 GitHub 发送任何内容。', '确认期间项目关联变化，请重新操作；未发送本次请求。',
      '此文件夹的云端关联尚未在这台设备上确认；请先手动点一次“同步”。',
      '此文件夹的云端关联尚未在这台设备上确认；请用论文栏的“同步”按钮确认后再试，本地历史仍保留。']) {
      expect(translate(text, 'en')).not.toBe(text); expect(translate(text, 'ko')).not.toBe(text)
    }
  })

  it('sends nothing and records nothing when the confirmation is declined', async () => {
    const f = unconfirmed(); f.host.confirm.mockResolvedValueOnce(false)
    await expect(f.cloud.sync('progress', false)).rejects.toThrow('未确认云端关联')
    expect(f.trust.remember).not.toHaveBeenCalled(); expect(f.repo.sync).not.toHaveBeenCalled()
    expect(f.host.transfer).not.toHaveBeenCalled()
  })

  it.each(['link', 'unlinked', 'edit', 'draft', 'project', 'session'] as const)('rechecks %s after the confirmation without sending files', async kind => {
    const f = unconfirmed()
    f.host.confirm.mockImplementationOnce(async () => {
      if (kind === 'draft') f.dirty(true)
      else if (kind === 'link') st.binding.mockResolvedValue({ ...binding, projectId: 2, name: 'other' })
      else if (kind === 'unlinked') st.binding.mockResolvedValue(null)
      else if (kind === 'edit') f.edit()
      else if (kind === 'project') f.root('/fixture/other')
      else f.invalidate()
      return true
    })
    await expect(f.cloud.sync('progress', false)).rejects.toThrow(
      kind === 'session' ? '登录会话已变化' : kind === 'edit' ? '状态变化' : kind === 'draft' ? '先保存' : '关联变化')
    expect(f.repo.sync).not.toHaveBeenCalled()
    if (kind === 'link' || kind === 'unlinked' || kind === 'project') expect(f.trust.remember).not.toHaveBeenCalled()
  })

  it.each(['edit', 'project', 'session'] as const)('rechecks %s after the link confirmation before enabling auto sync', async kind => {
    const f = unconfirmed()
    f.host.confirm.mockImplementationOnce(async () => {
      if (kind === 'edit') f.edit()
      else if (kind === 'project') f.root('/fixture/other')
      else f.account.status.mockReturnValue({ ...session(), phase: 'signed-out', account: null })
      return true
    })
    await expect(f.cloud.setAutoSync(true)).rejects.toThrow(kind === 'session' ? '登录状态已变化' : kind === 'edit' ? '状态变化' : '关联变化')
    f.account.status.mockImplementation(session); f.root('/fixture/local'); f.trust.has.mockResolvedValue(true)
    expect((await f.cloud.status()).autoSync).toBe(false)
  })

  it.each(['link', 'project', 'session'] as const)('rechecks %s after the link confirmation before inviting', async kind => {
    const f = unconfirmed()
    f.host.confirm.mockImplementationOnce(async () => {
      if (kind === 'link') st.binding.mockResolvedValue({ ...binding, branch: 'changed' })
      else if (kind === 'project') f.root('/fixture/other')
      else f.invalidate()
      return true
    })
    await expect(f.cloud.inviteCollaborator('bob')).rejects.toThrow(kind === 'session' ? '登录会话已变化' : '关联变化')
    expect(f.account.inviteCollaborator).not.toHaveBeenCalled()
  })

  it('asks nothing and reads the link no more often for a link this device already confirmed', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    await f.cloud.sync('progress', false)
    expect(f.host.confirm).not.toHaveBeenCalled(); expect(f.trust.remember).not.toHaveBeenCalled()
    expect(st.binding).toHaveBeenCalledOnce()
  })

  it('never asks from a background sync and stops auto sync instead', async () => {
    const f = fixture(); st.binding.mockResolvedValue(binding)
    await f.cloud.setAutoSync(true)
    f.host.confirm.mockClear(); f.trust.has.mockResolvedValue(false)
    await expect(f.cloud.sync('progress', true)).rejects.toThrow('尚未在这台设备上确认')
    expect(f.host.confirm).not.toHaveBeenCalled(); expect(f.repo.sync).not.toHaveBeenCalled()
    expect(f.trust.remember).not.toHaveBeenCalled()
    f.trust.has.mockResolvedValue(true)
    expect((await f.cloud.status()).autoSync).toBe(false)
  })

  it('records a link made by explicitly choosing or creating the project, from the fresh access and not the folder', async () => {
    const f = fixture(); f.trust.has.mockResolvedValue(false)
    await f.cloud.linkProject('selected')
    expect(f.trust.remember).toHaveBeenCalledExactlyOnceWith('/fixture/local', binding)
    expect(f.trust.remember.mock.invocationCallOrder[0]!).toBeGreaterThan(st.connect.mock.invocationCallOrder[0]!)
    expect(f.host.confirm).not.toHaveBeenCalled()
    const g = fixture(); g.trust.has.mockResolvedValue(false)
    await g.cloud.createPrivateProject('paper')
    expect(g.trust.remember).toHaveBeenCalledExactlyOnceWith('/fixture/local', binding)
  })

  it('does not record a link when connecting failed or the selection was public', async () => {
    const f = fixture(); st.connect.mockRejectedValueOnce(new Error('network'))
    await expect(f.cloud.linkProject('selected')).rejects.toThrow('network')
    f.account.withSelectedProjectAccess.mockImplementationOnce(async (_handle, action) => action({ project: { ...project, private: false } }))
    await expect(f.cloud.linkProject('selected')).rejects.toThrow('私有项目')
    expect(f.trust.remember).not.toHaveBeenCalled()
  })

  it('records a downloaded project for the folder that actually became active', async () => {
    const f = fixture(); f.trust.has.mockResolvedValue(false)
    f.host.activate.mockResolvedValueOnce({ root: '/fixture/canonical-download' })
    await f.cloud.downloadProject('selected')
    expect(f.trust.remember).toHaveBeenCalledExactlyOnceWith('/fixture/canonical-download', binding)
    expect(f.trust.remember.mock.invocationCallOrder[0]!).toBeGreaterThan(f.host.activate.mock.invocationCallOrder[0]!)
    expect(f.host.confirm).not.toHaveBeenCalled()
  })

  it('does not record a download that failed or never became active', async () => {
    const f = fixture(); st.clone.mockRejectedValueOnce(new Error('network'))
    await expect(f.cloud.downloadProject('selected')).rejects.toThrow('network')
    f.host.activate.mockRejectedValueOnce(new Error('not adopted'))
    await expect(f.cloud.downloadProject('selected')).rejects.toThrow('not adopted')
    expect(f.trust.remember).not.toHaveBeenCalled()
  })

  it('confirms the link before the auto sync question and enables nothing when it is declined', async () => {
    const f = unconfirmed(); f.host.confirm.mockResolvedValueOnce(false)
    await expect(f.cloud.setAutoSync(true)).rejects.toThrow('未确认云端关联')
    expect(f.host.confirm).toHaveBeenCalledExactlyOnceWith(question, expect.any(String))
    f.trust.has.mockResolvedValue(true)
    expect((await f.cloud.status()).autoSync).toBe(false)
    const g = unconfirmed()
    expect(await g.cloud.setAutoSync(true)).toMatchObject({ autoSync: true })
    expect(g.host.confirm.mock.calls.map(call => call[0])).toEqual([question, '为此项目开启本次会话的自动同步？'])
    expect(g.trust.remember).toHaveBeenCalledExactlyOnceWith('/fixture/local', binding)
  })

  it('confirms the link before the invitation question and invites nobody when it is declined', async () => {
    const f = unconfirmed(); f.host.confirm.mockResolvedValueOnce(false)
    await expect(f.cloud.inviteCollaborator('bob')).rejects.toThrow('未确认云端关联')
    expect(f.host.confirm).toHaveBeenCalledExactlyOnceWith(question, expect.any(String))
    expect(f.account.inviteCollaborator).not.toHaveBeenCalled()
    const g = unconfirmed()
    await g.cloud.inviteCollaborator('bob')
    expect(g.host.confirm.mock.calls.map(call => call[0])).toEqual([question, '邀请 bob 编辑私有项目？'])
    expect(g.account.inviteCollaborator).toHaveBeenCalledOnce()
  })

  it('still syncs after a confirmation that could not be saved', async () => {
    const f = unconfirmed(); f.trust.remember.mockResolvedValueOnce(false)
    await expect(f.cloud.sync('progress', false)).resolves.toMatchObject({ uploaded: true })
    expect(f.repo.sync).toHaveBeenCalledOnce()
  })

  it('offers a share link for an unconfirmed folder without asking, because nothing is written', async () => {
    const f = unconfirmed()
    expect(await f.cloud.shareProject()).toBe('https://github.com/alice/paper')
    expect(f.host.confirm).not.toHaveBeenCalled(); expect(f.trust.remember).not.toHaveBeenCalled()
  })
})
