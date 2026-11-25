import type { SandboxSessionFactory } from '../sandbox/session'
import { createWindowsSandboxSession } from '../sandbox/windows'
import { macCompileAccepted, macTrustedRuntimes } from './darwin-runtime'
import type { PreparedTex } from './prepare'
import { trustedRuntimes } from './runtime-cache'

export interface RuntimeSource { get(dataRoot: string, signal?: AbortSignal): Promise<PreparedTex | null> }
export interface TexBackend {
  platform: 'win32' | 'darwin'
  runtimes: RuntimeSource
  createSession: SandboxSessionFactory
}

/**
 * The only place that maps a platform to its trusted TeX resources and isolation backend. Returns null when local
 * compilation is not enabled: every platform but Windows, and macOS until its release pins exist (darwin-runtime.ts).
 * A backend here is necessary, not sufficient: each runtime source still refuses until its own checks pass.
 */
export function texBackend(platform: NodeJS.Platform = process.platform, macAccepted: boolean = macCompileAccepted()): TexBackend | null {
  if (platform === 'win32') return { platform, runtimes: trustedRuntimes, createSession: createWindowsSandboxSession }
  if (platform === 'darwin' && macAccepted)
    return { platform, runtimes: macTrustedRuntimes, createSession: macTrustedRuntimes.createSession }
  return null
}
