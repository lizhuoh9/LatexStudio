import { contextBridge, ipcRenderer } from 'electron'
import { UPDATE_CHANNELS as U, type UpdateApi, type UpdateState } from '../shared/update-contracts'
import { CLOUD_CHANNELS as G, type CloudApi } from '../shared/cloud-contracts'
import { PROJECT_LIBRARY_CHANNELS as P, type ProjectLibraryApi } from '../shared/project-library-contracts'
import { WORKSPACE_CHANNELS as C, type WorkspaceApi, type WorkspaceEvent } from '../shared/workspace-contracts'
import { TEX_SETUP_CHANNELS as T, type TexSetupApi, type TexSetupState } from '../shared/tex-setup-contracts'
import { COLLABORATION_CHANNELS as A, type CollaborationApi, type CollaborationState } from '../shared/collaboration-contracts'

const api: WorkspaceApi = Object.freeze<WorkspaceApi>({
  project: () => ipcRenderer.invoke(C.project),
  openProject: () => ipcRenderer.invoke(C.open),
  createProject: () => ipcRenderer.invoke(C.create),
  cloneProject: settings => ipcRenderer.invoke(C.clone, settings),
  files: () => ipcRenderer.invoke(C.files),
  readFile: path => ipcRenderer.invoke(C.read, path),
  saveFile: (path, content, revision) => ipcRenderer.invoke(C.save, path, content, revision),
  createFile: (path, content) => ipcRenderer.invoke(C.createFile, path, content),
  environment: () => ipcRenderer.invoke(C.environment),
  compile: request => ipcRenderer.invoke(C.compile, request),
  cancelCompile: () => ipcRenderer.invoke(C.cancelCompile),
  repository: () => ipcRenderer.invoke(C.repository),
  connectGitHub: settings => ipcRenderer.invoke(C.connect, settings),
  disconnectGitHub: () => ipcRenderer.invoke(C.disconnect),
  snapshot: summary => ipcRenderer.invoke(C.snapshot, summary),
  sync: summary => ipcRenderer.invoke(C.sync, summary),
  history: () => ipcRenderer.invoke(C.history),
  revisions: () => ipcRenderer.invoke(C.revisions),
  revisionDetail: id => ipcRenderer.invoke(C.revisionDetail, id),
  restoreRevision: (id, revision) => ipcRenderer.invoke(C.restoreRevision, id, revision),
  repositoryTransfer: () => ipcRenderer.invoke(C.transfer),
  cancelRepositoryTransfer: () => ipcRenderer.invoke(C.cancelTransfer),
  setDirty: dirty => ipcRenderer.send(C.dirty, dirty),
  acknowledgeClose: (requestId, dirty) => ipcRenderer.send(C.closeAck, requestId, dirty),
  onEvent: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WorkspaceEvent): void => listener(payload)
    ipcRenderer.on(C.event, handler)
    return () => { ipcRenderer.removeListener(C.event, handler) }
  }
})

contextBridge.exposeInMainWorld('paperstudio', api)
const updates: UpdateApi = Object.freeze<UpdateApi>({
  status: () => ipcRenderer.invoke(U.status), check: () => ipcRenderer.invoke(U.check),
  openReleases: () => ipcRenderer.invoke(U.releases),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on(U.state, handler)
    return () => { ipcRenderer.removeListener(U.state, handler) }
  }
})
contextBridge.exposeInMainWorld('paperstudioUpdates', updates)
const setup: TexSetupApi = Object.freeze<TexSetupApi>({
  status: () => ipcRenderer.invoke(T.status),
  prepare: () => ipcRenderer.invoke(T.prepare),
  cancel: () => ipcRenderer.invoke(T.cancel),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: TexSetupState): void => listener(state)
    ipcRenderer.on(T.state, handler)
    return () => { ipcRenderer.removeListener(T.state, handler) }
  }
})
contextBridge.exposeInMainWorld('paperstudioSetup', setup)

const collaboration: CollaborationApi = Object.freeze<CollaborationApi>({
  status: () => ipcRenderer.invoke(A.status),
  startLogin: () => ipcRenderer.invoke(A.login),
  cancelLogin: () => ipcRenderer.invoke(A.cancel),
  logout: () => ipcRenderer.invoke(A.logout),
  openVerification: () => ipcRenderer.invoke(A.openVerification),
  projects: () => ipcRenderer.invoke(A.projects),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: CollaborationState): void => listener(state)
    ipcRenderer.on(A.state, handler)
    return () => { ipcRenderer.removeListener(A.state, handler) }
  }
})
contextBridge.exposeInMainWorld('paperstudioCollaboration', collaboration)

const cloud: CloudApi = Object.freeze<CloudApi>({
  status: () => ipcRenderer.invoke(G.status),
  openAuthorization: () => ipcRenderer.invoke(G.authorization),
  openInvitations: () => ipcRenderer.invoke(G.openInvitations),
  projects: () => ipcRenderer.invoke(G.projects),
  createPrivateProject: name => ipcRenderer.invoke(G.create, name),
  linkProject: handle => ipcRenderer.invoke(G.link, handle),
  downloadProject: handle => ipcRenderer.invoke(G.download, handle),
  joinProject: link => ipcRenderer.invoke(G.join, link),
  shareProject: () => ipcRenderer.invoke(G.share),
  inviteCollaborator: login => ipcRenderer.invoke(G.invite, login),
  invitations: () => ipcRenderer.invoke(G.invitations),
  acceptInvitation: handle => ipcRenderer.invoke(G.accept, handle),
  sync: (summary, background) => ipcRenderer.invoke(G.sync, summary, background),
  setAutoSync: enabled => ipcRenderer.invoke(G.auto, enabled)
})
contextBridge.exposeInMainWorld('paperstudioCloud', cloud)

const projects: ProjectLibraryApi = Object.freeze<ProjectLibraryApi>({
  list: () => ipcRenderer.invoke(P.list),
  activate: id => ipcRenderer.invoke(P.activate, id),
  forget: id => ipcRenderer.invoke(P.forget, id),
  onChanged: listener => {
    const handler = (): void => listener()
    ipcRenderer.on(P.changed, handler)
    return () => { ipcRenderer.removeListener(P.changed, handler) }
  }
})
contextBridge.exposeInMainWorld('paperstudioProjects', projects)
