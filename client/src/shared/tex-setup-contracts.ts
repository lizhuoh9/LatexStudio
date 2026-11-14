export interface TexSetupState {
  phase: 'required' | 'checking' | 'downloading' | 'extracting' | 'verifying' | 'prepared' | 'error'
  message: string
  completed: number
  total: number
  supported: boolean
  /** Prepared assets are not proof that platform isolation/real compile has passed. */
  compileVerified: boolean
}
export interface TexSetupApi {
  status(): Promise<TexSetupState>
  prepare(): Promise<TexSetupState>
  cancel(): Promise<TexSetupState>
  onState(listener: (state: TexSetupState) => void): () => void
}
export const TEX_SETUP_CHANNELS = {
  status: 'tex-setup:status', prepare: 'tex-setup:prepare', cancel: 'tex-setup:cancel', state: 'tex-setup:state'
} as const
