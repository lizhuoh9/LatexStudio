import fs from 'node:fs'
import { readdir } from 'node:fs/promises'
import git, { type HttpClient } from 'isomorphic-git'
import type { GitHubConnection, GitHubSettings, HistoryEntry, RepositoryStatus, SyncResult } from '../../shared/workspace-contracts'
import { CredentialVault } from './credentials'
import { rememberOperationDiagnostic, readOperationDiagnostic } from './operation-diagnostic'
import { assertProjectDirectory, assertWorkingFiles, checkCheckout, headOid, validateTree, type GitReadCache, type ValidatedTrees } from './files'
import { ensureRepository, localChanges, localHistory, saveSnapshot } from './local-history'
import { author, emptyMetadata, readMetadata, writeMetadata, type RepositoryMetadata } from './metadata'
import { mergeCommentDivergence } from './comment-merge'
import { githubTarget, GitHubError, publicError, sameRepository } from './policy'
import { snapshotRepositoryConnection, snapshotRepositoryOperationOptions, withRepositoryOperation,
  type RepositoryConnectionSettings, type RepositoryOperationOptions, type RepositoryOperationScope } from './repository-operation'
import { githubHttp, verifyGitHub, type GitHubIdentity } from './transport'
import { assertWritableProjectAccess, type ReadonlyProjectAccess, type WritableProjectAccess } from '../collaboration/project-access'
import { assertCloudAccess, cloudBindingForAccess, readCloudBinding, removeCloudBinding, writeCloudBinding } from './cloud-binding'
export type { RepositoryOperationOptions } from './repository-operation'

/** Conservative, snapshot-first synchronization; never merges file contents or force-updates history.
 * The one automatic merge is for diverged histories where one side changed only per-device comment logs
 * (see comment-merge.ts); every other divergence stops as a conflict with both histories kept.
 * Optional cancellation is cooperative: awaited Git/FS writes may leave partial local changes.
 * A push may have been accepted before a cancellation or acknowledgement failure is observed.
 */
export class GitHubRepository {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly root: string, private readonly vault: CredentialVault) {}

  status(): Promise<RepositoryStatus> {
    return this.serial(async () => { await ensureRepository(this.root); return this.readStatus() })
  }

  connect(settings: GitHubSettings, options: RepositoryOperationOptions = {}): Promise<GitHubConnection> {
    return this.connectionOperation(settings, options, async (scope, { target, token }) => {
      await scope.step(() => this.requireLegacyRoute())
      await scope.mutate(() => ensureRepository(this.root))
      await scope.step(() => assertWorkingFiles(this.root))
      const origin = await scope.step(() => git.getConfig({ fs, dir: this.root, path: 'remote.origin.url' }))
      if (origin && !sameRepository(origin, target.url)) throw new GitHubError('此项目已关联其他远端，未修改原关联；请先明确解除关联或使用空目录下载。')
      const identity = await scope.step(() => verifyGitHub(target, token, { signal: scope.signal }))
      await this.selectBranch(identity.branch, scope)
      if (!origin) await scope.mutate(() => git.addRemote({ fs, dir: this.root, remote: 'origin', url: target.url }))
      const connection = { ...target, login: identity.login, branch: identity.branch }
      await this.remember(connection, identity, token, scope)
      return connection
    })
  }

  clone(settings: GitHubSettings, options: RepositoryOperationOptions = {}): Promise<GitHubConnection> {
    return this.connectionOperation(settings, options, async (scope, { target, token }) => {
      await scope.step(() => assertProjectDirectory(this.root))
      if ((await scope.step(() => readdir(this.root))).length !== 0) throw new GitHubError('下载项目只能使用空目录，现有文件未修改。')
      const identity = await scope.step(() => verifyGitHub(target, token, { signal: scope.signal }))
      const http = scope.own(githubHttp(target, token, { signal: scope.signal, readOnly: true }))
      await this.cloneObjects(target.url, identity.branch, http, scope)
      const connection = { ...target, login: identity.login, branch: identity.branch }
      await this.remember(connection, identity, token, scope)
      return connection
    })
  }

  disconnect(): Promise<void> { return this.disconnectRoute(false) }

  /** Removing an App association never loads, removes or modifies legacy Vault entries. */
  disconnectApp(): Promise<void> { return this.disconnectRoute(true) }

  private disconnectRoute(appOnly: boolean): Promise<void> {
    return this.serial(async () => {
      await ensureRepository(this.root)
      const metadata = await readMetadata(this.root), cloud = await readCloudBinding(this.root)
      if (metadata.connection) {
        if (!cloud && !appOnly) await this.vault.remove(metadata.connection.url.toLowerCase())
        const origin = await git.getConfig({ fs, dir: this.root, path: 'remote.origin.url' })
        if (origin && sameRepository(origin, metadata.connection.url)) await git.deleteRemote({ fs, dir: this.root, remote: 'origin' })
      }
      await writeMetadata(this.root, emptyMetadata())
      if (cloud) await removeCloudBinding(this.root)
    })
  }

  snapshot(summary: string): Promise<HistoryEntry | null> {
    return this.serial(async () => {
      await ensureRepository(this.root)
      return saveSnapshot(this.root, await readMetadata(this.root), summary)
    })
  }

  sync(summary: string, options: RepositoryOperationOptions = {}): Promise<SyncResult> {
    return this.operation(options, async (scope) => {
      await scope.mutate(() => ensureRepository(this.root))
      const metadata = await scope.step(() => readMetadata(this.root))
      await scope.mutate(() => saveSnapshot(this.root, metadata, summary || '同步前保存本地快照'))
      if (!metadata.connection) return scope.step(() => this.result(false, false, '已保存本地历史；关联 GitHub 后可同步。'))
      await scope.step(() => this.requireLegacyRoute())
      const token = await this.authorize(metadata, scope)
      const http = scope.own(githubHttp(githubTarget(metadata.connection.url), token, { signal: scope.signal }))
      return this.synchronize(metadata, http, scope)
    })
  }

  /** Main-only lease entrypoints. The account service owns the borrowed HTTP lifetime. */
  connectWithAccess(access: ReadonlyProjectAccess, options: RepositoryOperationOptions = {}): Promise<GitHubConnection> {
    return this.accessOperation(access, options, async scope => {
      await scope.mutate(() => ensureRepository(this.root))
      await scope.step(() => assertWorkingFiles(this.root))
      const previous = await scope.step(() => readCloudBinding(this.root))
      if (previous) assertCloudAccess(previous, access)
      const origin = await scope.step(() => git.getConfig({ fs, dir: this.root, path: 'remote.origin.url' }))
      if (origin && !sameRepository(origin, access.target.url)) throw new GitHubError('此目录已关联其他项目；原历史与关联未替换。')
      await this.selectBranch(access.branch, scope)
      if (!origin) await scope.mutate(() => git.addRemote({ fs, dir: this.root, remote: 'origin', url: access.target.url }))
      return this.rememberAccess(access, scope)
    })
  }

  cloneWithAccess(access: ReadonlyProjectAccess, options: RepositoryOperationOptions = {}): Promise<GitHubConnection> {
    return this.accessOperation(access, options, async scope => {
      await scope.step(() => assertProjectDirectory(this.root))
      if ((await scope.step(() => readdir(this.root))).length) throw new GitHubError('下载项目只能使用空目录，现有文件未修改。')
      await this.cloneObjects(access.target.url, access.branch, this.borrowedHttp(access, scope), scope)
      return this.rememberAccess(access, scope)
    })
  }

  syncWithAccess(access: WritableProjectAccess, summary: string, options: RepositoryOperationOptions = {}): Promise<SyncResult> {
    try { assertWritableProjectAccess(access) } catch (error) { return Promise.reject(publicError(error)) }
    return this.accessOperation(access, options, async scope => {
      assertWritableProjectAccess(access)
      await scope.mutate(() => ensureRepository(this.root))
      const binding = await scope.step(() => readCloudBinding(this.root))
      if (!binding) throw new GitHubError('项目尚未绑定普通协作，请重新明确选择。')
      assertCloudAccess(binding, access)
      const metadata = await scope.step(() => readMetadata(this.root)), connection = metadata.connection
      if (!connection || metadata.accountId !== access.account.id || connection.login !== access.account.login ||
        connection.branch !== access.branch || !sameRepository(connection.url, access.target.url)) throw new GitHubError('普通协作关联已变化；未连接其他项目。')
      const origin = await scope.step(() => git.getConfig({ fs, dir: this.root, path: 'remote.origin.url' }))
      if (!origin || !sameRepository(origin, access.target.url)) throw new GitHubError('项目远端已被更改；未同步，本地历史已保留。')
      await this.selectBranch(access.branch, scope)
      await scope.mutate(() => saveSnapshot(this.root, metadata, summary || '同步前保存本地快照'))
      return this.synchronize(metadata, this.borrowedHttp(access, scope), scope)
    })
  }

  history(): Promise<HistoryEntry[]> {
    return this.serial(async () => { await ensureRepository(this.root); return localHistory(this.root) })
  }

  private accessOperation<T>(access: ReadonlyProjectAccess, options: RepositoryOperationOptions,
    action: (scope: RepositoryOperationScope) => Promise<T>): Promise<T> {
    let captured: Readonly<RepositoryOperationOptions>
    try { cloudBindingForAccess(access); captured = snapshotRepositoryOperationOptions(options) }
    catch (error) { return Promise.reject(publicError(error)) }
    return this.operation({ ...captured, signal: captured.signal ?? access.signal }, async scope => {
      const checked = async <R>(work: () => Promise<R>): Promise<R> => {
        access.check(); const value = await work(); access.check(); return value
      }
      const borrowed: RepositoryOperationScope = {
        signal: scope.signal, check: () => { scope.check(); access.check() },
        step: work => scope.step(() => checked(work)), mutate: work => scope.mutate(() => checked(work)),
        remoteWrite: work => scope.remoteWrite(() => checked(work)), own: client => scope.own(client),
      }
      borrowed.check(); const value = await action(borrowed); borrowed.check(); return value
    })
  }

  private borrowedHttp(access: ReadonlyProjectAccess, scope: RepositoryOperationScope): HttpClient {
    // The lease owns close; each request additionally observes THIS operation's cancellation/deadline.
    return { request: request => scope.step(() => access.http.request({ ...request, signal: scope.signal })) }
  }

  private async rememberAccess(access: ReadonlyProjectAccess, scope: RepositoryOperationScope): Promise<GitHubConnection> {
    const connection = { ...githubTarget(access.target.url), login: access.account.login, branch: access.branch }
    // Write routing first: a later failure must not fall back to an old stored PAT.
    await scope.mutate(() => writeCloudBinding(this.root, cloudBindingForAccess(access)))
    await scope.mutate(() => writeMetadata(this.root, { version: 1, connection, accountId: access.account.id, conflict: false }))
    return connection
  }

  private async requireLegacyRoute(): Promise<void> {
    if (await readCloudBinding(this.root)) throw new GitHubError('此项目使用普通协作会话；请重新登录后同步，不使用旧开发者凭据。')
  }

  private async cloneObjects(url: string, branch: string, http: HttpClient, scope: RepositoryOperationScope): Promise<void> {
    await scope.mutate(() => git.clone({ fs, dir: this.root, http, url, ref: `refs/heads/${branch}`,
      singleBranch: true, noCheckout: true, noTags: true }))
    const oid = await scope.step(() => headOid(this.root))
    if (oid) {
      await scope.step(() => validateTree(this.root, oid))
      await scope.step(() => checkCheckout(this.root, oid))
      await scope.mutate(() => git.checkout({ fs, dir: this.root, ref: `refs/heads/${branch}`, force: false }))
    } else await this.selectBranch(branch, scope)
  }

  private connectionOperation<T>(settings: GitHubSettings, options: RepositoryOperationOptions,
    action: (scope: RepositoryOperationScope, settings: Readonly<RepositoryConnectionSettings>) => Promise<T>): Promise<T> {
    let snapshot: Readonly<RepositoryOperationOptions>
    let connection: Readonly<RepositoryConnectionSettings>
    try { snapshot = snapshotRepositoryOperationOptions(options); connection = snapshotRepositoryConnection(settings) }
    catch (error) { return Promise.reject(error) }
    return this.serial(() => withRepositoryOperation(snapshot, (scope) => action(scope, connection)))
  }

  private operation<T>(options: RepositoryOperationOptions, action: (scope: RepositoryOperationScope) => Promise<T>): Promise<T> {
    let snapshot: Readonly<RepositoryOperationOptions>
    try { snapshot = snapshotRepositoryOperationOptions(options) } catch (error) { return Promise.reject(error) }
    return this.serial(() => withRepositoryOperation(snapshot, action))
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action).catch((error: unknown) => { throw publicError(error) })
    this.pending = result.catch(() => undefined)
    return result
  }

  private async readStatus(): Promise<RepositoryStatus> {
    const metadata = await readMetadata(this.root), cloud = await readCloudBinding(this.root)
    return { connection: metadata.connection, changes: await localChanges(this.root), conflict: metadata.conflict,
      message: `${metadata.conflict ? '两边历史存在分歧，本地快照已保留，请手动整理后重试。' :
        metadata.connection ? '已关联 GitHub；使用同步交换更改，不是实时协作。' : '本地历史可用，尚未关联 GitHub。'} ${cloud ? '普通协作使用当前内存登录会话；项目不保存凭据。' : this.vault.storageDescription}` }
  }

  private async selectBranch(branch: string, scope: RepositoryOperationScope): Promise<void> {
    const current = await scope.step(() => git.currentBranch({ fs, dir: this.root, fullname: false }))
    if (current === branch) return
    if (await scope.step(() => headOid(this.root))) throw new GitHubError('本地历史与远端默认历史不一致；请保留本地目录，并用空目录下载远端项目。')
    await scope.mutate(() => git.writeRef({ fs, dir: this.root, ref: 'HEAD', value: `refs/heads/${branch}`, symbolic: true, force: true }))
  }

  private async remember(connection: GitHubConnection, identity: GitHubIdentity, token: string, scope: RepositoryOperationScope): Promise<void> {
    await scope.mutate(() => this.vault.save(connection.url.toLowerCase(), token))
    await scope.mutate(() => writeMetadata(this.root, { version: 1, connection, accountId: identity.id, conflict: false }))
  }

  private async authorize(metadata: RepositoryMetadata, scope: RepositoryOperationScope): Promise<string> {
    const connection = metadata.connection!
    const origin = await scope.step(() => git.getConfig({ fs, dir: this.root, path: 'remote.origin.url' }))
    if (!origin || !sameRepository(origin, connection.url)) throw new GitHubError('远端关联已被更改，未同步；请重新确认仓库地址。')
    const token = await scope.step(() => this.vault.load(connection.url.toLowerCase()))
    if (!token) throw new GitHubError('请重新输入 GitHub 凭据；当前系统可能仅支持内存存储。本地快照已保留。')
    const identity = await scope.step(() => verifyGitHub(githubTarget(connection.url), token, { signal: scope.signal }))
    if (identity.id !== metadata.accountId || identity.login !== connection.login || identity.branch !== connection.branch) {
      throw new GitHubError('GitHub 账号或远端默认历史已变化，请重新关联；本地快照已保留。')
    }
    await this.selectBranch(connection.branch, scope)
    return token
  }

  private async synchronize(metadata: RepositoryMetadata, http: HttpClient, scope: RepositoryOperationScope): Promise<SyncResult> {
    const connection = metadata.connection!
    scope.check()
    const fetched = await scope.mutate(async () => {
      try { return await git.fetch({ fs, dir: this.root, http, url: connection.url, remote: 'origin',
        ref: `refs/heads/${connection.branch}`, singleBranch: true, tags: false }) }
      catch (error) {
        if (error !== null && typeof error === 'object' && !readOperationDiagnostic(error)) rememberOperationDiagnostic(error, 'git-fetch')
        throw error
      }
    })
    const remote = fetched.fetchHead
    const local = await scope.step(() => headOid(this.root))
    if (remote) await scope.step(() => validateTree(this.root, remote))
    if (remote && local !== remote) {
      if (!local || await scope.step(() => git.isDescendent({ fs, dir: this.root, oid: remote, ancestor: local }))) {
        return this.download(metadata, remote, scope)
      }
      if (!await scope.step(() => git.isDescendent({ fs, dir: this.root, oid: local, ancestor: remote }))) {
        const merged = await scope.mutate(() => mergeCommentDivergence(this.root, local, remote, author(metadata)))
        if (merged) return this.adoptCommentMerge(metadata, merged, http, scope)
        metadata.conflict = true
        await scope.mutate(() => writeMetadata(this.root, metadata))
        return scope.step(() => this.result(false, false, '同步存在冲突：两边独立历史均已保留，未覆盖或上传；请手动整理。'))
      }
    }
    if (local && local !== remote) {
      await this.validateOutgoingHistory(scope)
      if (!await this.upload(metadata, http, scope)) {
        metadata.conflict = true
        await scope.mutate(() => writeMetadata(this.root, metadata))
        return scope.step(() => this.result(false, false, '远端拒绝同步，可能已有其他账号的新更改；本地快照已保留，请重新同步。'))
      }
    }
    metadata.conflict = false
    await scope.mutate(() => writeMetadata(this.root, metadata))
    return scope.step(() => this.result(!!local && local !== remote, false, local === remote ? '本地与远端已同步。' : '本地快照已同步到 GitHub。'))
  }

  private async download(metadata: RepositoryMetadata, oid: string, scope: RepositoryOperationScope): Promise<SyncResult> {
    await scope.step(() => checkCheckout(this.root, oid))
    const branch = metadata.connection!.branch
    // Use only the already validated object; fastForward() would fetch again after validation.
    await scope.step(() => git.checkout({ fs, dir: this.root, ref: oid, noUpdateHead: true, track: false, force: false, dryRun: true }))
    await scope.mutate(() => git.checkout({ fs, dir: this.root, ref: oid, noUpdateHead: true, track: false, force: false }))
    await scope.mutate(() => git.writeRef({ fs, dir: this.root, ref: `refs/heads/${branch}`, value: oid, force: true }))
    metadata.conflict = false
    await scope.mutate(() => writeMetadata(this.root, metadata))
    return scope.step(() => this.result(false, true, '远端更改已同步到本地；同步前本地快照可在历史中查看。'))
  }

  /** A comment-only divergence was merged locally: check out the merge like a download, then upload it. */
  private async adoptCommentMerge(metadata: RepositoryMetadata, oid: string, http: HttpClient, scope: RepositoryOperationScope): Promise<SyncResult> {
    await scope.step(() => checkCheckout(this.root, oid))
    const branch = metadata.connection!.branch
    await scope.step(() => git.checkout({ fs, dir: this.root, ref: oid, noUpdateHead: true, track: false, force: false, dryRun: true }))
    await scope.mutate(() => git.checkout({ fs, dir: this.root, ref: oid, noUpdateHead: true, track: false, force: false }))
    await scope.mutate(() => git.writeRef({ fs, dir: this.root, ref: `refs/heads/${branch}`, value: oid, force: true }))
    await this.validateOutgoingHistory(scope)
    if (!await this.upload(metadata, http, scope)) {
      metadata.conflict = true
      await scope.mutate(() => writeMetadata(this.root, metadata))
      return scope.step(() => this.result(false, true, '已在本地合并双方的评论，但远端拒绝上传，可能又有新的更改；请重新同步。'))
    }
    metadata.conflict = false
    await scope.mutate(() => writeMetadata(this.root, metadata))
    return scope.step(() => this.result(true, true, '已自动合并双方的评论并同步到 GitHub。'))
  }

  private async upload(metadata: RepositoryMetadata, http: HttpClient, scope: RepositoryOperationScope): Promise<boolean> {
    const connection = metadata.connection!
    try {
      const pushed = await scope.remoteWrite(() => git.push({ fs, dir: this.root, http, url: connection.url, remote: 'origin',
        ref: `refs/heads/${connection.branch}`, remoteRef: `refs/heads/${connection.branch}`, force: false }))
      return pushed.ok && !Object.values(pushed.refs).some((ref) => !ref.ok)
    } catch (error) {
      if ((error as { code?: string }).code === 'PushRejectedError') return false
      throw error
    }
  }

  private async validateOutgoingHistory(scope: RepositoryOperationScope): Promise<void> {
    const entries = await scope.step(() => git.log({ fs, dir: this.root, depth: 1000 }))
    if (entries.length >= 1000) throw new GitHubError('历史过长，无法在安全限额内检查；本地快照已保留。')
    // One pass over this history, nothing written in between: commits sharing a root tree are checked once, and so
    // is every folder that did not change between two commits.
    const inspected = new Set<string>(), validated: ValidatedTrees = new Map(), cache: GitReadCache = {}
    for (const entry of entries) {
      scope.check()
      if (!inspected.has(entry.commit.tree)) await scope.step(() => validateTree(this.root, entry.oid, cache, validated))
      inspected.add(entry.commit.tree)
    }
  }

  private async result(uploaded: boolean, downloaded: boolean, message: string): Promise<SyncResult> {
    return { status: await this.readStatus(), uploaded, downloaded, message }
  }
}
