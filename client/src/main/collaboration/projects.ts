import type { CloudProject } from '../../shared/collaboration-contracts'
import { CollaborationTransport, PAGE_SIZE } from './transport'
import { active, CollaborationError, integer, project, record } from './validation'

export const MAX_INSTALLATIONS = 100
export const MAX_PROJECTS = 500
export const MAX_PROJECT_REQUESTS = 40
interface Budget { requests: number; projects: number }
type PageReader = (page: number) => Promise<unknown>

async function pages(read: PageReader, key: string, maximum: number, budget: Budget,
  signal: AbortSignal, check: () => void): Promise<unknown[]> {
  const result: unknown[] = []
  const seen = new Set<number>()
  let expected: number | null = null
  for (let page = 1; ; page++) {
    active(signal); check()
    if (++budget.requests > MAX_PROJECT_REQUESTS) throw new CollaborationError('limit')
    const data = record(await read(page))
    active(signal); check()
    const count = data.total_count
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new CollaborationError('response')
    if (count > maximum) throw new CollaborationError('limit')
    if (expected !== null && count !== expected) throw new CollaborationError('response')
    expected = count
    const items = data[key]
    if (!Array.isArray(items) || items.length > PAGE_SIZE) throw new CollaborationError('response')
    for (const item of items) {
      const id = integer(record(item).id)
      if (seen.has(id)) throw new CollaborationError('response')
      seen.add(id)
    }
    result.push(...items)
    if (result.length > maximum) throw new CollaborationError('limit')
    if (result.length > expected) throw new CollaborationError('response')
    if (items.length < PAGE_SIZE) {
      if (result.length !== expected) throw new CollaborationError('response')
      return result
    }
  }
}

function appendProjects(rows: unknown[], installationId: number, result: Map<number, CloudProject>, budget: Budget): void {
  budget.projects += rows.length
  if (budget.projects > MAX_PROJECTS) throw new CollaborationError('limit')
  for (const row of rows) {
    const candidate = project(row, installationId)
    const existing = result.get(candidate.id)
    if (existing && (existing.owner !== candidate.owner || existing.name !== candidate.name || existing.private !== candidate.private)) {
      throw new CollaborationError('response')
    }
    if (!existing) result.set(candidate.id, candidate)
  }
}

/** The authenticated user's app-installation intersection, never a whole-account repository scan. */
export async function discoverProjects(transport: CollaborationTransport, token: string, signal: AbortSignal,
  check: () => void): Promise<CloudProject[]> {
  const budget: Budget = { requests: 0, projects: 0 }
  const installations = await pages((page) => transport.installations(page, token, signal),
    'installations', MAX_INSTALLATIONS, budget, signal, check)
  const ids = new Set(installations.map((value) => integer(record(value).id)))
  const result = new Map<number, CloudProject>()
  for (const id of ids) {
    const rows = await pages((page) => transport.repositories(id, page, token, signal),
      'repositories', MAX_PROJECTS, budget, signal, check)
    appendProjects(rows, id, result, budget)
  }
  active(signal); check()
  return Array.from(result.values())
}
