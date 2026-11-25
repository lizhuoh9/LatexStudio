/**
 * Platform-neutral contract between the compiler and an isolation backend. The Windows AppContainer helper
 * (windows.ts) and the macOS App Sandbox helper (macos-session.ts) both satisfy it; the compiler never names a platform
 * type. Nothing here grants execution authority: each backend still enforces its own policy.
 */
export type SandboxTool = 'engine' | 'xdvipdfmx' | 'bibtex'

export interface SandboxRunOptions {
  tool?: SandboxTool
  onStdout?: (bytes: Buffer) => void
  onStderr?: (bytes: Buffer) => void
}
export interface SandboxResult { code: number }

export interface SandboxSession {
  run(args: string[], cwd: string, options?: SandboxRunOptions): Promise<SandboxResult>
  cancel(): Promise<void>
  dispose(): Promise<void>
  /**
   * Backends whose work directory is NOT the host snapshot (macOS: the helper's own sandbox container) copy the named
   * files of the fixed output folder back to the host snapshot before the host reads them. A missing file is skipped.
   */
  pull?(names: readonly string[]): Promise<void>
  /** The snapshot root as the engine saw it, when it differs from the host path (SyncTeX records absolute paths). */
  readonly remoteRoot?: string
  /** True when this one session can also run BibTeX in the same work directory (no second session needed). */
  readonly runsBibtex?: boolean
}

export interface SandboxSessionOptions {
  executable: string
  runtimeRoot: string
  tools?: { xdvipdfmx?: string; bibtex?: string }
  workDirs: string[]
  signal?: AbortSignal
  timeoutMs?: number
}
export type SandboxSessionFactory = (options: SandboxSessionOptions) => Promise<SandboxSession>

/**
 * Thrown by a backend when a session ended because the caller asked for it AND cleanup was confirmed. It is the only
 * session failure after which the compiler stays usable; everything else latches.
 */
export class ConfirmedCancellation extends Error {
  readonly confirmedCancellation = true
  constructor(message: string) { super(message); this.name = 'ConfirmedCancellation' }
}
export function isConfirmedCancellation(error: unknown): boolean {
  return error instanceof Error && (error as { confirmedCancellation?: unknown }).confirmedCancellation === true
}

/** Thrown when a backend refused BEFORE starting any process: there is nothing to clean up, so nothing to latch. */
export class SessionNotStarted extends Error {
  readonly sessionNotStarted = true
  constructor(message: string) { super(message); this.name = 'SessionNotStarted' }
}
export function isSessionNotStarted(error: unknown): boolean {
  return error instanceof Error && (error as { sessionNotStarted?: unknown }).sessionNotStarted === true
}
