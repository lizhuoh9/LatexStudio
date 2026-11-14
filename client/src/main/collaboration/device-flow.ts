import type { DevicePrompt } from '../../shared/collaboration-contracts'
import { abortable, CollaborationTransport } from './transport'
import { active, CollaborationError, deviceSession, record, sessionToken, type SessionToken } from './validation'

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>
export interface DeviceFlowOptions {
  signal: AbortSignal
  now: () => number
  sleep: Sleep
  onPrompt: (prompt: DevicePrompt) => void | Promise<void>
}

export const sleep: Sleep = (ms, signal) => new Promise<void>((resolve, reject) => {
  const cancel = (): void => { clearTimeout(timer); reject(new CollaborationError('cancelled')) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, ms)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) { signal.removeEventListener('abort', cancel); cancel() }
})

function deviceError(value: unknown): string | null {
  const data = record(value)
  if (data.error === undefined) return null
  if (typeof data.error !== 'string') throw new CollaborationError('response')
  switch (data.error) {
    case 'authorization_pending': case 'slow_down': return data.error
    case 'access_denied': throw new CollaborationError('denied')
    case 'expired_token': throw new CollaborationError('expired')
    case 'device_flow_disabled': case 'incorrect_client_credentials': throw new CollaborationError('disabled')
    default: throw new CollaborationError('response')
  }
}

export async function authorizeDevice(transport: CollaborationTransport, clientId: string,
  options: DeviceFlowOptions): Promise<SessionToken> {
  active(options.signal)
  const controller = new AbortController()
  const started = performance.now()
  let expired = false
  const expire = (): void => { expired = true; controller.abort() }
  const cancel = (): void => controller.abort()
  let timer = setTimeout(expire, 900_000)
  options.signal.addEventListener('abort', cancel, { once: true })
  try {
    return await pollDevice(transport, clientId, { ...options, signal: controller.signal }, (lifetime) => {
      clearTimeout(timer)
      timer = setTimeout(expire, Math.max(0, Math.min(lifetime, 900_000 - (performance.now() - started))))
    })
  } catch (error) {
    active(options.signal)
    if (expired) throw new CollaborationError('expired')
    throw error
  } finally { clearTimeout(timer); options.signal.removeEventListener('abort', cancel) }
}

async function pollDevice(transport: CollaborationTransport, clientId: string,
  options: DeviceFlowOptions, deadline: (lifetime: number) => void): Promise<SessionToken> {
  const { signal, now, sleep: pause, onPrompt } = options
  active(signal)
  const initial = await transport.device(clientId, signal)
  active(signal)
  if (deviceError(initial)) throw new CollaborationError('response')
  const receivedAt = now()
  const device = deviceSession(initial, receivedAt)
  deadline(device.prompt.expiresAt - receivedAt)
  await onPrompt({ ...device.prompt })
  active(signal)
  let interval = device.intervalMs
  for (;;) {
    active(signal)
    const remaining = device.prompt.expiresAt - now()
    if (remaining <= 0) throw new CollaborationError('expired')
    await abortable(pause(Math.min(interval, remaining), signal), signal)
    active(signal)
    if (now() >= device.prompt.expiresAt) throw new CollaborationError('expired')
    const reply = await transport.poll(clientId, device.deviceCode, signal)
    active(signal)
    if (now() >= device.prompt.expiresAt) throw new CollaborationError('expired')
    const error = deviceError(reply)
    if (!error) return sessionToken(reply, now())
    if (error === 'slow_down') interval += 5000
  }
}
