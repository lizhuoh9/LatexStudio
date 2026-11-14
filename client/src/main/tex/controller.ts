import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { TEX_SETUP_CHANNELS as C, type TexSetupState } from '../../shared/tex-setup-contracts'
import { isTrustedSettingsSender } from '../url-policy'
import { prepareNativeTex, type PreparedTex, type TexPreparationProgress } from './prepare'
import { trustedRuntimes } from './runtime-cache'
import { findBundledTexArchive } from './bundled-runtime'

const PREPARED = '编译组件已就绪。'
const CHECKING = '正在后台验证已有编译组件；可先编辑和保存论文。'
interface RuntimeDetection { state: TexSetupState; runtime: PreparedTex | null; checked: boolean }
interface RuntimeSource { get(dataRoot: string, signal?: AbortSignal): Promise<PreparedTex | null> }
interface PreparationOptions { signal: AbortSignal; onProgress: (state: TexPreparationProgress) => void }
type Preparation = (dataRoot: string, options: PreparationOptions) => Promise<PreparedTex>
const prepareBundledTex: Preparation = async (dataRoot, options) => {
  const archivePath = await findBundledTexArchive(options.signal)
  options.signal.throwIfAborted()
  return prepareNativeTex(dataRoot, { ...options, archivePath })
}
export class TexSetupController {
  private state: TexSetupState = { phase: process.platform === 'win32' ? 'checking' : 'required',
    message: process.platform === 'win32' ? CHECKING : '此平台尚未启用本地编译；仍可新建、打开、编辑和保存论文。',
    completed: 0, total: 0, supported: process.platform === 'win32', compileVerified: false }
  private task: Promise<TexSetupState> | null = null
  private detection: Promise<RuntimeDetection> | null = null
  private abort: AbortController | null = null
  private detectionAbort: AbortController | null = null
  private closing = false
  /** `runtimes` is the same trust check the compiler uses, so "prepared" here means the compile gate accepts it. */
  constructor(private readonly window: BrowserWindow, private readonly url: string, private readonly dataRoot: string,
    private readonly runtimes: RuntimeSource = trustedRuntimes, private readonly preparation: Preparation = prepareBundledTex) {}

  /** Main-only startup: local bundled files only; never asks users to choose or download a runtime. */
  initialize(): Promise<TexSetupState> {
    if (this.closing || this.window.isDestroyed()) return Promise.resolve({ ...this.state })
    return this.prepare()
  }

  register(): void {
    this.handle(C.status, () => this.status())
    this.handle(C.prepare, () => this.prepare())
    this.handle(C.cancel, () => this.cancelAndWait())
  }
  private trusted(event: IpcMainInvokeEvent): boolean {
    return !this.window.isDestroyed() && isTrustedSettingsSender(event.sender.id, this.window.webContents.id,
      event.senderFrame === this.window.webContents.mainFrame, event.senderFrame?.url ?? '', this.url)
  }
  private handle(channel: string, operation: () => Promise<TexSetupState>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.trusted(event) || args.length) throw new Error('此页面不能管理本地编译环境。')
      if (this.closing && channel !== C.cancel) throw new Error('正在安全关闭，请稍候。')
      return operation()
    })
  }
  private update(change: Partial<TexSetupState>): TexSetupState {
    const next = { ...this.state, ...change }
    this.state = { ...next, compileVerified: next.phase === 'prepared' && next.supported }
    if (!this.window.isDestroyed()) this.window.webContents.send(C.state, { ...this.state })
    return { ...this.state }
  }
  status(): Promise<TexSetupState> {
    if (this.task) return Promise.resolve({ ...this.state })
    if (!this.detection) {
      const abort = new AbortController()
      this.detectionAbort = abort
      this.detection = this.detect(abort.signal).finally(() => { this.detection = null; this.detectionAbort = null })
    }
    return this.detection.then(result => result.state)
  }
  private async detect(signal: AbortSignal): Promise<RuntimeDetection> {
    if (!this.state.supported) return { state: this.update({ phase: 'required',
      message: '此平台尚未启用本地编译；仍可新建、打开、编辑和保存论文。' }), runtime: null, checked: false }
    const wasPrepared = this.state.phase === 'prepared'
    this.update({ phase: 'checking', message: CHECKING, completed: 0, total: 0 })
    try {
      const runtime = await this.runtimes.get(this.dataRoot, signal)
      signal.throwIfAborted()
      if (!this.task) {
        if (runtime) this.update({ phase: 'prepared', message: PREPARED, completed: 1, total: 1 })
        else this.update({ phase: wasPrepared ? 'error' : 'required', completed: 0, total: 0,
          message: wasPrepared ? '编译组件需要修复，请重试。' : '编译组件尚未配置。' })
      }
      return { state: { ...this.state }, runtime, checked: true }
    } catch {
      if (!signal.aborted) this.update({ phase: 'error', message: '编译组件检查失败，请重试。' })
      else if (!this.task) this.update({ phase: 'required', message: '编译组件检查已暂停。', completed: 0, total: 0 })
      return { state: { ...this.state }, runtime: null, checked: false }
    }
  }
  prepare(): Promise<TexSetupState> {
    if (this.closing) return Promise.reject(new Error('正在安全关闭，请稍候。'))
    if (this.task) return this.task
    if (!this.state.supported) return this.status()
    const abort = new AbortController()
    this.abort = abort
    this.task = this.begin(abort).finally(() => { this.abort = null; this.task = null })
    return this.task
  }
  private async begin(abort: AbortController): Promise<TexSetupState> {
    try {
      const detection = this.detection
      let runtime: PreparedTex | null
      if (detection) {
        // Only this in-flight, fully checked result is reused; a later request performs its own lookup.
        const result = await detection
        abort.signal.throwIfAborted()
        if (!result.checked) throw new Error('Runtime detection failed')
        runtime = result.runtime
      } else {
        this.update({ phase: 'checking', message: CHECKING, completed: 0, total: 0 })
        runtime = await this.runtimes.get(this.dataRoot, abort.signal)
      }
      abort.signal.throwIfAborted()
      // Reuse a fully trusted existing runtime without requiring an archive or touching the network.
      if (!runtime) {
        await this.preparation(this.dataRoot, { signal: abort.signal, onProgress: state => this.progress(state) })
        abort.signal.throwIfAborted()
        if (!await this.runtimes.get(this.dataRoot, abort.signal)) throw new Error('Runtime verification failed')
      }
      abort.signal.throwIfAborted()
      return this.update({ phase: 'prepared', message: PREPARED, completed: 1, total: 1 })
    } catch {
      return this.update({ phase: abort.signal.aborted ? 'required' : 'error', completed: 0, total: 0,
        message: abort.signal.aborted ? '编译组件配置已暂停。' : '编译组件配置失败，请检查磁盘空间或修复安装后重试。' })
    }
  }
  private progress(state: TexPreparationProgress): void {
    const messages = { checking: '正在检查编译组件…', downloading: '正在读取编译组件…',
      extracting: '正在配置编译组件…', verifying: '正在验证编译组件…', prepared: '正在验证编译组件…' }
    this.update({ phase: state.phase === 'prepared' ? 'verifying' : state.phase,
      message: messages[state.phase], completed: state.completed, total: state.total })
  }
  blockNewActions(): void { this.closing = true }
  resumeActions(): void { this.closing = false }
  async cancelAndWait(): Promise<TexSetupState> {
    this.abort?.abort()
    this.detectionAbort?.abort()
    if (this.task) await this.task
    if (this.detection) await this.detection
    return { ...this.state }
  }
}
