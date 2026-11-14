import type { RepositoryTransferState } from '../../shared/workspace-contracts'
import { RepositoryOperationError } from '../github/repository-operation'

type Kind = NonNullable<RepositoryTransferState['kind']>
type Active = { abort: AbortController; done: Promise<void>; finish: () => void }

/** Tracks the real action lifetime, never races or claims remote rollback. */
export class WorkspaceRepositoryTransfer {
  private state: RepositoryTransferState = { sequence: 0, phase: 'idle', kind: null, message: '' }
  private active: Active | null = null
  private cleanupUncertain = false

  constructor(private readonly notify: (state: RepositoryTransferState) => void) {}

  status(): RepositoryTransferState { return { ...this.state } }
  isActive(): boolean { return this.active !== null }

  async run<T>(kind: Kind, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertCloseReady()
    if (this.active) throw new Error('另一项项目传输尚未结束，请等待或取消。')
    const abort = new AbortController()
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const active = { abort, done, finish }
    this.active = active
    this.publish({ sequence: this.state.sequence + 1, phase: 'running', kind,
      message: '正在处理项目传输，可请求取消；取消不保证撤回已接收的上传。' })
    try { return await action(abort.signal) }
    catch (error) {
      if (error instanceof RepositoryOperationError && error.cleanupFailed) this.cleanupUncertain = true
      throw error
    } finally {
      this.active = null
      this.publish({ ...this.state, phase: 'settled', message: this.cleanupUncertain
        ? '连接清理未确认完成，工作台将保留；请核对项目与连接状态。'
        : abort.signal.aborted ? '取消等待已结束；可能保留部分修改或已接收的上传，请核对项目状态。'
          : '项目操作等待已结束，请查看结果；此状态不代表同步成功。' })
      active.finish()
    }
  }

  async cancelAndWait(): Promise<RepositoryTransferState> {
    const active = this.active
    if (active) {
      if (!active.abort.signal.aborted) {
        this.publish({ ...this.state, phase: 'cancelling', message: '已请求取消，正在等待当前动作与已登记连接清理；不会强制关闭。' })
        active.abort.abort()
      }
      await active.done
    }
    this.assertCloseReady()
    return this.status()
  }

  assertCloseReady(): void {
    if (this.cleanupUncertain) throw new Error('连接清理尚未确认完成，已保留工作台，不会强制关闭。')
  }

  private publish(state: RepositoryTransferState): void {
    this.state = { ...state }
    try { this.notify(this.status()) }
    catch { /* Renderer delivery failure cannot replace the action/cleanup outcome. */ }
  }
}
