import { GitHubError } from './remote-policy'

export type VerificationLifecycleFlags = Readonly<{ operationFailed: boolean; cleanupFailed: boolean }>
const failures = new WeakMap<object, VerificationLifecycleFlags>()
const lookup = failures.get.bind(failures)
const remember = failures.set.bind(failures)

/** Construction alone never grants a trusted brand, including reflected construction. */
class VerificationLifecycleError extends GitHubError {
  constructor(kind: 'operation' | 'cleanup' | 'both') {
    super(kind === 'cleanup' ? 'GitHub 验证清理未确认完成。' : kind === 'both' ?
      'GitHub 验证未完成，且资源清理未确认完成。' : 'GitHub 验证未完成；未显示敏感错误信息。')
    this.name = 'VerificationLifecycleError'
    Object.freeze(this)
  }
}
Object.freeze(VerificationLifecycleError.prototype)
Object.freeze(VerificationLifecycleError)

/** Identity only: never inspect provider properties, prototypes, names, getters or causes. */
export function readVerificationLifecycleFailure(error: unknown): VerificationLifecycleFlags | null {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return null
  return lookup(error) ?? null
}

function failure(operationFailed: boolean, cleanupFailed: boolean): GitHubError {
  const flags = Object.freeze({ operationFailed, cleanupFailed })
  const error = new VerificationLifecycleError(operationFailed ? cleanupFailed ? 'both' : 'operation' : 'cleanup')
  remember(error, flags)
  return error
}

/** Await both real promises, even on failure. This does not cancel or kill uncooperative work.
 * Only this module's prior failure identities contribute flags; cleanup rejection always means
 * that this cleanup was not confirmed. No provider error or cause is retained or displayed.
 */
export async function withVerificationLifecycle<T>(action: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
  let value!: T
  let operationFailed = false
  let cleanupFailed = false
  try { value = await action() } catch (error) {
    const prior = readVerificationLifecycleFailure(error)
    operationFailed = prior?.operationFailed ?? true
    cleanupFailed = prior?.cleanupFailed ?? false
  }
  try { await cleanup() } catch (error) {
    const prior = readVerificationLifecycleFailure(error)
    operationFailed ||= prior?.operationFailed ?? false
    cleanupFailed = true
  }
  if (operationFailed || cleanupFailed) throw failure(operationFailed, cleanupFailed)
  return value
}
