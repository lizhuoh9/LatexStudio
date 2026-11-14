import type { CloudAccount, CloudProject, DevicePrompt } from '../../shared/collaboration-contracts'

export type Failure = 'cancelled' | 'timeout' | 'network' | 'response' | 'redirect' | 'unauthorized' |
  'denied' | 'expired' | 'disabled' | 'limit' | 'signed-out' | 'selection'
const messages: Record<Failure, string> = {
  cancelled: '操作已取消。', timeout: '云端请求超时，请重试。', network: '云端请求失败，请检查网络后重试。',
  response: '云端返回的信息无法安全使用，请重试。', redirect: '已拒绝云端请求重定向，请稍后重试。',
  unauthorized: '此设备的登录已失效，请重新登录。', denied: '你已取消云端授权。',
  expired: '授权或登录已过期，请重新登录。', disabled: '发布者尚未启用设备登录，请联系软件提供者。',
  limit: '云端项目数量或分页超过安全限额，未返回不完整列表，请联系软件提供者。',
  'signed-out': '请先登录云端账号。',
  selection: '项目选择已失效，请重新打开项目列表后再选择。'
}

export class CollaborationError extends Error {
  constructor(readonly kind: Failure) { super(messages[kind]) }
}
export function failure(error: unknown): CollaborationError {
  return error instanceof CollaborationError ? error : new CollaborationError('network')
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CollaborationError('response')
  return value as Record<string, unknown>
}
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CollaborationError('response')
  }
  return value
}
export function login(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) {
    throw new CollaborationError('response')
  }
  return value
}
export function active(signal: AbortSignal): void {
  if (signal.aborted) throw new CollaborationError('cancelled')
}

export interface DeviceSession { deviceCode: string; prompt: DevicePrompt; intervalMs: number }
export function deviceSession(value: unknown, now: number): DeviceSession {
  const data = record(value)
  if (typeof data.device_code !== 'string' || !/^[a-f0-9]{40}$/i.test(data.device_code) ||
    typeof data.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code) ||
    data.verification_uri !== 'https://github.com/login/device') throw new CollaborationError('response')
  const expires = integer(data.expires_in, 900)
  const interval = data.interval === undefined ? 5 : integer(data.interval, 900)
  return { deviceCode: data.device_code, intervalMs: Math.max(5, interval) * 1000,
    prompt: { userCode: data.user_code, verificationUri: 'https://github.com/login/device', expiresAt: now + expires * 1000 } }
}

export interface SessionToken { token: string; expiresAt: number; monotonicExpiresAt: number; conservative: boolean }
export function sessionToken(value: unknown, now: number): SessionToken {
  const data = record(value)
  if (typeof data.access_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(data.access_token) ||
    typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
    (data.scope !== undefined && data.scope !== '')) throw new CollaborationError('response')
  const expires = data.expires_in === undefined ? 3600 : Math.min(integer(data.expires_in), 8 * 3600)
  return { token: data.access_token, expiresAt: now + expires * 1000,
    monotonicExpiresAt: performance.now() + expires * 1000, conservative: data.expires_in === undefined }
}
export function account(value: unknown): CloudAccount {
  const data = record(value)
  if (data.name !== null && (typeof data.name !== 'string' || data.name.length > 256 ||
    /[\x00-\x1f\x7f]/.test(data.name))) throw new CollaborationError('response')
  return { id: integer(data.id), login: login(data.login), name: data.name as string | null }
}
export function project(value: unknown, installationId: number): CloudProject {
  const data = record(value)
  if (typeof data.name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(data.name) ||
    ['.', '..'].includes(data.name) || typeof data.private !== 'boolean') throw new CollaborationError('response')
  return { id: integer(data.id), installationId, owner: login(record(data.owner).login),
    name: data.name, private: data.private }
}
