import { githubTarget } from '../github/remote-policy'
import { CollaborationError, integer, login, record } from './validation'
import { secureRandomUuid, SELECTION_TTL_MS, type SelectionBinding } from './project-selection'

export interface CreatedPrivateProject { id: number; owner: string; name: string; private: true; accessible: boolean }
export interface RepositoryInvitation { handle: string; projectId: number; owner: string; name: string; inviter: string }
export interface PendingInvitation { id: number; projectId: number; owner: string; name: string; inviter: string }
export interface CollaboratorInvitationResult { owner: string; name: string; login: string; status: 'invited' | 'already-authorized' }
export const MAX_INVITATIONS = 100

export function repositoryName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value) || ['.', '..'].includes(value)) throw new CollaborationError('response')
  return value
}
export function collaboratorLogin(value: unknown): string {
  const result = login(value)
  if (result.includes('--')) throw new CollaborationError('response')
  return result
}
export function privateRepository(value: unknown): Omit<CreatedPrivateProject, 'accessible'> {
  const data = record(value)
  if (data.private !== true) throw new CollaborationError('response')
  return { id: integer(data.id), owner: collaboratorLogin(record(data.owner).login), name: repositoryName(data.name), private: true }
}
export function invitation(value: unknown, accountId: number): PendingInvitation | null {
  const data = record(value), repository = record(data.repository)
  if (repository.private === false) return null
  const project = privateRepository(repository)
  if (integer(record(data.invitee).id) !== accountId) throw new CollaborationError('response')
  return { id: integer(data.id), projectId: project.id, owner: project.owner, name: project.name,
    inviter: collaboratorLogin(record(data.inviter).login) }
}
export function projectLink(value: unknown): { owner: string; name: string } {
  if (typeof value !== 'string' || value.length > 256) throw new CollaborationError('response')
  // This is a browser sharing URL, not a Git clone URL: preserve real names ending in .git.
  const target = githubTarget(`${value.replace(/\/$/, '')}.git`)
  return { owner: target.owner, name: target.repository }
}
export function sameInvitation(a: PendingInvitation, b: PendingInvitation): boolean {
  return a.id === b.id && a.projectId === b.projectId && a.owner === b.owner && a.name === b.name && a.inviter === b.inviter
}

/** Single-use lookup keys, never authority encoded in a link, ID or Renderer object. */
export class InvitationRegistry {
  private entries = new Map<string, { invitation: PendingInvitation; binding: SelectionBinding; expires: number }>()
  issue(values: ReadonlyArray<PendingInvitation>, binding: SelectionBinding): ReadonlyArray<RepositoryInvitation> {
    if (!binding.owner || values.length > MAX_INVITATIONS) throw new CollaborationError('selection')
    const random = secureRandomUuid(), next = new Map<string, { invitation: PendingInvitation; binding: SelectionBinding; expires: number }>()
    const result = values.map(value => {
      const handle = `psi.${random()}`
      if (next.has(handle)) throw new CollaborationError('selection')
      next.set(handle, { invitation: { ...value }, binding: { ...binding }, expires: performance.now() + SELECTION_TTL_MS })
      return Object.freeze({ handle, projectId: value.projectId, owner: value.owner, name: value.name, inviter: value.inviter })
    })
    this.entries = next
    return Object.freeze(result)
  }
  consume(handle: unknown, binding: SelectionBinding): PendingInvitation {
    const entry = typeof handle === 'string' ? this.entries.get(handle) : undefined
    if (typeof handle === 'string') this.entries.delete(handle)
    if (!entry || !binding.owner || entry.binding.owner !== binding.owner || entry.binding.generation !== binding.generation ||
      performance.now() >= entry.expires) throw new CollaborationError('selection')
    return { ...entry.invitation }
  }
  clear(): void { this.entries.clear() }
}
