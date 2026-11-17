import type { CloudProject } from '../../shared/collaboration-contracts'
import { CollaborationTransport, PAGE_SIZE } from './transport'
import { active, CollaborationError, project } from './validation'

export const MAX_INSTALLATIONS = 100
export const MAX_PROJECTS = 500
export const MAX_PROJECT_REQUESTS = 40

/** Enumerates the authenticated user's accessible GitHub repositories via /user/repos with bounded paging. */
export async function discoverProjects(transport: CollaborationTransport, token: string, signal: AbortSignal,
  check: () => void): Promise<CloudProject[]> {
  const result = new Map<number, CloudProject>()
  let requests = 0
  for (let page = 1; ; page++) {
    active(signal); check()
    if (++requests > MAX_PROJECT_REQUESTS) throw new CollaborationError('limit')
    const rows = await transport.userRepositories(page, token, signal)
    active(signal); check()
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new CollaborationError('response')
    if (result.size + rows.length > MAX_PROJECTS) throw new CollaborationError('limit')
    for (const row of rows) {
      const candidate = project(row, 0)
      const existing = result.get(candidate.id)
      if (existing && (existing.owner !== candidate.owner || existing.name !== candidate.name || existing.private !== candidate.private)) {
        throw new CollaborationError('response')
      }
      if (!existing) result.set(candidate.id, candidate)
    }
    if (rows.length < PAGE_SIZE) break
  }
  active(signal); check()
  return Array.from(result.values())
}
