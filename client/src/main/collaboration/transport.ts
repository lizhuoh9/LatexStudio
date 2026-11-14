import { active, CollaborationError, integer, login } from './validation'
import { readOperationDiagnostic } from '../github/operation-diagnostic'
import { githubTarget } from '../github/remote-policy'
import { readRepositoryOperationFailure, withRepositoryOperation } from '../github/repository-operation'
import { readVerificationLifecycleFailure } from '../github/verification-lifecycle'

const apiRoot = 'https://api.github.com'
export const PAGE_SIZE = 50
export const MAX_JSON_BYTES = 1024 * 1024
export const REQUEST_TIMEOUT_MS = 10_000

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => { reject(new CollaborationError('cancelled')) }
    signal.addEventListener('abort', cancel, { once: true })
    promise.then((value) => { signal.removeEventListener('abort', cancel); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', cancel); reject(error) })
    if (signal.aborted) cancel()
  })
}

async function ownedResponse<T>(signal: AbortSignal, action: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
  return withRepositoryOperation({ signal }, async scope => {
    scope.own({ close: async () => { await cleanup() } })
    return scope.step(action)
  })
}
async function jsonBody(response: Response, signal: AbortSignal, owned = false): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const length = response.headers.get('content-length')
  if (!['application/json', 'application/vnd.github+json'].includes(type ?? '') || !response.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES))) {
    if (owned) return ownedResponse(signal, async () => { throw new CollaborationError('response') }, async () => response.body?.cancel())
    await response.body?.cancel().catch(() => undefined)
    throw new CollaborationError('response')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', bytes = 0
  const read = async () => { try {
    for (;;) {
      const result = await abortable(reader.read(), signal)
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > MAX_JSON_BYTES) throw new CollaborationError('response')
      text += decoder.decode(result.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } catch (error) {
    if (readRepositoryOperationFailure(error)?.cleanupFailed || readVerificationLifecycleFailure(error)?.cleanupFailed) throw error
    active(signal); throw new CollaborationError('response')
  } }
  if (owned) return ownedResponse(signal, read, async () => { try { await reader.cancel() } finally { reader.releaseLock() } })
  try { return await read() }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
}

/** Only these exact GitHub endpoints can receive the in-memory authorization. */
export class CollaborationTransport {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  device(clientId: string, signal: AbortSignal): Promise<unknown> {
    return this.post('https://github.com/login/device/code', { client_id: clientId }, signal)
  }
  poll(clientId: string, deviceCode: string, signal: AbortSignal): Promise<unknown> {
    return this.post('https://github.com/login/oauth/access_token', { client_id: clientId, device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal)
  }
  profile(token: string, signal: AbortSignal): Promise<unknown> {
    return this.get('/user', token, signal)
  }
  installations(page: number, token: string, signal: AbortSignal): Promise<unknown> {
    return this.get(`/user/installations?per_page=${PAGE_SIZE}&page=${page}`, token, signal)
  }
  repositories(installationId: number, page: number, token: string, signal: AbortSignal): Promise<unknown> {
    return this.get(`/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`, token, signal)
  }

  repository(owner: string, name: string, token: string, signal: AbortSignal): Promise<unknown> {
    if (typeof owner !== 'string' || typeof name !== 'string') throw new CollaborationError('response')
    const target = githubTarget(`https://github.com/${owner}/${name}.git`)
    if (target.owner !== owner || target.repository !== name) throw new CollaborationError('response')
    return this.get(`/repos/${target.owner}/${target.repository}`, token, signal)
  }

  createPrivate(name: string, token: string, signal: AbortSignal): Promise<unknown> {
    const target = githubTarget(`https://github.com/placeholder/${name}.git`)
    if (target.repository !== name) throw new CollaborationError('response')
    return this.apiWrite('/user/repos', 'POST', token, signal, [201], { name, private: true, auto_init: false })
  }
  invitations(page: number, token: string, signal: AbortSignal): Promise<unknown> {
    return this.get(`/user/repository_invitations?per_page=${PAGE_SIZE}&page=${integer(page, 3)}`, token, signal)
  }
  acceptInvitation(id: number, token: string, signal: AbortSignal): Promise<unknown> {
    return this.apiWrite(`/user/repository_invitations/${integer(id)}`, 'PATCH', token, signal, [204])
  }
  invite(owner: string, name: string, username: string, token: string, signal: AbortSignal): Promise<unknown> {
    const target = githubTarget(`https://github.com/${owner}/${name}.git`)
    if (target.owner !== owner || target.repository !== name || login(username).includes('--')) throw new CollaborationError('response')
    return this.apiWrite(`/repos/${owner}/${name}/collaborators/${username}`, 'PUT', token, signal, [201, 204], { permission: 'push' })
  }
  private apiWrite(path: string, method: string, token: string, signal: AbortSignal,
    statuses: number[], fields?: Record<string, unknown>): Promise<unknown> {
    return this.request(`${apiRoot}${path}`, { method, body: fields ? JSON.stringify(fields) : undefined, headers: {
      Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'User-Agent': 'LatexStudio', 'X-GitHub-Api-Version': '2022-11-28' } }, signal, statuses)
  }

  private post(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    return this.request(url, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: {
      Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'LatexStudio' } }, signal)
  }
  private get(path: string, token: string, signal: AbortSignal): Promise<unknown> {
    return this.request(`${apiRoot}${path}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`, 'User-Agent': 'LatexStudio', 'X-GitHub-Api-Version': '2022-11-28' } }, signal)
  }

  private async request(url: string, init: RequestInit, parent: AbortSignal, statuses?: number[]): Promise<unknown> {
    active(parent)
    const controller = new AbortController()
    let timedOut = false
    const cancel = (): void => controller.abort()
    parent.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, REQUEST_TIMEOUT_MS)
    try {
      const pending = this.fetcher(url, { ...init, signal: controller.signal,
        credentials: 'omit', redirect: 'manual', cache: 'no-store' })
      // Mutation acknowledgements must retain actual Fetch ownership through cancel/logout.
      // A provider ignoring AbortSignal may delay close; never race it and report completion.
      const response = statuses ? await pending : await abortable(pending, controller.signal)
      if (statuses && controller.signal.aborted) {
        await ownedResponse(controller.signal, async () => { active(controller.signal) }, async () => response.body?.cancel())
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        if (statuses) await ownedResponse(controller.signal, async () => { throw new CollaborationError('redirect') }, async () => response.body?.cancel())
        void response.body?.cancel().catch(() => undefined)
        throw new CollaborationError('redirect')
      }
      if (response.status === 401) {
        if (statuses) await ownedResponse(controller.signal, async () => undefined, async () => response.body?.cancel())
        else void response.body?.cancel().catch(() => undefined)
        throw new CollaborationError('unauthorized')
      }
      if (!response.ok || statuses && !statuses.includes(response.status)) {
        // Classify the status, never reflect the untrusted response body/headers.
        const kind = response.status === 403 ? url === `${apiRoot}/user/repos` ? 'create-forbidden' : 'forbidden'
          : response.status === 422 && url === `${apiRoot}/user/repos` ? 'invalid-repository' : 'network'
        if (statuses) await ownedResponse(controller.signal, async () => { throw new CollaborationError(kind) }, async () => response.body?.cancel())
        void response.body?.cancel().catch(() => undefined)
        throw new CollaborationError(kind)
      }
      if (response.status === 204 && statuses?.includes(204)) return await ownedResponse(controller.signal, async () => null, async () => response.body?.cancel())
      return await jsonBody(response, controller.signal, statuses !== undefined)
    } catch (error) {
      if (readRepositoryOperationFailure(error)?.cleanupFailed || readVerificationLifecycleFailure(error)?.cleanupFailed) throw error
      active(parent)
      if (timedOut) throw new CollaborationError('timeout')
      const diagnostic = readOperationDiagnostic(error)
      if (diagnostic) throw new CollaborationError(diagnostic)
      throw error instanceof CollaborationError ? error : new CollaborationError('network')
    } finally { clearTimeout(timer); parent.removeEventListener('abort', cancel) }
  }
}
