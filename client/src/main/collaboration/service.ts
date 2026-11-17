import { randomUUID } from 'node:crypto'
import { validStoredSession, type AccountSessionStore, type StoredSession } from './session-policy'
import type { CloudAccount, CloudProject, CollaborationState, DevicePrompt } from '../../shared/collaboration-contracts'
import { authorizeDevice, sleep, type Sleep } from './device-flow'
import { discoverProjects } from './projects'
import { CollaborationTransport } from './transport'
import { account, active, CollaborationError, failure, integer, type SessionToken } from './validation'
import { accessRemaining, liveRefresh, renewToken, restoredToken, RENEW_BEFORE_MS } from './session-renewal'
import { assertWritableProjectAccess, authorizeProjectAccess, authorizeWritableProjectAccess, type ReadonlyProjectAccess, type WritableProjectAccess } from './project-access'
import { acceptInvitation, actionProjects, createPrivateProject, freshActionAccount, inviteCollaborator, listInvitations,
  type ProjectActionContext, type CreatedPrivateProject, type RepositoryInvitation, type CollaboratorInvitationResult } from './project-actions'
import { collaboratorLogin, InvitationRegistry, projectLink, repositoryName } from './action-validation'
import { ProjectSelectionRegistry, secureRandomUuid, type ProjectSelection } from './project-selection'
import { readRepositoryOperationFailure, snapshotRepositoryOperationOptions, withRepositoryOperation,
  type RepositoryOperationOptions } from '../github/repository-operation'
export type { ReadonlyProjectAccess, WritableProjectAccess } from './project-access'
export type { CreatedPrivateProject, RepositoryInvitation, CollaboratorInvitationResult } from './project-actions'
export type { ProjectSelection } from './project-selection'

export interface GitHubAccountOptions {
  clientId: string | null
  onState?: (state: CollaborationState) => void
  openAuthorization?: (prompt: DevicePrompt, signal: AbortSignal) => Promise<void>
  fetcher?: typeof fetch
  now?: () => number
  sleep?: Sleep
  sessionStore?: AccountSessionStore
}
interface Work<T> { generation: number; controller: AbortController; promise: Promise<T> }
/** `identity` is a secret-free object used only as a reference key for selection binding. */
interface Session extends SessionToken { account: CloudAccount; identity: object; saved?: StoredSession; validated?: boolean }

function initialState(configured: boolean, message?: string): CollaborationState {
  return { phase: configured ? 'signed-out' : 'unconfigured', account: null, authorization: null,
    expiresAt: null, sessionOnly: true, message: message ?? (configured ? '尚未登录云端账号。' :
      '发布者尚未配置云端登录；本地项目、编辑和历史仍可使用。') }
}

/** Device-flow credentials remain Main-only; optional OS encryption retains bounded, rotating login. Writes stay explicit. */
export class GitHubAccountService {
  private readonly clientId: string | null
  private readonly transport: CollaborationTransport
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly pause: Sleep
  private readonly onState?: (state: CollaborationState) => void
  private readonly openAuthorization?: GitHubAccountOptions['openAuthorization']
  private state: CollaborationState
  private generation = 0
  private quiescing = 0
  private session: Session | null = null
  private loginWork: Work<void> | null = null
  private projectWork: Work<CloudProject[]> | null = null
  private selectionWork: Work<ReadonlyArray<ProjectSelection>> | null = null
  private readonly selections = new ProjectSelectionRegistry()
  private readonly invitationSelections = new InvitationRegistry()
  private readonly accessWorks = new Set<Work<unknown>>()
  private projectSnapshot: Map<number, Readonly<CloudProject>> | null = null
  private accessFailure: unknown = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly sessionStore?: AccountSessionStore
  private restoreWork: Work<void> | null = null
  private restoreChecked = false
  private renewalWork: Work<void> | null = null
  private backgroundPaused = false
  private rotating = false
  private readonly storeTasks = new Set<Promise<void>>()

  constructor(options: GitHubAccountOptions) {
    this.clientId = typeof options.clientId === 'string' && /^[A-Za-z0-9._-]{10,128}$/.test(options.clientId) ? options.clientId : null
    this.fetcher = options.fetcher ?? fetch
    this.transport = new CollaborationTransport(this.fetcher)
    this.now = options.now ?? Date.now
    this.pause = options.sleep ?? sleep
    this.onState = options.onState
    this.openAuthorization = options.openAuthorization
    this.sessionStore = options.sessionStore
    this.state = initialState(this.clientId !== null)
  }

  status(): CollaborationState {
    this.expireIfNeeded()
    return structuredClone(this.state)
  }

  /** A trusted read/startup may restore; it never opens a browser, discovers projects or writes remotely. */
  restoreSession(): Promise<CollaborationState> {
    this.expireIfNeeded()
    if (this.session && !this.quiescing && this.accessFailure === null) {
      this.backgroundPaused = false
      return this.ensureFreshSession().then(() => this.status(), () => this.status())
    }
    if (!this.clientId || !this.sessionStore || this.session || this.loginWork || this.quiescing || this.accessFailure !== null)
      return Promise.resolve(this.status())
    if (this.restoreWork) return this.restoreWork.promise.then(() => this.status())
    if (this.restoreChecked) return Promise.resolve(this.status())
    this.restoreChecked = true
    const work: Work<void> = { generation: ++this.generation, controller: new AbortController(), promise: Promise.resolve() }
    this.restoreWork = work
    work.promise = this.runRestore(work).finally(() => { if (this.restoreWork === work) this.restoreWork = null })
    return work.promise.then(() => this.status())
  }

  private async runRestore(work: Work<void>): Promise<void> {
    let saved: StoredSession | null = null
    try {
      saved = await this.sessionStore!.load(this.clientId!, this.now(), work.controller.signal)
      this.check(work)
      if (!saved) {
        if (this.state.renewable) this.publish(initialState(true, '保存的登录已失效，请重新登录。'))
        return
      }
      saved = validStoredSession(saved, this.now())
      if (saved.clientId !== this.clientId || (saved.refreshExpiresAt ?? saved.expiresAt) <= this.now()) {
        await this.clearSaved(saved); this.check(work); return
      }
      let token = restoredToken(saved, this.now())
      if (liveRefresh(token, this.now()) && accessRemaining(token, this.now()) <= RENEW_BEFORE_MS) {
        this.rotating = true
        try {
          token = await renewToken(this.transport, this.clientId!, token, this.now, work.controller.signal)
          this.check(work)
          const previous = saved
          saved = await this.persistLogin(work, token) ?? null
          // The old pair is already invalid after rotation; unavailable storage must not discard the new in-memory pair.
          if (!saved) await this.clearSaved(previous).catch(() => undefined)
          this.check(work)
        } finally { this.rotating = false }
      }
      const profile = account(await this.transport.profile(token.token, work.controller.signal))
      this.check(work)
      if (accessRemaining(token, this.now()) <= 0) throw new CollaborationError('expired')
      this.session = { ...token, account: profile, identity: Object.freeze({}), ...(saved ? { saved } : {}) }
      this.armExpiry(); this.publishSignedIn(profile, !saved, token.refreshToken ? '已恢复登录，将自动保持登录。' : '已恢复登录。')
    } catch (error) {
      if (!this.current(work)) return
      if (readRepositoryOperationFailure(error)?.cleanupFailed && this.accessFailure === null) this.accessFailure = error
      const invalid = error instanceof CollaborationError && ['unauthorized', 'expired'].includes(error.kind)
      if (invalid && saved) await this.clearSaved(saved).catch(() => undefined)
      if (!this.current(work)) return
      this.restoreChecked = invalid || !saved
      const pending = Boolean(!invalid && saved?.refreshToken)
      this.publish({ ...initialState(true, invalid ? '保存的登录已失效，请重新登录。' : '暂时无法恢复登录，联网后将自动重试；本地编辑不受影响。'), ...(pending ? { renewable: true } : {}) })
      if (pending) this.retryRestore()
    }
  }

  private clearSaved(expected?: StoredSession): Promise<void> {
    const task = this.sessionStore?.clear(expected) ?? Promise.resolve()
    this.storeTasks.add(task)
    void task.finally(() => this.storeTasks.delete(task)).catch(() => undefined)
    return task
  }

  private publishSignedIn(profile: CloudAccount, sessionOnly: boolean, message: string): void {
    this.publish({ phase: 'signed-in', account: { ...profile }, authorization: null, sessionOnly,
      expiresAt: this.session!.refreshExpiresAt ?? this.session!.expiresAt,
      ...(liveRefresh(this.session!, this.now()) ? { renewable: true } : {}), message })
  }

  /** Main-only synchronous commit guard; captures only a secret-free session identity and generation. */
  captureSessionGuard(): () => void {
    this.expireIfNeeded()
    if (this.accessFailure !== null) throw this.accessFailure
    if (!this.session) throw new CollaborationError('signed-out')
    const identity = this.session.identity, generation = this.generation
    const guard = (): void => {
      this.expireIfNeeded()
      if (this.accessFailure !== null) throw this.accessFailure
      if (this.quiescing || this.generation !== generation || this.session?.identity !== identity ||
        this.session.validated === false || accessRemaining(this.session, this.now()) <= 0) {
        throw new CollaborationError('cancelled')
      }
    }
    guard()
    return guard
  }

  startLogin(): CollaborationState {
    this.expireIfNeeded()
    if (!this.clientId || this.session || this.loginWork || this.restoreWork || this.quiescing || this.accessWorks.size || this.accessFailure !== null) return this.status()
    this.projectSnapshot = null
    this.selections.clear()
    this.invitationSelections.clear()
    const work: Work<void> = { generation: ++this.generation, controller: new AbortController(), promise: Promise.resolve() }
    this.loginWork = work
    this.publish({ ...initialState(true), phase: 'authorizing', message: '正在准备安全登录，请稍候。' })
    if (this.current(work)) work.promise = this.runLogin(work).finally(() => { if (this.loginWork === work) this.loginWork = null })
    return this.status()
  }

  cancelLogin(): Promise<CollaborationState> {
    return this.state.phase === 'authorizing' ? this.stop(false, '已取消登录；本地项目仍可使用。') : Promise.resolve(this.status())
  }
  cancelAndWait(): Promise<CollaborationState> {
    return this.stop(false, '已取消尚未完成的云端操作。')
  }
  async logout(): Promise<CollaborationState> {
    this.quiescing++; this.restoreChecked = true
    try {
      let cleanupFailure: unknown = null
      try { await this.stop(true, '已退出此设备；未撤销云端授权，可在 GitHub 的 Settings → Applications 中撤销。') } catch (error) { cleanupFailure = error }
      try { await this.clearSaved() } catch {
        if (cleanupFailure !== null) throw cleanupFailure
        this.publish({ ...initialState(this.clientId !== null), phase: 'error', message: '无法移除保存的登录，请重试退出。' })
        throw new CollaborationError('response')
      }
      if (cleanupFailure !== null) throw cleanupFailure
      return this.status()
    } finally { this.quiescing-- }
  }

  projects(): Promise<CloudProject[]> { return this.withFreshSession(() => this.projectsReady()) }
  private projectsReady(): Promise<CloudProject[]> {
    this.expireIfNeeded()
    if (!this.session) return Promise.reject(new CollaborationError('signed-out'))
    if (this.quiescing) return Promise.reject(new CollaborationError('cancelled'))
    let work = this.projectWork
    if (!work) {
      const created: Work<CloudProject[]> = { generation: this.generation, controller: new AbortController(), promise: Promise.resolve([]) }
      this.projectWork = created
      created.promise = this.readProjects(created, this.session.token).finally(() => { if (this.projectWork === created) this.projectWork = null })
      work = created
    }
    return work.promise.then((items) => items.map((item) => ({ ...item })))
  }

  /**
   * Fresh discovery issuing opaque single-use handles bound to this session and generation.
   * Only a successful new selection refresh replaces earlier handles; projects() never does.
   */
  projectSelections(options?: RepositoryOperationOptions): Promise<ReadonlyArray<ProjectSelection>> {
    if (options !== undefined) return this.startAction(async (context, scope) => {
      const projects = await actionProjects(context, scope)
      context.check()
      return this.selections.issue(projects, { owner: this.session!.identity, generation: this.generation }, performance.now())
    }, options)
    return this.withFreshSession(() => this.selectionsReady())
  }
  private selectionsReady(): Promise<ReadonlyArray<ProjectSelection>> {
    this.expireIfNeeded()
    if (!this.session) return Promise.reject(new CollaborationError('signed-out'))
    if (this.quiescing) return Promise.reject(new CollaborationError('cancelled'))
    try { secureRandomUuid() } catch (error) { return Promise.reject(error) }
    let work = this.selectionWork
    if (!work) {
      const created: Work<ReadonlyArray<ProjectSelection>> = { generation: this.generation,
        controller: new AbortController(), promise: Promise.resolve([]) }
      this.selectionWork = created
      created.promise = this.readSelections(created, this.session)
        .finally(() => { if (this.selectionWork === created) this.selectionWork = null })
      work = created
    }
    return work.promise
  }

  /** Consumes the handle on every attempt; the frozen selected snapshot must match fresh discovery. */
  withSelectedProjectAccess<T>(handle: string, action: (access: ReadonlyProjectAccess) => Promise<T>,
    options: RepositoryOperationOptions = {}): Promise<T> {
    let captured: Readonly<RepositoryOperationOptions>
    let selected: Readonly<CloudProject>
    try {
      this.expireIfNeeded()
      // Consume before validating anything else: a rejected attempt must not leave the handle reusable.
      selected = this.selections.consume(handle, { owner: this.session?.identity ?? null, generation: this.generation }, performance.now())
      captured = snapshotRepositoryOperationOptions(options)
      if (typeof action !== 'function') throw new CollaborationError('response')
    } catch (error) { return Promise.reject(error) }
    return this.startAccess(selected.id, selected, action, captured)
  }

  /** Main-only capability; no token/Vault/clone/IPC/UI contract is exposed. */
  withProjectAccess<T>(projectId: number, action: (access: ReadonlyProjectAccess) => Promise<T>,
    options: RepositoryOperationOptions = {}): Promise<T> {
    let captured: Readonly<RepositoryOperationOptions>
    try {
      captured = snapshotRepositoryOperationOptions(options)
      integer(projectId)
      if (typeof action !== 'function') throw new CollaborationError('response')
    } catch (error) { return Promise.reject(error) }
    this.expireIfNeeded()
    return this.startAccess(projectId, this.projectSnapshot?.get(projectId) ?? null, action, captured)
  }

  withWritableProjectAccess<T>(projectId: number, action: (access: WritableProjectAccess) => Promise<T>,
    options: RepositoryOperationOptions = {}): Promise<T> {
    try {
      integer(projectId)
      if (typeof action !== 'function') throw new CollaborationError('response')
      const captured = snapshotRepositoryOperationOptions(options)
      this.expireIfNeeded()
      return this.startAccess(projectId, this.projectSnapshot?.get(projectId) ?? null, async access => {
        assertWritableProjectAccess(access); return action(access)
      }, captured, true)
    } catch (error) { return Promise.reject(error) }
  }
  createPrivateProject(name: string, options: RepositoryOperationOptions = {}): Promise<CreatedPrivateProject> {
    try { const valid = repositoryName(name); return this.startAction((context, scope) => createPrivateProject(context, scope, valid), options) }
    catch (error) { return Promise.reject(error) }
  }
  invitations(options: RepositoryOperationOptions = {}): Promise<ReadonlyArray<RepositoryInvitation>> {
    return this.startAction(async (context, scope) => {
      const values = await listInvitations(context, scope)
      context.check()
      return this.invitationSelections.issue(values, { owner: this.session!.identity, generation: this.generation })
    }, options)
  }
  acceptInvitation(handle: string, options: RepositoryOperationOptions = {}): Promise<CreatedPrivateProject> {
    try {
      this.expireIfNeeded()
      const selected = this.invitationSelections.consume(handle, { owner: this.session?.identity ?? null, generation: this.generation })
      return this.startAction((context, scope) => acceptInvitation(context, scope, selected), options)
    } catch (error) { return Promise.reject(error) }
  }
  inviteCollaborator(projectId: number, username: string, options: RepositoryOperationOptions = {},
    expectedProject?: { owner: string; name: string }): Promise<CollaboratorInvitationResult> {
    try {
      integer(projectId)
      const valid = collaboratorLogin(username)
      const expected = expectedProject ? { owner: expectedProject.owner, name: expectedProject.name } : null
      return this.startAction((context, scope) => authorizeWritableProjectAccess(projectId, {
        ...context, fetcher: this.fetcher, previous: this.projectSnapshot?.get(projectId) ?? null, stopSignal: scope.signal,
      }, access => {
        if (expected && (access.project.owner !== expected.owner || access.project.name !== expected.name)) {
          throw new CollaborationError('selection')
        }
        return inviteCollaborator(context, scope, access.project.owner, access.project.name, valid, access.project.id)
      }, { signal: scope.signal }, true), options)
    } catch (error) { return Promise.reject(error) }
  }
  projectForLink(link: string, options: RepositoryOperationOptions = {}): Promise<ProjectSelection> {
    try {
      const target = projectLink(link)
      return this.startAction(async (context, scope) => {
        const projects = await actionProjects(context, scope)
        const selected = projects.find(value => value.private === true && value.owner.toLowerCase() === target.owner.toLowerCase() && value.name.toLowerCase() === target.name.toLowerCase())
        if (!selected) throw new CollaborationError('selection')
        context.check()
        const result = this.selections.issue([selected], { owner: this.session!.identity, generation: this.generation }, performance.now())[0]
        if (!result) throw new CollaborationError('selection')
        return result
      }, options)
    } catch (error) { return Promise.reject(error) }
  }
  private startAction<T>(action: (context: ProjectActionContext, scope: import('../github/repository-operation').RepositoryOperationScope) => Promise<T>,
    options: RepositoryOperationOptions): Promise<T> {
    try {
      const captured = snapshotRepositoryOperationOptions(options)
      return this.withFreshSession(() => this.startActionReady(action, captured))
    } catch (error) { return Promise.reject(error) }
  }
  private startActionReady<T>(action: (context: ProjectActionContext, scope: import('../github/repository-operation').RepositoryOperationScope) => Promise<T>,
    options: RepositoryOperationOptions): Promise<T> {
    let captured: Readonly<RepositoryOperationOptions>
    try { captured = snapshotRepositoryOperationOptions(options); this.expireIfNeeded() } catch (error) { return Promise.reject(error) }
    if (this.accessFailure !== null) return Promise.reject(this.accessFailure)
    if (!this.session) return Promise.reject(new CollaborationError('signed-out'))
    if (this.quiescing || this.accessWorks.size) return Promise.reject(new CollaborationError('cancelled'))
    const session = this.session
    const work: Work<unknown> = { generation: this.generation, controller: new AbortController(), promise: Promise.resolve() }
    const stop = () => work.controller.abort()
    captured.signal?.addEventListener('abort', stop, { once: true })
    if (captured.signal?.aborted) stop()
    const context: ProjectActionContext = Object.freeze({ transport: this.transport, token: session.token,
      account: Object.freeze({ ...session.account }), check: () => this.checkAccess(work, session),
      unauthorized: () => { if (this.session === session) this.endSession(new CollaborationError('unauthorized').message) } })
    const promise = Promise.resolve().then(() => withRepositoryOperation({ signal: work.controller.signal, timeoutMs: captured.timeoutMs }, async scope => {
      await freshActionAccount(context, scope)
      return action(context, scope)
    })).catch((error: unknown) => this.captureAccessFailure(error)).finally(() => {
      captured.signal?.removeEventListener('abort', stop)
      this.accessWorks.delete(work)
    })
    work.promise = promise
    this.accessWorks.add(work)
    return promise
  }
  private startAccess<T>(projectId: number, previous: Readonly<CloudProject> | null,
    action: (access: ReadonlyProjectAccess) => Promise<T>, captured: Readonly<RepositoryOperationOptions>, writable = false): Promise<T> {
    return this.withFreshSession(() => this.startAccessReady(projectId, previous, action, captured, writable))
  }
  private startAccessReady<T>(projectId: number, previous: Readonly<CloudProject> | null,
    action: (access: ReadonlyProjectAccess) => Promise<T>, captured: Readonly<RepositoryOperationOptions>, writable = false): Promise<T> {
    if (this.accessFailure !== null) return Promise.reject(this.accessFailure)
    if (!this.session) return Promise.reject(new CollaborationError('signed-out'))
    if (this.quiescing || this.accessWorks.size) return Promise.reject(new CollaborationError('cancelled'))
    const session = this.session
    const work: Work<unknown> = { generation: this.generation, controller: new AbortController(), promise: Promise.resolve() }
    const context = Object.freeze({ transport: this.transport, fetcher: this.fetcher, token: session.token,
      account: Object.freeze({ ...session.account }), previous,
      stopSignal: work.controller.signal, check: () => this.checkAccess(work, session),
      unauthorized: () => { if (this.session === session) this.endSession(new CollaborationError('unauthorized').message) } })
    const promise = Promise.resolve().then(() => writable ? authorizeWritableProjectAccess(projectId, context, action, captured) : authorizeProjectAccess(projectId, context, action, captured))
      .catch((error: unknown) => this.captureAccessFailure(error)).finally(() => { this.accessWorks.delete(work) })
    work.promise = promise
    this.accessWorks.add(work)
    return promise
  }

  private checkAccess(work: Work<unknown>, session: Session): void {
    this.check(work)
    if (this.session !== session) throw new CollaborationError('cancelled')
    if (session.validated === false || accessRemaining(session, this.now()) <= 0) throw new CollaborationError('expired')
  }
  private captureAccessFailure(error: unknown): never {
    if (readRepositoryOperationFailure(error)?.cleanupFailed && this.accessFailure === null) this.accessFailure = error
    throw error
  }

  private publish(state: CollaborationState): void {
    this.state = structuredClone(state)
    try { this.onState?.(structuredClone(this.state)) } catch { /* A renderer observer cannot affect authorization. */ }
  }
  private current(work: Work<unknown>): boolean {
    return this.generation === work.generation && !work.controller.signal.aborted
  }
  private check(work: Work<unknown>): void {
    active(work.controller.signal)
    if (!this.current(work)) throw new CollaborationError('cancelled')
    this.expireIfNeeded()
    if (!this.current(work)) throw new CollaborationError('cancelled')
  }

  private async runLogin(work: Work<void>): Promise<void> {
    let saved: StoredSession | undefined
    try {
      this.check(work)
      if (this.sessionStore) { await this.clearSaved(); this.check(work) }
      const token = await authorizeDevice(this.transport, this.clientId!, { now: this.now, sleep: this.pause,
        signal: work.controller.signal, onPrompt: (prompt) => this.promptLogin(work, prompt) })
      this.check(work)
      const profile = account(await this.transport.profile(token.token, work.controller.signal))
      this.check(work)
      if (this.now() >= token.expiresAt || performance.now() >= token.monotonicExpiresAt) throw new CollaborationError('expired')
      saved = await this.persistLogin(work, token)
      this.check(work)
      if (this.now() >= token.expiresAt || performance.now() >= token.monotonicExpiresAt) throw new CollaborationError('expired')
      this.session = { ...token, account: profile, identity: Object.freeze({}), ...(saved ? { saved } : {}) }
      this.armExpiry()
      this.publishSignedIn(profile, !saved, saved ? token.refreshToken ? '已登录，将自动保持登录。' : '已登录，到期前可安全恢复。' :
        this.sessionStore ? '已登录；系统安全存储不可用，仅本次有效。' : token.conservative ?
          '已登录；仅本次运行有效。服务器未提供到期时间，保守一小时后清除，不自动续期。' : '已登录；仅本次运行有效，不自动续期。')
    } catch (error) {
      if (saved) await this.clearSaved(saved).catch(() => undefined)
      if (this.current(work)) this.publish({ ...initialState(true), phase: 'error', message: failure(error).message })
    }
  }

  private async persistLogin(work: Work<void>, token: SessionToken): Promise<StoredSession | undefined> {
    if (!this.sessionStore) return undefined
    const issuedAt = Math.floor(this.now())
    const expiresAt = Math.floor(Math.min(token.expiresAt, issuedAt + token.monotonicExpiresAt - performance.now()))
    const record: StoredSession = { id: randomUUID(), clientId: this.clientId!, token: token.token, issuedAt, expiresAt, conservative: token.conservative,
      ...(liveRefresh(token, issuedAt) ? { refreshToken: token.refreshToken!,
        refreshExpiresAt: Math.floor(Math.min(token.refreshExpiresAt!, issuedAt + token.refreshMonotonicExpiresAt! - performance.now())) } : {}) }
    let persisted = false
    try { persisted = await this.sessionStore.save(record, work.controller.signal) }
    catch { this.check(work); return undefined }
    if (!this.current(work)) { if (persisted) await this.clearSaved(record); this.check(work) }
    return persisted ? record : undefined
  }

  /** No credential rotates while an existing repository lease/discovery owns the previous access token. */
  private async ensureFreshSession(): Promise<void> {
    this.expireIfNeeded()
    if (this.accessFailure !== null) throw this.accessFailure
    if (this.quiescing) throw new CollaborationError('cancelled')
    const session = this.session
    if (!session) throw new CollaborationError('signed-out')
    this.backgroundPaused = false
    if (this.renewalWork) return this.renewalWork.promise
    const due = session.validated === false || (liveRefresh(session, this.now()) && accessRemaining(session, this.now()) <= RENEW_BEFORE_MS)
    if (!due) return
    if (this.accessWorks.size || this.projectWork || this.selectionWork) {
      if (session.validated === false || accessRemaining(session, this.now()) <= 0) throw new CollaborationError('network')
      return
    }
    const work: Work<void> = { generation: this.generation, controller: new AbortController(), promise: Promise.resolve() }
    this.renewalWork = work
    work.promise = Promise.resolve().then(() => this.runRenewal(work, session)).finally(() => {
      if (this.renewalWork === work) this.renewalWork = null
      if (this.session) this.armExpiry(30_000)
    })
    return work.promise
  }

  private async runRenewal(work: Work<void>, previous: Session): Promise<void> {
    let current = previous
    try {
      this.check(work)
      let token: SessionToken = previous
      if (accessRemaining(previous, this.now()) <= RENEW_BEFORE_MS) {
        this.rotating = true
        try {
          token = await renewToken(this.transport, this.clientId!, previous, this.now, work.controller.signal)
          this.check(work)
          const saved = await this.persistLogin(work, token)
          this.check(work)
          current = { ...token, account: previous.account, identity: previous.identity, validated: false, ...(saved ? { saved } : {}) }
          this.session = current
          if (!saved && previous.saved) await this.clearSaved(previous.saved).catch(() => undefined)
          this.check(work)
        } finally { this.rotating = false }
      }
      const profile = account(await this.transport.profile(token.token, work.controller.signal))
      this.check(work)
      if (profile.id !== previous.account.id) throw new CollaborationError('unauthorized')
      if (accessRemaining(token, this.now()) <= 0) throw new CollaborationError('expired')
      current.account = profile; current.validated = true
      this.publishSignedIn(profile, !current.saved, '已登录，将自动保持登录。')
    } catch (error) {
      if (!this.current(work)) throw new CollaborationError('cancelled')
      if (readRepositoryOperationFailure(error)?.cleanupFailed && this.accessFailure === null) this.accessFailure = error
      const safe = failure(error)
      if (safe.kind === 'unauthorized' || safe.kind === 'expired') this.endSession(safe.message)
      else this.publish(current.validated === false ? { ...initialState(true, '暂时无法验证登录，联网后将自动重试；本地编辑不受影响。'), renewable: true } : { ...this.state, message: '暂时无法更新登录；本地编辑不受影响，联网后将重试。' })
      throw safe
    }
  }

  private withFreshSession<T>(action: () => Promise<T>): Promise<T> {
    const session = this.session
    // Preserve synchronous registration/cancellation ownership when no renewal is needed.
    if (!this.renewalWork && (!session || session.validated !== false && (!session.refreshToken || accessRemaining(session, this.now()) > RENEW_BEFORE_MS))) return action()
    const generation = this.generation, identity = session?.identity
    return this.ensureFreshSession().then(() => {
      if (generation !== this.generation || !identity || this.session?.identity !== identity || this.quiescing) throw new CollaborationError('cancelled')
      return action()
    })
  }

  resumeActions(): void {
    this.backgroundPaused = false
    if (!this.session && !this.loginWork) { this.restoreChecked = false; void this.restoreSession() }
    else this.armExpiry()
  }

  private async promptLogin(work: Work<void>, prompt: DevicePrompt): Promise<void> {
    this.check(work)
    this.publish({ ...initialState(true), phase: 'authorizing', authorization: { ...prompt }, message: '请在 GitHub 完成授权。' })
    if (!this.openAuthorization) return
    try { await this.openAuthorization({ ...prompt }, work.controller.signal) }
    catch {
      this.check(work)
      this.publish({ ...this.state, message: '无法打开浏览器，请重试打开授权页。' })
    }
    this.check(work)
  }

  private async readProjects(work: Work<CloudProject[]>, token: string): Promise<CloudProject[]> {
    try {
      const result = await discoverProjects(this.transport, token, work.controller.signal, () => this.check(work))
      this.check(work)
      const snapshot = new Map<number, Readonly<CloudProject>>()
      for (const value of result) snapshot.set(value.id, Object.freeze({ ...value }))
      this.projectSnapshot = snapshot
      return result
    } catch (error) { throw this.discoveryFailure(work, error) }
  }

  private async readSelections(work: Work<ReadonlyArray<ProjectSelection>>, session: Session): Promise<ReadonlyArray<ProjectSelection>> {
    try {
      const check = () => { this.check(work); if (this.session !== session) throw new CollaborationError('cancelled') }
      const result = await discoverProjects(this.transport, session.token, work.controller.signal, check)
      check()
      // Atomic issue after successful discovery only; a stale or failed refresh never touches the registry.
      try {
        return this.selections.issue(result, { owner: session.identity, generation: work.generation }, performance.now())
      } catch (error) { throw error instanceof CollaborationError ? error : new CollaborationError('selection') }
    } catch (error) { throw this.discoveryFailure(work, error) }
  }

  private discoveryFailure(work: Work<unknown>, error: unknown): CollaborationError {
    if (!this.current(work)) return new CollaborationError('cancelled')
    const safe = failure(error)
    if (safe.kind === 'unauthorized') this.endSession(safe.message)
    else this.publish({ ...this.state, message: safe.message })
    return safe
  }

  private abortWork(): Promise<unknown>[] {
    const pending = [this.loginWork, this.restoreWork, this.renewalWork, this.projectWork, this.selectionWork, ...this.accessWorks].filter((item) => item !== null)
    this.loginWork = null; this.restoreWork = null; this.renewalWork = null; this.projectWork = null; this.selectionWork = null
    for (const work of pending) work.controller.abort()
    return pending.map((work) => work.promise)
  }

  private async stop(clearSession: boolean, message: string): Promise<CollaborationState> {
    this.quiescing++
    try {
      this.backgroundPaused = true
      this.clearTimer()
      // A normal shutdown must retain a rotation already dispatched; Logout deliberately cancels and clears it.
      if (!clearSession && this.rotating) await Promise.allSettled([this.renewalWork?.promise, this.restoreWork?.promise])
      ++this.generation; this.restoreChecked = true
      this.projectSnapshot = null
      this.selections.clear()
      this.invitationSelections.clear()
      const pending = this.abortWork()
      this.clearTimer()
      if (clearSession) this.session = null
      this.expireIfNeeded()
      if (this.session) this.armExpiry()
      else this.publish(initialState(this.clientId !== null, this.clientId ? message : undefined))
      await Promise.allSettled(pending)
      await Promise.allSettled([...this.storeTasks])
      if (this.accessFailure !== null) throw this.accessFailure
      return this.status()
    } finally { this.quiescing-- }
  }

  private clearTimer(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
  }
  private retryRestore(): void {
    this.clearTimer()
    if (this.backgroundPaused || this.quiescing || this.accessFailure !== null) return
    const generation = this.generation
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      if (generation === this.generation && !this.session && !this.backgroundPaused && !this.quiescing) void this.restoreSession()
    }, 30_000)
    this.expiryTimer.unref?.()
  }
  private armExpiry(retryMs = 1000): void {
    this.clearTimer()
    if (!this.session) return
    const renewable = liveRefresh(this.session, this.now())
    if (renewable && (this.backgroundPaused || this.quiescing || this.renewalWork)) return
    const generation = this.generation
    const renewalDelay = this.session.validated === false ? retryMs : Math.max(retryMs, accessRemaining(this.session, this.now()) - RENEW_BEFORE_MS)
    const delay = renewable ? renewalDelay : Math.max(0, accessRemaining(this.session, this.now()))
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      if (generation !== this.generation || !this.session) return
      if (!renewable) { this.expireIfNeeded(); return }
      if (this.accessWorks.size || this.projectWork || this.selectionWork) { this.armExpiry(1000); return }
      void this.ensureFreshSession().catch(() => undefined)
    }, delay)
    this.expiryTimer.unref?.()
  }
  private expireIfNeeded(): void {
    const session = this.session
    if (!session) return
    if (accessRemaining(session, this.now()) <= 0 && !liveRefresh(session, this.now())) {
      this.endSession('此设备的登录已到期，请重新登录。')
    } else if (accessRemaining(session, this.now()) <= 0 && !this.expiryTimer && !this.renewalWork) this.armExpiry()
  }
  private endSession(message: string): void {
    if (this.session?.saved) void this.clearSaved(this.session.saved).catch(() => undefined)
    this.restoreChecked = true
    ++this.generation
    this.projectSnapshot = null
    this.selections.clear()
    this.invitationSelections.clear()
    this.session = null
    this.clearTimer()
    void Promise.allSettled(this.abortWork())
    this.publish(initialState(this.clientId !== null, message))
  }
}
