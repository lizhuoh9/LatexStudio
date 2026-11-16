const HOUR = 3600_000
const MAX_REFRESH = 186 * 24 * HOUR
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const KEYS = ['id', 'clientId', 'token', 'issuedAt', 'expiresAt', 'conservative']
const REFRESH_KEYS = ['refreshToken', 'refreshExpiresAt']
export interface StoredSession {
  id: string; clientId: string; token: string; issuedAt: number; expiresAt: number; conservative: boolean
  refreshToken?: string; refreshExpiresAt?: number
}
export interface AccountSessionStore {
  load(clientId: string, now: number, signal?: AbortSignal): Promise<StoredSession | null>
  save(value: StoredSession, signal?: AbortSignal): Promise<boolean>
  clear(expected?: StoredSession): Promise<void>
}
/** Pure bounded metadata policy; does not import Electron, touch storage or authorize a token. */
export function validStoredSession(value: unknown, now: number): StoredSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('保存的登录会话无效。')
  const item = value as Record<string, unknown>, keys = Object.keys(item)
  const invalid = (): Error => new Error('保存的登录会话无效。')
  const renewable = REFRESH_KEYS.some(key => keys.includes(key))
  const expected = renewable ? [...KEYS, ...REFRESH_KEYS] : KEYS
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key)) ||
    typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.clientId !== 'string' || !/^[A-Za-z0-9._-]{10,128}$/.test(item.clientId) ||
    typeof item.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(item.token) || typeof item.conservative !== 'boolean' ||
    !Number.isSafeInteger(item.issuedAt) || !Number.isSafeInteger(item.expiresAt)) throw invalid()
  const issuedAt = item.issuedAt as number, expiresAt = item.expiresAt as number
  if (!Number.isFinite(now) || issuedAt < 0 || issuedAt > now || expiresAt <= issuedAt || expiresAt - issuedAt > (item.conservative ? HOUR : 8 * HOUR)) throw invalid()
  if (renewable && (typeof item.refreshToken !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(item.refreshToken) ||
    !Number.isSafeInteger(item.refreshExpiresAt) || (item.refreshExpiresAt as number) <= expiresAt ||
    (item.refreshExpiresAt as number) - issuedAt > MAX_REFRESH)) throw invalid()
  return { id: item.id, clientId: item.clientId, token: item.token, issuedAt, expiresAt, conservative: item.conservative,
    ...(renewable ? { refreshToken: item.refreshToken as string, refreshExpiresAt: item.refreshExpiresAt as number } : {}) }
}
