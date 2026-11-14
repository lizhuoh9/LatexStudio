import type { CloudAccount, CloudProject } from '../../shared/collaboration-contracts'
import { githubHttp, type GitHubHttpClient } from '../github/transport'
import { checkedGitRequest, githubTarget, safeBranch, type GitHubTarget } from '../github/remote-policy'
import { snapshotRepositoryOperationOptions, withRepositoryOperation,
  type RepositoryOperationOptions, type RepositoryOperationScope } from '../github/repository-operation'
import { discoverProjects } from './projects'
import type { CollaborationTransport } from './transport'
import { account, CollaborationError, project, record } from './validation'

export interface ReadonlyProjectAccess {
  readonly project: Readonly<CloudProject>
  readonly account: Readonly<CloudAccount>
  readonly target: Readonly<GitHubTarget>
  readonly branch: string
  readonly signal: AbortSignal
  readonly http: Readonly<GitHubHttpClient>
  check(): void
}
export interface WritableProjectAccess extends ReadonlyProjectAccess { readonly mode: 'write' }
const writableBrands = new WeakMap<object, boolean>()
const readWritableBrand = writableBrands.get.bind(writableBrands)
const grantWritableBrand = writableBrands.set.bind(writableBrands)
const revokeWritableBrand = writableBrands.delete.bind(writableBrands)
/** A mode field or a copied object grants nothing: only a live Main-issued identity is accepted. */
export function assertWritableProjectAccess(access: ReadonlyProjectAccess, administration = false): asserts access is WritableProjectAccess {
  const administrationGranted = readWritableBrand(access)
  if (administrationGranted === undefined || administration && !administrationGranted) throw new CollaborationError('response')
  access.check()
}
interface ProjectAccessContext {
  readonly transport: CollaborationTransport
  readonly fetcher: typeof fetch
  readonly token: string
  readonly account: Readonly<CloudAccount>
  readonly previous: Readonly<CloudProject> | null
  readonly stopSignal: AbortSignal
  check(): void
  unauthorized(): void
}
interface Metadata { project: CloudProject; account: CloudAccount; target: GitHubTarget; branch: string; writable: boolean; administration: boolean }
type AccessMode = 'read' | 'write' | 'admin'
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener

function linkedSignal(stop: AbortSignal, parent?: AbortSignal): { signal: AbortSignal; close(): void } {
  const controller = new AbortController()
  const signals = new Set(parent ? [stop, parent] : [stop])
  const abort = () => controller.abort()
  for (const signal of signals) {
    addListener.call(signal, 'abort', abort, { once: true })
    if (!signalAborted || signalAborted.call(signal)) abort()
  }
  return { signal: controller.signal, close() {
    for (const signal of signals) removeListener.call(signal, 'abort', abort)
  } }
}

function sameProject(left: Readonly<CloudProject>, right: Readonly<CloudProject>): boolean {
  return left.id === right.id && left.installationId === right.installationId && left.owner === right.owner &&
    left.name === right.name && left.private === right.private
}

async function metadataStep<T>(scope: RepositoryOperationScope, context: ProjectAccessContext, action: () => Promise<T>): Promise<T> {
  try { return await scope.step(action) } catch (error) {
    if (error instanceof CollaborationError && error.kind === 'unauthorized') context.unauthorized()
    throw error
  }
}

async function authorize(scope: RepositoryOperationScope, context: ProjectAccessContext, projectId: number, mode: AccessMode): Promise<Metadata> {
  const check = () => { scope.check(); context.check() }
  check()
  const profile = account(await metadataStep(scope, context, () => context.transport.profile(context.token, scope.signal)))
  check()
  if (profile.id !== context.account.id || profile.login !== context.account.login) throw new CollaborationError('response')
  const projects = await metadataStep(scope, context, () => discoverProjects(context.transport, context.token, scope.signal, check))
  check()
  const selected = projects.find(value => value.id === projectId)
  if (!selected || context.previous && !sameProject(selected, context.previous)) throw new CollaborationError('response')
  const data = record(await metadataStep(scope, context, () => context.transport.repository(selected.owner, selected.name, context.token, scope.signal)))
  check()
  const detail = project(data, selected.installationId)
  if (!sameProject(selected, detail) || typeof data.default_branch !== 'string') throw new CollaborationError('response')
  const branch = safeBranch(data.default_branch)
  const target = githubTarget(`https://github.com/${selected.owner}/${selected.name}.git`)
  if (target.owner !== selected.owner || target.repository !== selected.name) throw new CollaborationError('response')
  check()
  let administration = false
  if (mode !== 'read') {
    const permissions = record(data.permissions)
    administration = permissions.admin === true
    if (detail.private !== true || permissions.push !== true && !administration || mode === 'admin' && !administration)
      throw new CollaborationError('response')
  }
  return { project: selected, account: profile, target, branch, writable: mode !== 'read', administration }
}

async function runAuthorized<T>(scope: RepositoryOperationScope, context: ProjectAccessContext, metadata: Metadata,
  action: (access: ReadonlyProjectAccess) => Promise<T>): Promise<T> {
  let usable = true
  const check = () => {
    if (!usable) throw new CollaborationError('cancelled')
    scope.check(); context.check()
  }
  check()
  const client = scope.own(githubHttp(metadata.target, context.token, { fetcher: context.fetcher, signal: scope.signal, readOnly: !metadata.writable }))
  const http: GitHubHttpClient = {
    request: async request => {
      check()
      const endpoint = checkedGitRequest(metadata.target, request, !metadata.writable)
      const receive = endpoint.method === 'POST' && endpoint.url.pathname.endsWith('/git-receive-pack')
      const response = receive ? await scope.remoteWrite(() => client.request(request)) : await scope.step(() => client.request(request))
      check()
      return response
    },
    close: async () => { check(); await scope.step(() => client.close()); check() },
  }
  const access: ReadonlyProjectAccess = Object.freeze({ project: Object.freeze({ ...metadata.project }),
    account: Object.freeze({ ...metadata.account }), target: Object.freeze({ ...metadata.target }), branch: metadata.branch,
    signal: scope.signal, http: Object.freeze(http), check, ...(metadata.writable ? { mode: 'write' as const } : {}) })
  if (metadata.writable) grantWritableBrand(access, metadata.administration)
  try {
    check()
    const value = await scope.step(() => action(access))
    check()
    return value
  } finally { usable = false; revokeWritableBrand(access) }
}

/** Internal Main-only bridge. The token remains in this private context, never in the access value.
 * A primitive ID is not a future Renderer selection handle: UI activation needs a generation-bound
 * opaque selection contract. No clone, filesystem, Vault, refresh or credential persistence occurs.
 */
export async function authorizeProjectAccess<T>(projectId: number, context: ProjectAccessContext,
  action: (access: ReadonlyProjectAccess) => Promise<T>, options: RepositoryOperationOptions): Promise<T> {
  return authorizeAccess(projectId, context, action, options, 'read')
}
export async function authorizeWritableProjectAccess<T>(projectId: number, context: ProjectAccessContext,
  action: (access: WritableProjectAccess) => Promise<T>, options: RepositoryOperationOptions, administration = false): Promise<T> {
  return authorizeAccess(projectId, context, async access => {
    assertWritableProjectAccess(access, administration)
    return action(access)
  }, options, administration ? 'admin' : 'write')
}
async function authorizeAccess<T>(projectId: number, context: ProjectAccessContext,
  action: (access: ReadonlyProjectAccess) => Promise<T>, options: RepositoryOperationOptions, mode: AccessMode): Promise<T> {
  const captured = snapshotRepositoryOperationOptions(options)
  const linked = linkedSignal(context.stopSignal, captured.signal)
  try {
    return await withRepositoryOperation({ signal: linked.signal, timeoutMs: captured.timeoutMs }, async scope => {
      const metadata = await authorize(scope, context, projectId, mode)
      return runAuthorized(scope, context, metadata, action)
    })
  } finally { linked.close() }
}
