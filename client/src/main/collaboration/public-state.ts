import type { CloudProject, CollaborationState } from '../../shared/collaboration-contracts'

/** Explicit whitelist at the IPC boundary, even if service internals acquire new fields. */
export function publicState(state: CollaborationState): CollaborationState {
  return {
    phase: state.phase, message: state.message, sessionOnly: state.sessionOnly !== false, expiresAt: state.expiresAt,
    account: state.account ? { id: state.account.id, login: state.account.login, name: state.account.name } : null,
    authorization: state.authorization ? {
      userCode: state.authorization.userCode, verificationUri: 'https://github.com/login/device',
      expiresAt: state.authorization.expiresAt
    } : null
  }
}

export function publicProject(project: CloudProject): CloudProject {
  return { id: project.id, installationId: project.installationId, owner: project.owner,
    name: project.name, private: project.private }
}
