export const UPDATE_CHANNELS = Object.freeze({ status: 'updates:status', check: 'updates:check', releases: 'updates:releases', state: 'updates:state' })
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'error' | 'development'
export interface UpdateState {
  phase: UpdatePhase
  currentVersion: string
  latestVersion: string | null
  manualInstallOnly: true
  message: string
}
export interface UpdateApi {
  status(): Promise<UpdateState>
  check(): Promise<UpdateState>
  openReleases(): Promise<void>
  onState(listener: (state: UpdateState) => void): () => void
}
