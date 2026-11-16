import { GitHubError, type GitRequest } from './remote-policy'
import { rememberOperationDiagnostic, type OperationDiagnostic } from './operation-diagnostic'

export interface TransferLimits {
  clientMs: number
  requestMs: number
  requests: number
  uploadBytes: number
  downloadBytes: number
}
export interface TransferOptions {
  fetcher?: typeof fetch
  signal?: AbortSignal
  readOnly?: boolean
  limits?: Partial<TransferLimits>
}
export const GITHUB_TRANSFER_LIMITS: Readonly<TransferLimits> = Object.freeze({
  clientMs: 120_000, requestMs: 30_000, requests: 32,
  uploadBytes: 128 * 1024 * 1024, downloadBytes: 128 * 1024 * 1024,
})
export interface TransferBody extends AsyncIterableIterator<Uint8Array> {
  return(): Promise<IteratorResult<Uint8Array>>
  throw(error?: unknown): Promise<IteratorResult<Uint8Array>>
}
export interface TransferResponse {
  statusCode: number
  headers: Record<string, string>
  body: TransferBody
}
const cleanupGraceMs = 100
function transferFailure(message: string, code: OperationDiagnostic): GitHubError {
  const error = new GitHubError(message)
  rememberOperationDiagnostic(error, code)
  return error
}
const networkFailure = () => transferFailure('GitHub 网络传输失败；未显示敏感请求信息。', 'git-network')
const cancelled = () => new GitHubError('GitHub 网络传输已取消。')

function limitsFor(input: Partial<TransferLimits> = {}): TransferLimits {
  const limits = { ...GITHUB_TRANSFER_LIMITS }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new GitHubError('GitHub 传输限额无效。')
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(GITHUB_TRANSFER_LIMITS, key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
      value > GITHUB_TRANSFER_LIMITS[key as keyof TransferLimits]) throw new GitHubError('GitHub 传输限额必须为不超过安全上限的正整数。')
    limits[key as keyof TransferLimits] = value
  }
  return limits
}

class Operation {
  readonly controller = new AbortController()
  readonly deadline: number
  readonly timer: ReturnType<typeof setTimeout>
  reader?: ReadableStreamDefaultReader<Uint8Array>
  fallbackBody?: ReadableStream<Uint8Array>
  source?: AsyncIterator<Uint8Array> | Iterator<Uint8Array>
  sourcePending = false
  clearParts?: () => void
  failure: GitHubError | null = null
  ended = false
  chunks = 0
  private cleanup: Promise<void> | null = null

  private readonly abortRequest = () => { void this.stop(cancelled()).catch(() => {}) }

  constructor(budget: number, private readonly release: (error?: GitHubError) => void, private readonly requestSignal?: AbortSignal) {
    this.deadline = performance.now() + budget
    const reserve = Math.min(cleanupGraceMs, Math.max(1, Math.floor(budget / 4)))
    this.timer = setTimeout(() => { void this.stop(new GitHubError('GitHub 传输超过总时限。')).catch(() => {}) }, Math.max(0, budget - reserve))
    requestSignal?.addEventListener('abort', this.abortRequest, { once: true })
    if (requestSignal?.aborted) this.abortRequest()
  }

  check(): void {
    if (performance.now() >= this.deadline && !this.failure) this.failure = new GitHubError('GitHub 传输超过总时限。')
    if (this.ended || this.failure) throw this.failure ?? cancelled()
  }

  wait<T>(pending: PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = this.controller.signal
      const abort = () => { signal.removeEventListener('abort', abort); reject(this.failure ?? cancelled()) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      Promise.resolve(pending).then((value) => {
        signal.removeEventListener('abort', abort)
        try { this.check(); resolve(value) } catch { reject(this.failure ?? cancelled()) }
      }, () => { signal.removeEventListener('abort', abort); reject(this.failure ?? networkFailure()) })
    })
  }

  complete(): void {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.timer)
    this.requestSignal?.removeEventListener('abort', this.abortRequest)
    this.reader?.releaseLock()
    this.reader = undefined
    this.fallbackBody = undefined
    this.source = undefined
    this.clearParts?.()
    this.release()
  }

  stop(reason?: GitHubError): Promise<void> {
    if (this.cleanup) return this.cleanup
    if (this.ended) return Promise.resolve()
    let resolveCleanup!: () => void
    let rejectCleanup!: (error: GitHubError) => void
    this.cleanup = new Promise<void>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject })
    this.ended = true
    this.failure = reason ?? null
    clearTimeout(this.timer)
    this.requestSignal?.removeEventListener('abort', this.abortRequest)
    this.clearParts?.()
    const source = this.source
    const reader = this.reader
    // Native fetch errors its response stream synchronously on abort. Start owned reader cancellation
    // first, or a cooperative return() becomes a false cleanup failure that permanently blocks sync.
    const tasks = this.cleanupTasks(source, reader)
    this.controller.abort()
    const message = source ? '上传源未确认收束；网络请求已中止。' : '响应流未确认收束；网络请求已中止。'
    const grace = Math.max(0, Math.min(cleanupGraceMs, this.deadline - performance.now()))
    void this.settleCleanup(tasks, grace, message).then(() => {
      try { reader?.releaseLock(); this.source = undefined; this.reader = undefined; this.fallbackBody = undefined; this.release(); resolveCleanup() }
      catch { const error = new GitHubError(message); this.failure = error; this.release(error); rejectCleanup(error) }
    }, (error: GitHubError) => {
      this.failure = error
      this.source = undefined
      this.reader = undefined
      this.fallbackBody = undefined
      this.release(error)
      rejectCleanup(error)
    })
    return this.cleanup
  }

  private cleanupTasks(source: Operation['source'], reader: Operation['reader']): Promise<unknown>[] {
    const tasks: Promise<unknown>[] = []
    if (reader) { try { tasks.push(Promise.resolve(reader.cancel('PaperStudio transfer stopped'))) } catch { tasks.push(Promise.reject(networkFailure())) } }
    else if (this.fallbackBody) {
      try { tasks.push(Promise.resolve(this.fallbackBody.cancel('PaperStudio response ownership failed'))) }
      catch { tasks.push(Promise.reject(networkFailure())) }
    }
    if (source) {
      try {
        if (typeof source.return === 'function') tasks.push(Promise.resolve(source.return()).then((result) => {
          if (!result || result.done !== true) throw networkFailure()
        }))
        else if (this.sourcePending) tasks.push(Promise.reject(networkFailure()))
      }
      catch { tasks.push(Promise.reject(networkFailure())) }
    }
    return tasks
  }

  private settleCleanup(tasks: Promise<unknown>[], ms: number, message: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new GitHubError(message)), ms)
      void Promise.all(tasks).then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); reject(new GitHubError(message)) })
    })
  }
}

/** One active response per client. Limits include body consumption, not just response headers.
 * Staged upload payload is <=2 * uploadBytes (default <=256MiB), plus <=65,536 chunk objects;
 * this excludes object overhead, caller/fetch/network memory and Git pack expansion.
 * A JS iterator that ignores return() cannot be forcibly killed: cleanup fails explicitly within <=100ms.
 * close() confirms owned resources only; an injected fetcher ignoring abort can produce an unknown future
 * response. Such a late response is cancelled when received, with cleanup failure retained for close().
 */
export class GitHubTransfer {
  private readonly limits: TransferLimits
  private readonly fetcher: typeof fetch
  private readonly deadline: number
  private readonly signal?: AbortSignal
  private active: Operation | null = null
  private closed = false
  private cleanupFailure: GitHubError | null = null
  private requests = 0
  private uploaded = 0
  private downloaded = 0
  private readonly lateCleanups = new Set<Promise<void>>()
  private readonly abort = () => { void this.close().catch(() => {}) }

  constructor(options: TransferOptions = {}) {
    this.limits = limitsFor(options.limits)
    if (options.fetcher !== undefined && typeof options.fetcher !== 'function' ||
      options.readOnly !== undefined && typeof options.readOnly !== 'boolean') throw new GitHubError('GitHub 传输选项无效。')
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init))
    this.deadline = performance.now() + this.limits.clientMs
    this.signal = options.signal
    this.signal?.addEventListener('abort', this.abort, { once: true })
    if (this.signal?.aborted) { this.closed = true; this.signal.removeEventListener('abort', this.abort) }
  }

  async open(url: string, init: RequestInit, upload?: GitRequest['body']): Promise<TransferResponse> {
    const operation = this.begin(init.signal ?? undefined)
    try {
      const body = await this.bufferUpload(operation, upload)
      operation.check()
      const pending = this.fetcher(url, { ...init, body, signal: operation.controller.signal,
        redirect: 'manual', credentials: 'omit', cache: 'no-store' }).then((response) => this.adopt(operation, response))
      const response = await operation.wait(pending)
      operation.check()
      this.checkResponse(operation, response)
      const headers = this.responseHeaders(response)
      if (!operation.reader) operation.complete()
      return { statusCode: response.status, headers, body: this.ownedBody(operation) }
    } catch {
      const error = operation.failure ?? networkFailure()
      await operation.stop(error)
      throw operation.failure ?? error
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.signal?.removeEventListener('abort', this.abort)
    if (this.active) await this.active.stop(cancelled())
    await Promise.all(this.lateCleanups)
    if (this.cleanupFailure) throw this.cleanupFailure
  }

  private cancelLate(response: Response): void {
    if (!response.body) return
    const failure = () => { this.cleanupFailure = new GitHubError('迟到响应流未确认收束；网络请求已中止。'); this.closed = true }
    const cleanup = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { failure(); resolve() }, cleanupGraceMs)
      try {
        void response.body!.cancel('PaperStudio late response').then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); failure(); resolve() })
      } catch { clearTimeout(timer); failure(); resolve() }
    })
    this.lateCleanups.add(cleanup)
    void cleanup.then(() => this.lateCleanups.delete(cleanup))
  }

  private adopt(operation: Operation, response: Response): Response {
    if (operation.ended) { this.cancelLate(response); throw operation.failure ?? cancelled() }
    const body = response.body
    if (operation.ended) { this.cancelLate(response); throw operation.failure ?? cancelled() }
    operation.fallbackBody = body ?? undefined
    const reader = body?.getReader()
    if (operation.ended) { reader?.releaseLock(); this.cancelLate(response); throw operation.failure ?? cancelled() }
    operation.reader = reader
    operation.fallbackBody = undefined
    operation.check()
    return response
  }

  private begin(signal?: AbortSignal): Operation {
    if (this.cleanupFailure) throw this.cleanupFailure
    if (this.closed || this.signal?.aborted || signal?.aborted) throw cancelled()
    if (this.active) throw new GitHubError('当前 GitHub 响应尚未消费或取消，不能并发请求。')
    const budget = Math.min(this.limits.requestMs, this.deadline - performance.now())
    if (budget <= 0) throw new GitHubError('GitHub client 超过总时限。')
    if (++this.requests > this.limits.requests) throw new GitHubError('GitHub 累计请求次数超过安全限制。')
    const operation = new Operation(budget, (error) => {
      if (error) { this.cleanupFailure = error; this.closed = true }
      if (this.active === operation) this.active = null
    }, signal)
    this.active = operation
    return operation
  }

  private async bufferUpload(operation: Operation, body: GitRequest['body']): Promise<ArrayBuffer | undefined> {
    if (body === undefined) return undefined
    const parts: Uint8Array[] = []
    let bytes = 0
    operation.clearParts = () => { parts.length = 0 }
    try {
      operation.check()
      operation.source = Symbol.asyncIterator in body ? body[Symbol.asyncIterator]() : body[Symbol.iterator]()
      while (true) {
        operation.check()
        operation.sourcePending = true
        const pending = Promise.resolve(operation.source.next())
        void pending.then(() => { operation.sourcePending = false }, () => { operation.sourcePending = false })
        const next = await operation.wait(pending)
        if (next.done) { operation.source = undefined; break }
        this.charge(operation, next.value, 'upload')
        bytes += next.value.byteLength
        parts.push(new Uint8Array(next.value))
      }
      operation.check()
      const result = new Uint8Array(bytes)
      let offset = 0
      for (const part of parts) { operation.check(); result.set(part, offset); offset += part.byteLength }
      return result.buffer
    } finally { parts.length = 0 }
  }

  private charge(operation: Operation, chunk: Uint8Array, direction: 'upload' | 'download'): void {
    operation.check()
    if (!(chunk instanceof Uint8Array) || ++operation.chunks > 65_536) {
      operation.failure = new GitHubError('GitHub 数据块无效或过多。')
      throw operation.failure
    }
    const total = direction === 'upload' ? this.uploaded + chunk.byteLength : this.downloaded + chunk.byteLength
    const limit = direction === 'upload' ? this.limits.uploadBytes : this.limits.downloadBytes
    if (direction === 'upload') this.uploaded = total
    else this.downloaded = total
    if (!Number.isSafeInteger(total) || total > limit) {
      this.closed = true
      operation.failure = new GitHubError('GitHub 累计传输数据超过安全大小限制。')
      throw operation.failure
    }
  }

  private checkResponse(operation: Operation, response: Response): void {
    let error: GitHubError | null = null
    if (response.status < 200 || response.status >= 300 || response.redirected || response.type === 'opaqueredirect') {
      error = new GitHubError(response.status >= 300 && response.status < 400 || response.redirected || response.type === 'opaqueredirect' ?
        '已阻止 GitHub 请求重定向，请确认仓库地址。' : 'GitHub 请求未成功，请检查凭据权限、仓库地址或网络。')
    }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > this.limits.downloadBytes - this.downloaded)) {
      error = new GitHubError('GitHub 响应长度无效或超过安全大小限制。')
    }
    if (error) {
      rememberOperationDiagnostic(error, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'git-response')
      operation.failure = error; throw error
    }
  }

  private responseHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'content-length']) {
      const value = response.headers.get(name)
      if (value !== null && value.length <= 1024 && !/[^\x20-\x7e]/.test(value)) headers[name] = value
    }
    return headers
  }

  private ownedBody(operation: Operation): TransferBody {
    let reading = false
    return {
      [Symbol.asyncIterator]() { return this },
      next: async () => {
        if (reading) throw new GitHubError('不能并发读取 GitHub 响应。')
        reading = true
        try { return await this.read(operation) } finally { reading = false }
      },
      return: async () => { await operation.stop(); return { done: true, value: undefined } },
      throw: async () => { const error = networkFailure(); await operation.stop(error); throw operation.failure ?? error },
    }
  }

  private async read(operation: Operation): Promise<IteratorResult<Uint8Array>> {
    if (operation.ended) {
      if (operation.failure) throw operation.failure
      return { done: true, value: undefined }
    }
    try {
      operation.check()
      const chunk = await operation.wait(operation.reader!.read())
      if (chunk.done) { operation.complete(); return { done: true, value: undefined } }
      this.charge(operation, chunk.value, 'download')
      return { done: false, value: chunk.value }
    } catch {
      const error = operation.failure ?? networkFailure()
      await operation.stop(error)
      throw operation.failure ?? error
    }
  }
}
