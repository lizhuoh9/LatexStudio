import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CredentialVault } from '../src/main/github/credentials'
import type { RepositoryOperationOptions } from '../src/main/github/repository-operation'

// UNRUN definitions. All FS/Git/Vault/HTTP dependencies are strict synthetic call stubs.
// These assertions concern sequencing/ownership, not native filesystem/tree safety or GitHub acceptance.
const fake = vi.hoisted(() => {
  const call = () => vi.fn<(...args: unknown[]) => Promise<unknown>>()
  return {
    git: { getConfig: call(), addRemote: call(), currentBranch: call(), writeRef: call(), clone: call(),
      fetch: call(), checkout: call(), isDescendent: call(), push: call(), log: call() },
    ensure: call(), changes: call(), history: call(), snapshot: call(), readdir: call(), assertDirectory: call(),
    files: call(), head: call(), validate: call(), collision: call(), readMetadata: call(), writeMetadata: call(),
    verify: call(), http: vi.fn<(...args: unknown[]) => unknown>(), close: call(),
    vault: { storageDescription: 'synthetic memory vault', save: call(), load: call(), remove: call() },
  }
})
vi.mock('node:fs', () => ({ default: {} }))
vi.mock('node:fs/promises', () => ({ readdir: fake.readdir }))
vi.mock('isomorphic-git', () => ({ default: fake.git }))
vi.mock('../src/main/github/credentials', () => ({ CredentialVault: class {} }))
vi.mock('../src/main/github/files', () => ({ assertProjectDirectory: fake.assertDirectory, assertWorkingFiles: fake.files,
  headOid: fake.head, validateTree: fake.validate, checkCheckout: fake.collision }))
vi.mock('../src/main/github/local-history', () => ({ ensureRepository: fake.ensure, localChanges: fake.changes,
  localHistory: fake.history, saveSnapshot: fake.snapshot }))
vi.mock('../src/main/github/metadata', () => ({ readMetadata: fake.readMetadata, writeMetadata: fake.writeMetadata,
  emptyMetadata: () => ({ version: 1, connection: null, accountId: null, conflict: false }) }))
// This synthetic legacy-PAT root has no ordinary App binding; real binding safety is exercised separately.
vi.mock('../src/main/github/cloud-binding', () => ({ readCloudBinding: async () => null }))
vi.mock('../src/main/github/transport', () => ({ verifyGitHub: fake.verify, githubHttp: fake.http }))
import { GitHubRepository } from '../src/main/github/repository'
import { GitHubError } from '../src/main/github/remote-policy'

const settings = { url: 'https://github.com/team/paper', token: 'ghp_synthetic-private' }
const identity = { login: 'alice', id: 42, branch: 'main' }
const connection = { url: `${settings.url}.git`, owner: 'team', repository: 'paper', login: 'alice', branch: 'main' }
const metadata = () => ({ version: 1, connection: { ...connection }, accountId: 42, conflict: false })
const accepted = { ok: true, error: null, refs: { 'refs/heads/main': { ok: true, error: '' } } }
const repository = () => new GitHubRepository('D:/synthetic/project', fake.vault as unknown as CredentialVault)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function track(promise: Promise<unknown>) {
  const state = { done: false, result: Promise.resolve<unknown>(undefined) }
  state.result = promise.then((value) => { state.done = true; return value }, (error: unknown) => { state.done = true; return error })
  return state
}
function invoke(service: GitHubRepository, method: 'connect' | 'clone' | 'sync', options: RepositoryOperationOptions) {
  return method === 'sync' ? service.sync('synthetic snapshot', options) : service[method](settings, options)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.resetAllMocks()
  for (const call of [fake.ensure, fake.assertDirectory, fake.validate, fake.collision, fake.writeMetadata,
    fake.close, fake.vault.save, fake.vault.remove, fake.git.addRemote, fake.git.writeRef, fake.git.clone, fake.git.checkout]) call.mockResolvedValue(undefined)
  fake.readdir.mockResolvedValue([])
  fake.files.mockResolvedValue([])
  fake.changes.mockResolvedValue([])
  fake.history.mockResolvedValue([])
  fake.snapshot.mockResolvedValue(null)
  fake.head.mockResolvedValue('local-oid')
  fake.readMetadata.mockImplementation(async () => metadata())
  fake.verify.mockResolvedValue(identity)
  fake.vault.load.mockResolvedValue(settings.token)
  fake.git.getConfig.mockResolvedValue(connection.url)
  fake.git.currentBranch.mockResolvedValue('main')
  fake.git.fetch.mockResolvedValue({ fetchHead: null, defaultBranch: null, fetchHeadDescription: null })
  fake.git.isDescendent.mockResolvedValue(false)
  fake.git.log.mockResolvedValue([])
  fake.git.push.mockResolvedValue(accepted)
  fake.http.mockImplementation(() => ({ request: vi.fn(), close: fake.close }))
})
afterEach(() => { expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.restoreAllMocks() })

it.each(['connect', 'clone', 'sync'] as const)('%s pre-abort performs no local or network action', async (method) => {
  const parent = new AbortController()
  parent.abort()
  await expect(invoke(repository(), method, { signal: parent.signal })).rejects.toMatchObject({
    operationFailed: true, cancelled: true, cleanupFailed: false, localChangesMayExist: false,
  })
  expect(fake.ensure).not.toHaveBeenCalled()
  expect(fake.readdir).not.toHaveBeenCalled()
  expect(fake.verify).not.toHaveBeenCalled()
  expect(fake.http).not.toHaveBeenCalled()
  expect(fake.vault.save).not.toHaveBeenCalled()
  expect(fake.writeMetadata).not.toHaveBeenCalled()
})

it.each(['clone', 'sync'] as const)('%s awaits its required close before resolving success', async (method) => {
  const close = deferred<void>()
  fake.close.mockReturnValue(close.promise)
  const operation = track(invoke(repository(), method, {}))
  await vi.advanceTimersByTimeAsync(0)
  expect(fake.close).toHaveBeenCalledTimes(1)
  expect(operation.done).toBe(false)
  const verifyOptions = fake.verify.mock.calls[0]?.[2] as { signal: AbortSignal }
  const httpOptions = fake.http.mock.calls[0]?.[2] as { signal: AbortSignal }
  expect(verifyOptions.signal).toBe(httpOptions.signal)
  close.resolve(undefined)
  expect(await operation.result).not.toBeInstanceOf(Error)
  expect(fake.close).toHaveBeenCalledTimes(1)
})

it('clone keeps noCheckout, validates/collision-checks before force:false checkout, then remembers', async () => {
  await repository().clone(settings)
  expect(fake.git.clone).toHaveBeenCalledWith(expect.objectContaining({ noCheckout: true, noTags: true, ref: 'refs/heads/main' }))
  expect(fake.validate).toHaveBeenCalledWith('D:/synthetic/project', 'local-oid')
  expect(fake.collision).toHaveBeenCalledWith('D:/synthetic/project', 'local-oid')
  expect(fake.git.checkout).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
  expect(fake.validate.mock.invocationCallOrder[0]).toBeLessThan(fake.collision.mock.invocationCallOrder[0]!)
  expect(fake.collision.mock.invocationCallOrder[0]).toBeLessThan(fake.git.checkout.mock.invocationCallOrder[0]!)
  expect(fake.git.checkout.mock.invocationCallOrder[0]).toBeLessThan(fake.vault.save.mock.invocationCallOrder[0]!)
  expect(fake.vault.save).toHaveBeenCalledWith(connection.url.toLowerCase(), settings.token)
  expect(JSON.stringify(fake.writeMetadata.mock.calls)).not.toContain(settings.token)
})

it('clone explicitly narrows its HTTP capability to readOnly while sync retains force:false upload', async () => {
  const service = repository()
  await service.clone(settings)
  await service.sync('controlled upload')
  expect(fake.http.mock.calls[0]?.[2]).toMatchObject({ readOnly: true })
  expect((fake.http.mock.calls[1]?.[2] as { readOnly?: boolean }).readOnly).not.toBe(true)
  expect(fake.git.push).toHaveBeenCalledTimes(1)
  expect(fake.git.push).toHaveBeenCalledWith(expect.objectContaining({ force: false }))
})

it('clone primary plus close failure are both retained without fake-provider auth text', async () => {
  fake.git.clone.mockRejectedValueOnce(new GitHubError(`Authorization: Bearer ${settings.token}`))
  fake.close.mockRejectedValueOnce(new Error(`https://user:${settings.token}@evil.example`))
  const error = await repository().clone(settings).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: true, localChangesMayExist: true })
  expect(String(error)).not.toContain(settings.token)
  expect(error).not.toHaveProperty('cause')
  expect(fake.close).toHaveBeenCalledTimes(1)
  expect(fake.validate).not.toHaveBeenCalled()
  expect(fake.git.checkout).not.toHaveBeenCalled()
  expect(fake.vault.save).not.toHaveBeenCalled()
})

it('a close-only rejection cannot turn a completed clone into success', async () => {
  fake.close.mockRejectedValueOnce(new Error(settings.token))
  await expect(repository().clone(settings)).rejects.toMatchObject({ operationFailed: false, cleanupFailed: true, localChangesMayExist: true })
  expect(fake.git.clone).toHaveBeenCalledTimes(1)
  expect(fake.git.checkout).toHaveBeenCalledTimes(1)
})

it.each(['connect', 'clone', 'sync'] as const)('%s blocks all next side effects after verification triggers cancellation', async (method) => {
  const parent = new AbortController()
  fake.verify.mockImplementationOnce(async () => { parent.abort(); return identity })
  await expect(invoke(repository(), method, { signal: parent.signal })).rejects.toMatchObject({ operationFailed: true, cancelled: true, cleanupFailed: false })
  expect(fake.http).not.toHaveBeenCalled()
  expect(fake.git.addRemote).not.toHaveBeenCalled()
  expect(fake.git.writeRef).not.toHaveBeenCalled()
  expect(fake.vault.save).not.toHaveBeenCalled()
  expect(fake.writeMetadata).not.toHaveBeenCalled()
})

it('clone cancellation after tree validation prohibits collision work, checkout and credentials', async () => {
  const parent = new AbortController()
  fake.validate.mockImplementationOnce(async () => { parent.abort() })
  await expect(repository().clone(settings, { signal: parent.signal })).rejects.toMatchObject({ cancelled: true, localChangesMayExist: true })
  expect(fake.close).toHaveBeenCalledTimes(1)
  expect(fake.collision).not.toHaveBeenCalled()
  expect(fake.git.checkout).not.toHaveBeenCalled()
  expect(fake.vault.save).not.toHaveBeenCalled()
  expect(fake.writeMetadata).not.toHaveBeenCalled()
})

it('sync abort after actual checkout leaves possible worktree changes but prohibits ref and metadata writes', async () => {
  const parent = new AbortController()
  fake.git.fetch.mockResolvedValueOnce({ fetchHead: 'remote-oid' })
  fake.git.isDescendent.mockResolvedValueOnce(true)
  fake.git.checkout.mockImplementation(async (options) => { if (!(options as { dryRun?: boolean }).dryRun) parent.abort() })
  await expect(repository().sync('before download', { signal: parent.signal })).rejects.toMatchObject({ cancelled: true, localChangesMayExist: true })
  expect(fake.git.checkout).toHaveBeenCalledTimes(2)
  expect(fake.git.checkout).toHaveBeenCalledWith(expect.objectContaining({ force: false, dryRun: true }))
  expect(fake.git.writeRef).not.toHaveBeenCalled()
  expect(fake.writeMetadata).not.toHaveBeenCalled()
  expect(fake.git.push).not.toHaveBeenCalled()
  expect(fake.close).toHaveBeenCalledTimes(1)
})

it('connect cancellation after vault save reports partial state and does not write metadata or rollback', async () => {
  const parent = new AbortController()
  fake.vault.save.mockImplementationOnce(async () => { parent.abort() })
  await expect(repository().connect(settings, { signal: parent.signal })).rejects.toMatchObject({ cancelled: true, localChangesMayExist: true })
  expect(fake.vault.save).toHaveBeenCalledTimes(1)
  expect(fake.writeMetadata).not.toHaveBeenCalled()
  expect(fake.vault.remove).not.toHaveBeenCalled()
})

it('queued cancellation uses the original snapshotted parent with zero new operations', async () => {
  const waiting = deferred<void>()
  fake.ensure.mockReturnValueOnce(waiting.promise)
  const service = repository()
  const first = service.status()
  await vi.advanceTimersByTimeAsync(0)
  const parent = new AbortController()
  const replacement = new AbortController()
  const options: RepositoryOperationOptions = { signal: parent.signal, timeoutMs: 10 }
  const second = track(service.clone(settings, options))
  options.signal = replacement.signal
  options.timeoutMs = 120000
  parent.abort()
  await vi.advanceTimersByTimeAsync(50)
  expect(second.done).toBe(false)
  waiting.resolve(undefined)
  await first
  expect(await second.result).toMatchObject({ cancelled: true, localChangesMayExist: false })
  expect(fake.ensure).toHaveBeenCalledTimes(1)
  expect(fake.readdir).not.toHaveBeenCalled()
  expect(fake.verify).not.toHaveBeenCalled()
  expect(fake.http).not.toHaveBeenCalled()
})

it('the operation deadline starts after its serial queue rather than at public invocation', async () => {
  const waiting = deferred<void>()
  fake.ensure.mockReturnValueOnce(waiting.promise)
  const service = repository()
  const first = service.status()
  await vi.advanceTimersByTimeAsync(0)
  const second = track(service.clone(settings, { timeoutMs: 10 }))
  await vi.advanceTimersByTimeAsync(50)
  waiting.resolve(undefined)
  await first
  expect(await second.result).toEqual(connection)
  expect(fake.close).toHaveBeenCalledTimes(1)
})

it('cannot enlarge the timeout by mutating queued options before verification starts', async () => {
  const waiting = deferred<void>()
  const verified = deferred<typeof identity>()
  fake.ensure.mockReturnValueOnce(waiting.promise)
  fake.verify.mockReturnValueOnce(verified.promise)
  const service = repository()
  const first = service.status()
  await vi.advanceTimersByTimeAsync(0)
  const options: RepositoryOperationOptions = { timeoutMs: 10 }
  const second = track(service.clone(settings, options))
  options.timeoutMs = 120000
  waiting.resolve(undefined)
  await first
  await vi.advanceTimersByTimeAsync(11)
  expect(second.done).toBe(false)
  verified.resolve(identity)
  expect(await second.result).toMatchObject({ timedOut: true, localChangesMayExist: false })
  expect(fake.http).not.toHaveBeenCalled()
})

it('awaits an expired in-flight clone and then its close before rejecting, with no late checkout', async () => {
  const cloned = deferred<void>()
  const closed = deferred<void>()
  fake.git.clone.mockReturnValueOnce(cloned.promise)
  fake.close.mockReturnValueOnce(closed.promise)
  const operation = track(repository().clone(settings, { timeoutMs: 10 }))
  await vi.advanceTimersByTimeAsync(11)
  expect(operation.done).toBe(false)
  expect(fake.close).not.toHaveBeenCalled()
  cloned.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(operation.done).toBe(false)
  expect(fake.close).toHaveBeenCalledTimes(1)
  closed.resolve(undefined)
  expect(await operation.result).toMatchObject({ timedOut: true, localChangesMayExist: true, cleanupFailed: false })
  expect(fake.head).not.toHaveBeenCalled()
  expect(fake.git.checkout).not.toHaveBeenCalled()
  expect(fake.vault.save).not.toHaveBeenCalled()
})

it('scope abort during finally close prevents a successful clone outcome', async () => {
  const parent = new AbortController()
  const closed = deferred<void>()
  fake.close.mockReturnValueOnce(closed.promise)
  const operation = track(repository().clone(settings, { signal: parent.signal }))
  await vi.advanceTimersByTimeAsync(0)
  parent.abort()
  expect(operation.done).toBe(false)
  closed.resolve(undefined)
  expect(await operation.result).toMatchObject({ operationFailed: true, cancelled: true, cleanupFailed: false })
})

it('an accepted push followed by cancellation is ambiguous, never forced, retried or finalized locally', async () => {
  const parent = new AbortController()
  fake.git.push.mockImplementationOnce(async () => { parent.abort(); return accepted })
  const error = await repository().sync('saved first', { signal: parent.signal }).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ operationFailed: true, cancelled: true, remoteWriteMayHaveCompleted: true, localChangesMayExist: true })
  expect(fake.snapshot).toHaveBeenCalledTimes(1)
  expect(fake.git.push).toHaveBeenCalledTimes(1)
  expect(fake.git.push).toHaveBeenCalledWith(expect.objectContaining({ force: false, ref: 'refs/heads/main', remoteRef: 'refs/heads/main' }))
  expect(fake.writeMetadata).not.toHaveBeenCalled()
  expect(fake.vault.remove).not.toHaveBeenCalled()
  expect(fake.close).toHaveBeenCalledTimes(1)
})

it.each(['connect', 'clone'] as const)('%s binds canonical repo and token before its queue can observe settings mutation', async (method) => {
  const waiting = deferred<void>()
  fake.ensure.mockReturnValueOnce(waiting.promise)
  const service = repository()
  const first = service.status()
  await vi.advanceTimersByTimeAsync(0)
  const input = { ...settings }
  const operation = track(service[method](input))
  input.url = 'https://github.com/other/wrong'
  input.token = 'ghp_wrong-token'
  waiting.resolve(undefined)
  await first
  expect(await operation.result).toEqual(connection)
  expect(fake.verify).toHaveBeenCalledWith(expect.objectContaining({ url: connection.url }), settings.token, expect.any(Object))
  expect(fake.vault.save).toHaveBeenCalledWith(connection.url.toLowerCase(), settings.token)
  expect(Object.isFrozen(fake.verify.mock.calls[0]?.[0])).toBe(true)
  if (method === 'clone') {
    expect(fake.git.clone).toHaveBeenCalledWith(expect.objectContaining({ url: connection.url }))
    expect(fake.http.mock.calls[0]?.[1]).toBe(settings.token)
  } else expect(fake.http).not.toHaveBeenCalled()
})

it.each(['connect', 'clone'] as const)('%s cannot use a replacement token after verification has begun', async (method) => {
  const verified = deferred<typeof identity>()
  fake.verify.mockReturnValueOnce(verified.promise)
  const input = { ...settings }
  const operation = track(repository()[method](input))
  await vi.advanceTimersByTimeAsync(0)
  expect(fake.verify.mock.calls[0]?.[1]).toBe(settings.token)
  input.token = 'ghp_unverified-replacement'
  input.url = 'https://github.com/other/unverified'
  verified.resolve(identity)
  expect(await operation.result).toEqual(connection)
  expect(fake.vault.save).toHaveBeenCalledWith(connection.url.toLowerCase(), settings.token)
  if (method === 'clone') {
    expect(fake.http.mock.calls[0]?.[0]).toBe(fake.verify.mock.calls[0]?.[0])
    expect(fake.http.mock.calls[0]?.[1]).toBe(settings.token)
    expect(fake.git.clone).toHaveBeenCalledWith(expect.objectContaining({ url: connection.url }))
  }
  expect(JSON.stringify(fake.writeMetadata.mock.calls)).not.toContain('unverified')
})

it.each(['connect', 'clone'] as const)('%s reads input getters once before enqueue and never re-reads the original settings', async (method) => {
  const url = vi.fn(() => settings.url)
  const token = vi.fn(() => settings.token)
  const input = Object.defineProperties({}, { url: { get: url }, token: { get: token } }) as typeof settings
  const operation = track(repository()[method](input))
  expect(url).toHaveBeenCalledTimes(1)
  expect(token).toHaveBeenCalledTimes(1)
  url.mockImplementation(() => { throw new Error(settings.token) })
  token.mockImplementation(() => { throw new Error(settings.token) })
  expect(await operation.result).toEqual(connection)
  expect(url).toHaveBeenCalledTimes(1)
  expect(token).toHaveBeenCalledTimes(1)
  expect(fake.vault.save).toHaveBeenCalledWith(connection.url.toLowerCase(), settings.token)
})

it.each(['connect', 'clone'] as const)('%s rejects a throwing settings getter before any mutation or provider call', async (method) => {
  const input = Object.defineProperty({ ...settings }, 'token', { get() { throw new GitHubError(`Authorization: ${settings.token}`) } })
  const error = await repository()[method](input).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: false, localChangesMayExist: false })
  expect(String(error)).not.toContain(settings.token)
  expect(fake.ensure).not.toHaveBeenCalled()
  expect(fake.readdir).not.toHaveBeenCalled()
  expect(fake.verify).not.toHaveBeenCalled()
  expect(fake.http).not.toHaveBeenCalled()
  expect(fake.vault.save).not.toHaveBeenCalled()
})

it('opaque identity-provider failure is primary-only classification, not a global cleanup certificate', async () => {
  fake.verify.mockRejectedValueOnce(new GitHubError(`opaque inner cleanup ${settings.token}`))
  const error = await repository().clone(settings).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ operationFailed: true, cleanupFailed: false })
  expect(fake.http).not.toHaveBeenCalled()
  expect(fake.git.clone).not.toHaveBeenCalled()
  expect(String(error)).not.toContain(settings.token)
})
