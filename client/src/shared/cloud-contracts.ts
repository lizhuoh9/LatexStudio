import type { CloudAccount, CloudProject } from './collaboration-contracts'
import type { ProjectInfo, SyncResult } from './workspace-contracts'

/** Only public metadata crosses IPC. Handles are single-use, session-bound selections. */
export interface CloudProjectChoice { handle: string; project: CloudProject }
export interface CloudInvitation {
  handle: string
  owner: string
  name: string
  inviter: string
}
export interface CloudConnection {
  projectId: number
  owner: string
  name: string
  branch: string
}
export interface CloudWorkspaceStatus {
  configured: boolean
  signedIn: boolean
  account: CloudAccount | null
  connection: CloudConnection | null
  autoSync: boolean
  lastSyncedAt: string | null
  message: string
}
export interface CloudCreateResult {
  project: { id: number; owner: string; name: string; private: true }
  connected: boolean
  message: string
}
export interface CloudActionResult { message: string }

/** Ordinary GitHub workflows. No token, arbitrary remote endpoint or local path is accepted. */
export interface CloudApi {
  status(): Promise<CloudWorkspaceStatus>
  openAuthorization(): Promise<void>
  openInvitations(): Promise<void>
  projects(): Promise<CloudProjectChoice[]>
  createPrivateProject(name: string): Promise<CloudCreateResult>
  linkProject(handle: string): Promise<CloudWorkspaceStatus>
  downloadProject(handle: string): Promise<ProjectInfo | null>
  joinProject(link: string): Promise<ProjectInfo | null>
  shareProject(): Promise<string>
  inviteCollaborator(login: string): Promise<CloudActionResult>
  invitations(): Promise<CloudInvitation[]>
  acceptInvitation(handle: string): Promise<CloudActionResult>
  sync(summary: string, background: boolean): Promise<SyncResult>
  setAutoSync(enabled: boolean): Promise<CloudWorkspaceStatus>
}

export const CLOUD_CHANNELS = {
  status: 'cloud:status', authorization: 'cloud:open-authorization', openInvitations: 'cloud:open-invitations', projects: 'cloud:projects', create: 'cloud:create-private', link: 'cloud:link',
  download: 'cloud:download', join: 'cloud:join', share: 'cloud:share', invite: 'cloud:invite',
  invitations: 'cloud:invitations', accept: 'cloud:accept-invitation', sync: 'cloud:sync', auto: 'cloud:auto-sync'
} as const
