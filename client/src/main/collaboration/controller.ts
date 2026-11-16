import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { COLLABORATION_CHANNELS as C, type CollaborationState, type DevicePrompt } from '../../shared/collaboration-contracts'
import { isTrustedSettingsSender } from '../url-policy'
import { GitHubAccountService } from './service'
import { githubClientId } from './configuration'
import { publicProject, publicState } from './public-state'
import { EncryptedSessionStore } from './session-store'

const DEVICE_URI = 'https://github.com/login/device'

export class CollaborationController {
  readonly service: GitHubAccountService
  private closing = false
  private loginRequested = false
  private browserWork = new Map<string, Promise<void>>()

  constructor(private readonly window: BrowserWindow, private readonly url: string, clientId = githubClientId(), dataRoot?: string) {
    this.service = new GitHubAccountService({ clientId, onState: state => this.publish(state),
      ...(dataRoot ? { sessionStore: new EncryptedSessionStore(dataRoot) } : {}),
      openAuthorization: async (prompt, signal) => this.loginRequested ? this.openPrompt(prompt, signal) : Promise.reject(new Error('尚未请求登录。')) })
    window.once('closed', () => { this.blockNewActions(); void this.cancelAndWait().catch(() => undefined) })
  }

  register(): void {
    this.handle(C.status, async () => publicState(await this.service.restoreSession()))
    // The trusted explicit login action is the consent to open GitHub; no second native prompt.
    this.handle(C.login, async () => this.startLogin())
    this.handle(C.cancel, () => this.cancelAndWait())
    this.handle(C.logout, () => this.logout())
    this.handle(C.openVerification, () => this.openVerification())
    this.handle(C.projects, async () => (await this.service.projects()).map(publicProject))
  }

  private trusted(event: IpcMainInvokeEvent): boolean {
    return !this.window.isDestroyed() && isTrustedSettingsSender(event.sender.id, this.window.webContents.id,
      event.senderFrame === this.window.webContents.mainFrame, event.senderFrame?.url ?? '', this.url)
  }

  private handle(channel: string, operation: () => Promise<unknown>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.trusted(event) || args.length) throw new Error('此页面不能管理协作登录。')
      if (this.closing && channel !== C.cancel) throw new Error('正在安全关闭，请稍候。')
      try { return await operation() }
      catch { throw new Error('协作请求未完成，请重试。') }
    })
  }

  private publish(state: CollaborationState): void {
    if (state.phase !== 'authorizing') this.loginRequested = false
    if (!this.window.isDestroyed()) this.window.webContents.send(C.state, publicState(state))
  }

  private startLogin(): CollaborationState {
    const state = this.service.status()
    if (state.phase === 'unconfigured' || state.phase === 'authorizing' || state.phase === 'signed-in') return publicState(state)
    this.loginRequested = true
    return publicState(this.service.startLogin())
  }

  private openVerification(): Promise<void> {
    const prompt = this.service.status().authorization
    if (!prompt) return Promise.reject(new Error('授权已失效，请重新登录。'))
    return this.openPrompt(prompt)
  }

  private assertPrompt(prompt: DevicePrompt, signal?: AbortSignal): void {
    const state = this.service.status(), current = state.authorization
    if (this.closing || this.window.isDestroyed() || signal?.aborted || state.phase !== 'authorizing' || !current ||
      current.userCode !== prompt.userCode || current.expiresAt !== prompt.expiresAt ||
      current.verificationUri !== DEVICE_URI || prompt.verificationUri !== DEVICE_URI ||
      !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(prompt.userCode) || !Number.isFinite(prompt.expiresAt) ||
      prompt.expiresAt <= Date.now()) throw new Error('授权已失效，请重新登录。')
  }

  private openPrompt(prompt: DevicePrompt, signal?: AbortSignal): Promise<void> {
    this.assertPrompt(prompt, signal)
    const key = `${prompt.expiresAt}:${prompt.userCode}`, existing = this.browserWork.get(key)
    if (existing) return existing
    const work = Promise.resolve().then(() => {
      this.assertPrompt(prompt, signal)
      return shell.openExternal(DEVICE_URI)
    }).finally(() => { if (this.browserWork.get(key) === work) this.browserWork.delete(key) })
    this.browserWork.set(key, work)
    return work
  }

  private async logout(): Promise<CollaborationState> {
    this.loginRequested = false
    try { return publicState(await this.service.logout()) }
    finally { await Promise.allSettled([...this.browserWork.values()]) }
  }

  blockNewActions(): void { this.closing = true; this.loginRequested = false }
  resumeActions(): void { this.closing = false; this.service.resumeActions() }
  async cancelAndWait(): Promise<CollaborationState> {
    this.loginRequested = false
    try { return publicState(await this.service.cancelAndWait()) }
    finally { await Promise.allSettled([...this.browserWork.values()]) }
  }
}
