import type { StoredSession } from './session-policy'
import type { CollaborationTransport } from './transport'
import { active, CollaborationError, durableToken, isDurable, record, sessionToken, type SessionToken } from './validation'

export const RENEW_BEFORE_MS = 5 * 60_000
export function accessRemaining(token: SessionToken, now: number): number {
  return Math.min(token.expiresAt - now, token.monotonicExpiresAt - performance.now())
}
export function liveRefresh(token: SessionToken, now: number): boolean {
  return typeof token.refreshToken === 'string' && typeof token.refreshExpiresAt === 'number' &&
    typeof token.refreshMonotonicExpiresAt === 'number' && token.refreshExpiresAt > now && token.refreshMonotonicExpiresAt > performance.now()
}
export function restoredToken(saved: StoredSession, now: number): SessionToken {
  return { token: saved.token, conservative: saved.conservative, expiresAt: saved.expiresAt,
    monotonicExpiresAt: performance.now() + saved.expiresAt - now,
    ...(saved.refreshToken && saved.refreshExpiresAt ? { refreshToken: saved.refreshToken, refreshExpiresAt: saved.refreshExpiresAt,
      refreshMonotonicExpiresAt: performance.now() + saved.refreshExpiresAt - now } : {}) }
}
/** Official GitHub App DEVICE-flow rotation, never a web-flow secret or cached repository authority. */
export async function renewToken(transport: CollaborationTransport, clientId: string, token: SessionToken,
  now: () => number, signal: AbortSignal): Promise<SessionToken> {
  if (!liveRefresh(token, now())) throw new CollaborationError('expired')
  // Nothing rotates for a non-expiring OAuth token: only the local window moves, and every caller then re-verifies the account.
  if (isDurable(token)) { active(signal); return durableToken(token.token, now()) }
  const data = record(await transport.refresh(clientId, token.refreshToken!, signal))
  active(signal)
  if (data.error === 'bad_refresh_token' || data.error === 'expired_token') throw new CollaborationError('unauthorized')
  if (data.error !== undefined) throw new CollaborationError('response')
  const renewed = sessionToken(data, now())
  if (isDurable(renewed)) throw new CollaborationError('response') // a rotating session never becomes non-expiring
  if (!liveRefresh(renewed, now()) || accessRemaining(renewed, now()) <= 0) throw new CollaborationError('response')
  return renewed
}
