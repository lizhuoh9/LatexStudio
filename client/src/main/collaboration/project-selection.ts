import type { CloudProject } from '../../shared/collaboration-contracts'
import { MAX_PROJECTS } from './projects'
import { CollaborationError } from './validation'

/** A selection outlives neither its session/generation nor this monotonic window. */
export const SELECTION_TTL_MS = 10 * 60 * 1000

export interface ProjectSelection {
  readonly handle: string
  readonly project: Readonly<CloudProject>
}
/** `owner` is the in-memory session object identity; it is compared by reference, never serialized. */
export interface SelectionBinding {
  readonly owner: object | null
  readonly generation: number
}
interface Entry {
  readonly owner: object
  readonly generation: number
  readonly project: Readonly<CloudProject>
  readonly expiresAt: number
}
type RandomUuid = () => string

const HANDLE = /^pss\.[1-9][0-9]{0,15}\.[1-9][0-9]{0,15}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
let issuers = 0

/** Fails closed: no Math.random/counter fallback when the platform CSPRNG UUID is unavailable. */
export function secureRandomUuid(): RandomUuid {
  const source = globalThis.crypto
  const generate = source && typeof source.randomUUID === 'function' ? source.randomUUID.bind(source) : null
  if (!generate) throw new Error('Secure random UUID is unavailable; project selection refused')
  return () => {
    const value = generate()
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Secure random UUID is invalid; project selection refused')
    return value
  }
}

function frozenProject(value: Readonly<CloudProject>): Readonly<CloudProject> {
  return Object.freeze({ id: value.id, installationId: value.installationId, owner: value.owner,
    name: value.name, private: value.private })
}

/**
 * Main-memory registry of opaque, single-use project selections. A handle is only a lookup key:
 * its text is never parsed for authority. Issuing a batch atomically replaces the previous one.
 */
export class ProjectSelectionRegistry {
  private readonly issuer = ++issuers
  private refresh = 0
  private entries = new Map<string, Entry>()

  issue(projects: ReadonlyArray<Readonly<CloudProject>>, binding: SelectionBinding, now: number,
    uuid: RandomUuid = secureRandomUuid()): ReadonlyArray<ProjectSelection> {
    if (!binding.owner) throw new CollaborationError('signed-out')
    if (projects.length > MAX_PROJECTS) throw new CollaborationError('limit')
    const refresh = this.refresh + 1
    const next = new Map<string, Entry>()
    const result = projects.map((value) => {
      const project = frozenProject(value)
      const handle = `pss.${this.issuer}.${refresh}.${uuid()}`
      if (!HANDLE.test(handle)) throw new Error('Secure random UUID is invalid; project selection refused')
      if (next.has(handle)) throw new Error('Duplicate project selection handle refused')
      next.set(handle, { owner: binding.owner!, generation: binding.generation, project, expiresAt: now + SELECTION_TTL_MS })
      return Object.freeze({ handle, project })
    })
    this.refresh = refresh
    this.entries = next
    return Object.freeze(result)
  }

  /** Always removes a known handle first, so every attempt (even a rejected one) consumes it. */
  consume(handle: unknown, binding: SelectionBinding, now: number): Readonly<CloudProject> {
    if (typeof handle !== 'string' || !HANDLE.test(handle)) throw new CollaborationError('selection')
    const entry = this.entries.get(handle)
    this.entries.delete(handle)
    for (const [key, value] of this.entries) if (now >= value.expiresAt) this.entries.delete(key)
    if (!binding.owner) throw new CollaborationError('signed-out')
    if (!entry || entry.owner !== binding.owner || entry.generation !== binding.generation || now >= entry.expiresAt) {
      throw new CollaborationError('selection')
    }
    return entry.project
  }

  clear(): void {
    this.entries = new Map()
  }

  get size(): number {
    return this.entries.size
  }
}
