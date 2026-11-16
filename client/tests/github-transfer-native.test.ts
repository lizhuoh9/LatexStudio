import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { GitHubTransfer } from '../src/main/github/transfer'

async function serving(action: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' })
    response.write('0008NAK\n')
    // A real HTTP response remains open until its reader explicitly cancels.
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`) }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

it('closes a real fetch response after an early Git packet reader return without false cleanup failure', async () => {
  await serving(async url => {
    const client = new GitHubTransfer()
    try {
      const response = await client.open(url, { method: 'GET' })
      expect((await response.body.next()).done).toBe(false)
      await expect(response.body.return()).resolves.toMatchObject({ done: true })
      await expect(client.close()).resolves.toBeUndefined()
    } finally { await client.close().catch(() => undefined) }
  })
})

it('does not mistake an abort-induced stream error for failed cleanup of a cooperative response', async () => {
  const cancel: string[] = []
  const client = new GitHubTransfer({ fetcher: async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
      controller.enqueue(new Uint8Array([1]))
    },
    cancel() { cancel.push('closed') },
  })) })
  try {
    const response = await client.open('https://github.com/fixture/private.git/info/refs', { method: 'GET' })
    await expect(response.body.return()).resolves.toMatchObject({ done: true })
    expect(cancel).toEqual(['closed'])
    await expect(client.close()).resolves.toBeUndefined()
  } finally { await client.close().catch(() => undefined) }
})
