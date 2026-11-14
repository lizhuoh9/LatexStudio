import { checkedToken, githubTarget, GitHubError, type GitHubTarget } from './remote-policy'
import { readVerificationLifecycleFailure } from './verification-lifecycle'
import type { GitHubSettings } from '../../shared/workspace-contracts'

export interface RepositoryOperationOptions { signal?: AbortSignal; timeoutMs?: number }
export interface RepositoryConnectionSettings { readonly target: Readonly<GitHubTarget>; readonly token: string }
export const REPOSITORY_OPERATION_TIMEOUT_MS = 120_000
export interface RepositoryOperationFailure {
  operationFailed: boolean
  cleanupFailed: boolean
  cancelled: boolean
  timedOut: boolean
  localChangesMayExist: boolean
  remoteWriteMayHaveCompleted: boolean
}
export interface RepositoryOperationScope {
  readonly signal: AbortSignal
  check(): void
  step<T>(action: () => Promise<T>): Promise<T>
  mutate<T>(action: () => Promise<T>): Promise<T>
  remoteWrite<T>(action: () => Promise<T>): Promise<T>
  own<T extends { close(): Promise<void> }>(client: T): T
}
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener
const removeListener = EventTarget.prototype.removeEventListener
const initialFailure = (): RepositoryOperationFailure => ({ operationFailed: false, cleanupFailed: false,
  cancelled: false, timedOut: false, localChangesMayExist: false, remoteWriteMayHaveCompleted: false })
const operationFailures = new WeakMap<object, Readonly<RepositoryOperationFailure>>()
const lookupFailure = operationFailures.get.bind(operationFailures)
const rememberFailure = operationFailures.set.bind(operationFailures)

/** Only actual completed Scope lifetimes grant this brand, never construction or provider shape. */
export function readRepositoryOperationFailure(error: unknown): Readonly<RepositoryOperationFailure> | null {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null
  return lookupFailure(error) ?? null
}

/** Contains only frozen, locally generated flags: never provider messages, causes or credentials. */
export class RepositoryOperationError extends GitHubError {
  readonly flags: Readonly<RepositoryOperationFailure>

  constructor(flags: RepositoryOperationFailure, invalidOptions = false) {
    super(failureMessage(flags, invalidOptions))
    this.name = 'RepositoryOperationError'
    this.flags = Object.freeze({ ...flags })
    Object.freeze(this)
  }

  get operationFailed(): boolean { return this.flags.operationFailed }
  get cleanupFailed(): boolean { return this.flags.cleanupFailed }
  get cancelled(): boolean { return this.flags.cancelled }
  get timedOut(): boolean { return this.flags.timedOut }
  get localChangesMayExist(): boolean { return this.flags.localChangesMayExist }
  get remoteWriteMayHaveCompleted(): boolean { return this.flags.remoteWriteMayHaveCompleted }
}

function failureMessage(flags: RepositoryOperationFailure, invalidOptions: boolean): string {
  let message = invalidOptions ? '仓库操作参数无效：请核对 GitHub 地址、凭据、真实取消信号及不超过 120 秒的正整数时限。' :
    flags.timedOut ? '仓库操作超过合作时限。' : flags.cancelled ? '仓库操作已取消。' :
      flags.operationFailed ? '仓库操作未完成；未显示敏感错误信息。' : '仓库操作清理失败。'
  if (flags.cleanupFailed) message += ' 网络客户端清理未确认完成。'
  if (flags.localChangesMayExist) message += ' 可能已保留部分本地对象、文件、关联或快照，请检查本地状态。'
  if (flags.remoteWriteMayHaveCompleted) message += ' 远端上传可能已被接收；请先核对远端，不要自动重试或回滚。'
  return message
}

/** Snapshot at the public method call, before its serial queue; no timer starts here. */
export function snapshotRepositoryOperationOptions(options: RepositoryOperationOptions = {}): Readonly<RepositoryOperationOptions> {
  try {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Error()
    const signal = options.signal
    const rawTimeout = options.timeoutMs
    const timeoutMs = rawTimeout === undefined ? REPOSITORY_OPERATION_TIMEOUT_MS : rawTimeout
    if (signal !== undefined && (!(signal instanceof AbortSignal) || typeof signalAborted.call(signal) !== 'boolean')) throw new Error()
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > REPOSITORY_OPERATION_TIMEOUT_MS) throw new Error()
    return Object.freeze({ signal, timeoutMs })
  } catch { throw new RepositoryOperationError({ ...initialFailure(), operationFailed: true }, true) }
}

/** Read each untrusted settings property once, before queueing; later work uses only these primitives. */
export function snapshotRepositoryConnection(settings: GitHubSettings): Readonly<RepositoryConnectionSettings> {
  try {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error()
    const url = settings.url
    const token = settings.token
    const target = Object.freeze(githubTarget(url))
    checkedToken(token)
    return Object.freeze({ target, token })
  } catch { throw new RepositoryOperationError({ ...initialFailure(), operationFailed: true }, true) }
}

class Stopped extends Error {}
class Scope implements RepositoryOperationScope {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private readonly deadline: number
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly parent?: AbortSignal
  private readonly clients = new Set<object>()
  private readonly resources: Array<() => Promise<void>> = []
  private readonly failure = initialFailure()
  private closing = false
  private finished = false
  private readonly parentAbort = () => this.stop('cancelled')

  constructor(options: Readonly<RepositoryOperationOptions>) {
    const timeoutMs = options.timeoutMs ?? REPOSITORY_OPERATION_TIMEOUT_MS
    this.deadline = performance.now() + timeoutMs
    this.parent = options.signal
    this.timer = setTimeout(() => this.stop('timedOut'), timeoutMs)
    if (this.parent) {
      addListener.call(this.parent, 'abort', this.parentAbort, { once: true })
      if (signalAborted.call(this.parent)) this.stop('cancelled')
    }
  }

  check(): void {
    this.observeDeadline()
    if (this.closing || this.failure.cleanupFailed || this.failure.cancelled || this.failure.timedOut) throw new Stopped()
  }

  async step<T>(action: () => Promise<T>): Promise<T> {
    this.check()
    let value!: T
    try { value = await action() } catch (error) { this.captureKnownCleanup(error); throw error }
    this.check()
    return value
  }

  mutate<T>(action: () => Promise<T>): Promise<T> {
    this.check()
    this.failure.localChangesMayExist = true
    return this.step(action)
  }

  remoteWrite<T>(action: () => Promise<T>): Promise<T> {
    this.check()
    this.failure.remoteWriteMayHaveCompleted = true
    return this.step(action)
  }

  own<T extends { close(): Promise<void> }>(client: T): T {
    if (this.finished) throw new Stopped()
    try {
      if (!this.clients.has(client)) {
        const close = client.close
        if (typeof close !== 'function') throw new Stopped()
        this.clients.add(client)
        this.resources.push(() => close.call(client))
      }
    } catch { this.failure.cleanupFailed = true; throw new Stopped() }
    this.check()
    return client
  }

  captureKnownCleanup(error: unknown): void {
    if (readVerificationLifecycleFailure(error)?.cleanupFailed || readRepositoryOperationFailure(error)?.cleanupFailed) this.failure.cleanupFailed = true
  }

  async finish(): Promise<void> {
    this.closing = true
    try { this.controller.abort() } catch { this.failure.cleanupFailed = true }
    try {
      while (this.resources.length) {
        await Promise.all(this.resources.splice(0).reverse().map(async (close) => {
          try { await close() } catch { this.failure.cleanupFailed = true }
        }))
      }
    } finally {
      try { this.observeDeadline() } catch { this.failure.cleanupFailed = true }
      clearTimeout(this.timer)
      try { if (this.parent) removeListener.call(this.parent, 'abort', this.parentAbort) }
      catch { this.failure.cleanupFailed = true }
      this.finished = true
    }
  }

  outcome(operationFailed: boolean): Readonly<RepositoryOperationFailure> {
    return Object.freeze({ ...this.failure, operationFailed: operationFailed || this.failure.cancelled || this.failure.timedOut })
  }

  private observeDeadline(): void {
    if (performance.now() >= this.deadline) this.stop('timedOut')
  }

  private stop(reason: 'cancelled' | 'timedOut'): void {
    this.failure[reason] = true
    this.controller.abort()
  }
}

/** Cooperative lifetime, not a hard CPU/FS/Git deadline. Never races an in-flight action:
 * cancellation is checked after it really settles, then every owned close is awaited.
 * An unfinished provider action/close can therefore keep this promise pending. Partial local
 * writes or accepted remote pushes are possible; no automatic retry, force or rollback occurs.
 */
export async function withRepositoryOperation<T>(options: RepositoryOperationOptions,
  action: (scope: RepositoryOperationScope) => Promise<T>): Promise<T> {
  const scope = new Scope(snapshotRepositoryOperationOptions(options))
  let value!: T
  let failed = false
  try { scope.check(); value = await action(scope); scope.check() }
  catch (error) { scope.captureKnownCleanup(error); failed = true }
  await scope.finish()
  const flags = scope.outcome(failed)
  if (flags.operationFailed || flags.cleanupFailed) {
    const error = new RepositoryOperationError(flags)
    rememberFailure(error, Object.freeze({ ...flags }))
    throw error
  }
  return value
}
