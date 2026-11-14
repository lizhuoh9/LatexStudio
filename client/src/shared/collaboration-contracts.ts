export type CollaborationPhase = 'unconfigured' | 'signed-out' | 'authorizing' | 'signed-in' | 'error'

export interface CloudAccount {
  id: number
  login: string
  name: string | null
}

export interface DevicePrompt {
  userCode: string
  verificationUri: 'https://github.com/login/device'
  expiresAt: number
}

export interface CollaborationState {
  phase: CollaborationPhase
  message: string
  account: CloudAccount | null
  authorization: DevicePrompt | null
  expiresAt: number | null
  /** False only when the current access token was safely encrypted for valid-session restoration. */
  sessionOnly: boolean
}

/** Metadata only: no credential, arbitrary clone URL, local path or write capability. */
export interface CloudProject {
  id: number
  installationId: number
  owner: string
  name: string
  private: boolean
}

export interface CollaborationApi {
  status(): Promise<CollaborationState>
  startLogin(): Promise<CollaborationState>
  cancelLogin(): Promise<CollaborationState>
  logout(): Promise<CollaborationState>
  openVerification(): Promise<void>
  projects(): Promise<CloudProject[]>
  onState(listener: (state: CollaborationState) => void): () => void
}

export const COLLABORATION_CHANNELS = {
  status: 'collaboration:status', login: 'collaboration:login', cancel: 'collaboration:cancel',
  logout: 'collaboration:logout', openVerification: 'collaboration:open-verification',
  projects: 'collaboration:projects', state: 'collaboration:state'
} as const
