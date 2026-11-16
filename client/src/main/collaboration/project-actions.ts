import type { CloudAccount, CloudProject } from '../../shared/collaboration-contracts'
import { readRepositoryOperationFailure, type RepositoryOperationScope } from '../github/repository-operation'
import { readOperationDiagnostic } from '../github/operation-diagnostic'
import { account, CollaborationError, integer, record } from './validation'
import type { CollaborationTransport } from './transport'
import { discoverProjects } from './projects'
import { invitation, MAX_INVITATIONS, privateRepository, sameInvitation, type CreatedPrivateProject,
  type PendingInvitation, type CollaboratorInvitationResult } from './action-validation'
export type { CreatedPrivateProject, RepositoryInvitation, CollaboratorInvitationResult } from './action-validation'

export interface ProjectActionContext {
  readonly transport: CollaborationTransport
  readonly token: string
  readonly account: Readonly<CloudAccount>
  check(): void
  unauthorized(): void
}
export async function actionStep<T>(context: ProjectActionContext, scope: RepositoryOperationScope, action: () => Promise<T>): Promise<T> {
  context.check(); scope.check()
  try { const value = await scope.step(action); context.check(); return value }
  catch (error) {
    if (error instanceof CollaborationError && error.kind === 'unauthorized') context.unauthorized()
    throw error
  }
}
export async function freshActionAccount(context: ProjectActionContext, scope: RepositoryOperationScope): Promise<void> {
  const fresh = account(await actionStep(context, scope, () => context.transport.profile(context.token, scope.signal)))
  if (fresh.id !== context.account.id || fresh.login !== context.account.login) throw new CollaborationError('response')
}
export async function actionProjects(context: ProjectActionContext, scope: RepositoryOperationScope): Promise<CloudProject[]> {
  return actionStep(context, scope, () => discoverProjects(context.transport, context.token, scope.signal, () => {
    scope.check(); context.check()
  }))
}
async function availability(context: ProjectActionContext, scope: RepositoryOperationScope,
  value: Omit<CreatedPrivateProject, 'accessible'>): Promise<CreatedPrivateProject> {
  const projects = await actionProjects(context, scope)
  const selected = projects.find(project => project.id === value.id)
  if (selected && (selected.owner !== value.owner || selected.name !== value.name || selected.private !== true)) throw new CollaborationError('response')
  return { ...value, accessible: selected !== undefined }
}
export async function createPrivateProject(context: ProjectActionContext, scope: RepositoryOperationScope, name: string): Promise<CreatedPrivateProject> {
  const response = await actionStep(context, scope, () => scope.remoteWrite(() => context.transport.createPrivate(name, context.token, scope.signal)))
  const value = privateRepository(response)
  if (value.owner !== context.account.login || value.name !== name) throw new CollaborationError('response')
  // Never patch visibility or attach/upload if GitHub did not attest private:true.
  try { return await availability(context, scope, value) }
  catch (error) {
    // A validated private:true POST already succeeded. An unavailable installation
    // listing must not invite a duplicate POST; no access or upload is granted.
    context.check(); scope.check()
    const code = readOperationDiagnostic(error)
    if (readRepositoryOperationFailure(error)?.cleanupFailed || !['network', 'forbidden'].includes(code ?? '')) throw error
    return { ...value, accessible: false }
  }
}
export async function listInvitations(context: ProjectActionContext, scope: RepositoryOperationScope): Promise<PendingInvitation[]> {
  const result: PendingInvitation[] = [], seen = new Set<number>()
  for (let page = 1; page <= 3; page++) {
    const rows = await actionStep(context, scope, () => context.transport.invitations(page, context.token, scope.signal))
    if (!Array.isArray(rows) || rows.length > 50) throw new CollaborationError('response')
    for (const row of rows) {
      const id = integer(record(row).id)
      if (seen.has(id)) throw new CollaborationError('response')
      seen.add(id)
      if (seen.size > MAX_INVITATIONS) throw new CollaborationError('limit')
      const item = invitation(row, context.account.id)
      if (item) result.push(item)
    }
    if (rows.length < 50) return result
  }
  throw new CollaborationError('limit')
}
export async function acceptInvitation(context: ProjectActionContext, scope: RepositoryOperationScope,
  selected: PendingInvitation): Promise<CreatedPrivateProject> {
  const current = (await listInvitations(context, scope)).find(value => value.id === selected.id)
  if (!current || !sameInvitation(current, selected)) throw new CollaborationError('selection')
  await actionStep(context, scope, () => scope.remoteWrite(() => context.transport.acceptInvitation(selected.id, context.token, scope.signal)))
  const value: Omit<CreatedPrivateProject, 'accessible'> = { id: selected.projectId, owner: selected.owner, name: selected.name, private: true }
  try { return await availability(context, scope, value) }
  catch (error) {
    // The validated invitation PATCH already succeeded. A temporarily unavailable
    // installation listing grants no access and must not encourage another PATCH.
    context.check(); scope.check()
    const code = readOperationDiagnostic(error)
    if (readRepositoryOperationFailure(error)?.cleanupFailed || !['network', 'forbidden'].includes(code ?? '')) throw error
    return { ...value, accessible: false }
  }
}
export async function inviteCollaborator(context: ProjectActionContext, scope: RepositoryOperationScope,
  owner: string, name: string, login: string, projectId: number): Promise<CollaboratorInvitationResult> {
  const value = await actionStep(context, scope, () => scope.remoteWrite(() => context.transport.invite(owner, name, login, context.token, scope.signal)))
  if (value !== null) {
    const data = record(value), project = privateRepository(data.repository)
    integer(data.id)
    const invitee = record(data.invitee).login
    if (project.id !== projectId || project.owner !== owner || project.name !== name || typeof invitee !== 'string' || invitee.toLowerCase() !== login.toLowerCase()) throw new CollaborationError('response')
  }
  return { owner, name, login, status: value === null ? 'already-authorized' : 'invited' }
}
