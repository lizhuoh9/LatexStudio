import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GITHUB_TRANSFER_LIMITS, GitHubTransfer, type TransferLimits } from '../src/main/github/transfer'

const url = 'https://github.com/team/paper.git/git-upload-pack'
const init = { method: 'POST' }
const never = <T>() => new Promise<T>(() => {})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const done = (): IteratorResult<Uint8Array> => ({ done: true, value: undefined })
function upload(next: () => Promise<IteratorResult<Uint8Array>>, close: () => Promise<IteratorResult<Uint8Array>>) {
  const iterator = { next: vi.fn(next), return: vi.fn(close) }
  return { iterator, body: { [Symbol.asyncIterator]: () => iterator } }
}
async function consume(body: AsyncIterable<Uint8Array>): Promise<number[]> {
  const bytes: number[] = []
  for await (const chunk of body) bytes.push(...chunk)
  return bytes
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(() => { vi.useRealTimers() })

it('exports immutable production ceilings without allocating large fixtures', () => {
  expect(GITHUB_TRANSFER_LIMITS).toEqual({ clientMs: 120000, requestMs: 30000, requests: 32, uploadBytes: 134217728, downloadBytes: 134217728 })
  expect(Object.isFrozen(GITHUB_TRANSFER_LIMITS)).toBe(true)
})

it.each([NaN, Infinity, -1, 0, 0.5, 30001])('rejects unsafe or loosened request limits: %s', (requestMs) => {
  expect(() => new GitHubTransfer({ limits: { requestMs } })).toThrow('限额')
})
it.each(['clientMs', 'requests', 'uploadBytes', 'downloadBytes'] as const)('cannot loosen any cumulative ceiling: %s', (key) => {
  expect(() => new GitHubTransfer({ limits: { [key]: GITHUB_TRANSFER_LIMITS[key] + 1 } })).toThrow('限额')
})
it('rejects unknown limit keys instead of silently ignoring them', () => {
  expect(() => new GitHubTransfer({ limits: { requestMs: 1, cleanupMs: 999999 } as Partial<TransferLimits> })).toThrow('限额')
})

it('blocks a second active request and releases an unread body on return before first next', async () => {
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel }))).mockResolvedValueOnce(new Response('next'))
  const client = new GitHubTransfer({ fetcher })
  try {
    const first = await client.open(url, init)
    await expect(client.open(url, init)).rejects.toThrow('不能并发')
    await first.body.return()
    expect(cancel).toHaveBeenCalledTimes(1)
    const second = await client.open(url, init)
    expect(await consume(second.body)).toEqual(Array.from(new TextEncoder().encode('next')))
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally { await client.close() }
})

it('close cancels a ready response even when nobody has obtained its iterator', async () => {
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })))
  const client = new GitHubTransfer({ fetcher })
  const response = await client.open(url, init)
  await client.close()
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  await expect(response.body.next()).rejects.toThrow('取消')
})

it('copies each yielded byte sequence even if the producer reuses its buffer', async () => {
  function* source() {
    const chunk = new Uint8Array(1)
    chunk[0] = 1; yield chunk
    chunk[0] = 2; yield chunk
    chunk[0] = 3
  }
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'))
  const client = new GitHubTransfer({ fetcher, limits: { uploadBytes: 2 } })
  try {
    await client.open(url, init, source())
    const body = fetcher.mock.calls[0]?.[1]?.body
    expect(body).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(body as ArrayBuffer))).toEqual([1, 2])
  } finally { await client.close() }
})

it('cumulative upload bytes cannot reset between individual requests', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'))
  const client = new GitHubTransfer({ fetcher, limits: { uploadBytes: 3 } })
  try {
    const first = await client.open(url, init, [new Uint8Array([1, 2])])
    await first.body.return()
    await expect(client.open(url, init, [new Uint8Array([3, 4])])).rejects.toThrow('累计传输')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await client.close() }
})

it('cumulative download bytes cannot reset between responses and oversize reader is cancelled', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([3, 4])) }, cancel })
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([1, 2]))).mockResolvedValueOnce(new Response(stream))
  const client = new GitHubTransfer({ fetcher, limits: { downloadBytes: 3 } })
  try {
    const first = await client.open(url, init)
    expect(await consume(first.body)).toEqual([1, 2])
    const second = await client.open(url, init)
    await expect(second.body.next()).rejects.toThrow('累计传输')
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally { await client.close() }
})

it('bounds request count across completed and cancelled responses', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'))
  const client = new GitHubTransfer({ fetcher, limits: { requests: 1 } })
  try {
    const first = await client.open(url, init)
    await first.body.return()
    await expect(client.open(url, init)).rejects.toThrow('累计请求')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await client.close() }
})

it('request deadline covers a stalled body, cancels the reader and aborts fetch', async () => {
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })))
  const client = new GitHubTransfer({ fetcher, limits: { requestMs: 40 } })
  try {
    const response = await client.open(url, init)
    const result = response.body.next().catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(45)
    expect(await result).toMatchObject({ message: expect.stringContaining('时限') })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  } finally { await client.close() }
})

it('the deadline also cancels a response that is never consumed', async () => {
  const cancel = vi.fn()
  const client = new GitHubTransfer({ fetcher: async () => new Response(new ReadableStream({ cancel })), limits: { requestMs: 40 } })
  try {
    const response = await client.open(url, init)
    await vi.advanceTimersByTimeAsync(45)
    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(response.body.next()).rejects.toThrow('时限')
  } finally { await client.close() }
})

it('the absolute client budget survives idle gaps and successive requests', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('ok'))
  const client = new GitHubTransfer({ fetcher, limits: { clientMs: 40 } })
  try {
    await (await client.open(url, init)).body.return()
    await vi.advanceTimersByTimeAsync(41)
    await expect(client.open(url, init)).rejects.toThrow('client 超过总时限')
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await client.close() }
})

it('parent abort cancels an in-flight body and close resolves after genuine cleanup', async () => {
  const controller = new AbortController()
  const cancel = vi.fn()
  const client = new GitHubTransfer({ signal: controller.signal, fetcher: async () => new Response(new ReadableStream({ cancel })) })
  const response = await client.open(url, init)
  const pending = response.body.next().catch((error: Error) => error)
  controller.abort()
  await client.close()
  expect(await pending).toMatchObject({ message: expect.stringContaining('取消') })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('mutating options cannot replace the original abort signal or loosen its limits', async () => {
  const original = new AbortController()
  const replacement = new AbortController()
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })))
  const options = { signal: original.signal, fetcher, limits: { uploadBytes: 1 } }
  const client = new GitHubTransfer(options)
  options.signal = replacement.signal
  options.limits.uploadBytes = 100
  replacement.abort()
  const response = await client.open(url, init, [new Uint8Array([1])])
  original.abort()
  await client.close()
  expect(cancel).toHaveBeenCalledTimes(1)
  await expect(response.body.next()).rejects.toThrow('取消')
})

it('mutating an input limits object cannot increase the copied upload ceiling', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const limits = { uploadBytes: 1 }
  const client = new GitHubTransfer({ fetcher, limits })
  limits.uploadBytes = 100
  try { await expect(client.open(url, init, [new Uint8Array([1, 2])])).rejects.toThrow('累计传输') }
  finally { await client.close() }
  expect(fetcher).not.toHaveBeenCalled()
})

it('pre-aborted signal prevents even the first fetch', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetcher = vi.fn<typeof fetch>()
  const client = new GitHubTransfer({ fetcher, signal: controller.signal })
  try { await expect(client.open(url, init)).rejects.toThrow('取消') } finally { await client.close() }
  expect(fetcher).not.toHaveBeenCalled()
})

it('calls return on a pending upload and ignores its late value without buffering/fetching', async () => {
  const next = deferred<IteratorResult<Uint8Array>>()
  const source = upload(() => next.promise, async () => done())
  const controller = new AbortController()
  const fetcher = vi.fn<typeof fetch>()
  const client = new GitHubTransfer({ fetcher, signal: controller.signal })
  const pending = client.open(url, init, source.body).catch((error: Error) => error)
  controller.abort()
  await client.close()
  next.resolve({ done: false, value: new Uint8Array([99]) })
  expect(await pending).toMatchObject({ message: expect.stringContaining('取消') })
  expect(source.iterator.return).toHaveBeenCalledTimes(1)
  expect(fetcher).not.toHaveBeenCalled()
})

it('a never-settling next with a never-settling return fails request and close within the budget', async () => {
  const source = upload(() => never(), () => never())
  const fetcher = vi.fn<typeof fetch>()
  const client = new GitHubTransfer({ fetcher, limits: { requestMs: 40 } })
  const pending = client.open(url, init, source.body).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(45)
  expect(await pending).toMatchObject({ message: expect.stringContaining('上传源未确认收束') })
  await expect(client.close()).rejects.toThrow('上传源未确认收束')
  expect(source.iterator.return).toHaveBeenCalledTimes(1)
  expect(fetcher).not.toHaveBeenCalled()
})

it('return done:false is not proof that an upload source has closed', async () => {
  const source = upload(() => never(), async () => ({ done: false, value: new Uint8Array([7]) }))
  const client = new GitHubTransfer({ fetcher: vi.fn<typeof fetch>(), limits: { requestMs: 40 } })
  const pending = client.open(url, init, source.body).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(45)
  expect(await pending).toMatchObject({ message: expect.stringContaining('上传源未确认收束') })
  await expect(client.close()).rejects.toThrow('上传源未确认收束')
})

it('late return cannot resurrect an already rejected noncooperative upload', async () => {
  const returned = deferred<IteratorResult<Uint8Array>>()
  const source = upload(() => never(), () => returned.promise)
  const fetcher = vi.fn<typeof fetch>()
  const client = new GitHubTransfer({ fetcher, limits: { requestMs: 40 } })
  const pending = client.open(url, init, source.body).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(45)
  expect(await pending).toBeInstanceOf(Error)
  returned.resolve(done())
  await vi.advanceTimersByTimeAsync(0)
  await expect(client.close()).rejects.toThrow('上传源未确认收束')
  expect(fetcher).not.toHaveBeenCalled()
})

it('cancels a late synthetic fetch response rather than publishing it after abort', async () => {
  const response = deferred<Response>()
  const cancel = vi.fn()
  const controller = new AbortController()
  const fetcher = vi.fn<typeof fetch>(() => response.promise)
  const client = new GitHubTransfer({ fetcher, signal: controller.signal })
  const pending = client.open(url, init).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await client.close()
  response.resolve(new Response(new ReadableStream({ cancel })))
  await vi.advanceTimersByTimeAsync(0)
  expect(await pending).toMatchObject({ message: expect.stringContaining('取消') })
  expect(cancel).toHaveBeenCalledTimes(1)
  await client.close()
})

it('retains failed late-response cleanup for future close instead of hiding it', async () => {
  const response = deferred<Response>()
  const controller = new AbortController()
  const client = new GitHubTransfer({ signal: controller.signal, fetcher: () => response.promise })
  const pending = client.open(url, init).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await client.close()
  response.resolve(new Response(new ReadableStream({ cancel: () => never() })))
  await vi.advanceTimersByTimeAsync(101)
  expect(await pending).toBeInstanceOf(Error)
  await expect(client.close()).rejects.toThrow('迟到响应流未确认收束')
})

it('adopts the response before a queued abort can overtake the open continuation', async () => {
  const controller = new AbortController()
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ cancel }))
  const fetcher = vi.fn<typeof fetch>(() => {
    const ready = Promise.resolve(response)
    void ready.then(() => queueMicrotask(() => controller.abort()))
    return ready
  })
  const client = new GitHubTransfer({ fetcher, signal: controller.signal })
  const pending = client.open(url, init).catch((error: Error) => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(await pending).toBeInstanceOf(Error)
  await client.close()
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(response.body?.locked).toBe(false)
})

it('still owns and cancels a response body if getReader throws', async () => {
  const cancel = vi.fn()
  const stream = new ReadableStream<Uint8Array>({ cancel })
  vi.spyOn(stream, 'getReader').mockImplementation(() => { throw new Error('synthetic reader failure') })
  const client = new GitHubTransfer({ fetcher: async () => new Response(stream) })
  try { await expect(client.open(url, init)).rejects.toThrow('未显示敏感') } finally { await client.close() }
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('an externally locked response body is explicit cleanup failure, not false close success', async () => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
  const held = response.body!.getReader()
  const fetcher = vi.fn<typeof fetch>(async () => response)
  const client = new GitHubTransfer({ fetcher })
  await expect(client.open(url, init)).rejects.toThrow('响应流未确认收束')
  await expect(client.close()).rejects.toThrow('响应流未确认收束')
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  held.releaseLock()
  await response.body!.cancel()
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('request-level abort is detached after completion and cannot cancel the next request', async () => {
  const controller = new AbortController()
  const cancel = vi.fn()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('first')).mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
  const client = new GitHubTransfer({ fetcher })
  try {
    const first = await client.open(url, { ...init, signal: controller.signal })
    await consume(first.body)
    const second = await client.open(url, init)
    controller.abort()
    expect(cancel).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[1]?.[1]?.signal?.aborted).toBe(false)
    await second.body.return()
  } finally { await client.close() }
})

it('rejects invalid Content-Length and cancels without reading the response', async () => {
  const cancel = vi.fn()
  const client = new GitHubTransfer({ fetcher: async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '4x' } }) })
  try { await expect(client.open(url, init)).rejects.toThrow('长度无效') } finally { await client.close() }
  expect(cancel).toHaveBeenCalledTimes(1)
})
