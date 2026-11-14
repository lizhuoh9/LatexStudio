import { expect, it, vi } from 'vitest'
import { githubHttp, verifyGitHub } from '../src/main/github/transport'
import { checkedLogin, checkedToken, githubTarget, GitHubError, safeBranch } from '../src/main/github/remote-policy'
import { readVerificationLifecycleFailure } from '../src/main/github/verification-lifecycle'

const target = githubTarget('https://github.com/team/paper')
const token = 'ghp_fixturecredential'
const discovery = `${target.url}/info/refs?service=git-upload-pack`
function fixture(...responses: Response[]) {
  return vi.fn<typeof fetch>(async () => {
    const response = responses.shift()
    if (!response) throw new Error('Unexpected synthetic fetch')
    return response
  })
}
async function* requestBody(...chunks: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  for (const chunk of chunks) yield chunk
}
const json = (value: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', ...headers } })

// Private lifecycle failures expose only authentic local flags and fixed safe text.
async function expectVerificationFailure(promise: Promise<unknown>): Promise<void> {
  let failure: unknown
  try { await promise } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(GitHubError)
  expect(readVerificationLifecycleFailure(failure)).toEqual({ operationFailed: true, cleanupFailed: false })
  expect(failure).toHaveProperty('message', 'GitHub 验证未完成；未显示敏感错误信息。')
  expect(failure).not.toHaveProperty('cause')
  expect(String(failure)).not.toContain(token)
}

it('verifies identity/default branch with fixed API headers and one bounded client', async () => {
  const fetcher = fixture(json({ login: 'Alice-2', id: 42, email: 'not-collected@example.com' }), json({ default_branch: 'papers/default_v2.1' }))
  expect(await verifyGitHub(target, token, { fetcher })).toEqual({ login: 'Alice-2', id: 42, branch: 'papers/default_v2.1' })
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://api.github.com/user', 'https://api.github.com/repos/team/paper'])
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store', method: 'GET' })
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`)
    expect(new Headers(init?.headers).get('user-agent')).toBe('LatexStudio')
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe('2022-11-28')
  }
})

it.each(['https://evil.example/team/paper.git/info/refs?service=git-upload-pack',
  'https://github.com.evil/team/paper.git/info/refs?service=git-upload-pack',
  'http://github.com/team/paper.git/info/refs?service=git-upload-pack',
  'https://api.github.com/team/paper.git/info/refs?service=git-upload-pack',
  'https://user:secret@github.com/team/paper.git/info/refs?service=git-upload-pack',
  'https://github.com:443/team/paper.git/info/refs?service=git-upload-pack',
  'https://github.com/other/paper.git/info/refs?service=git-upload-pack',
  `${target.url}/info/refs`, `${discovery}&token=secret`, `${discovery}#`, `${target.url}/info/refs?%73ervice=git-upload-pack`,
  `https://github.com/team/other/../paper.git/info/refs?service=git-upload-pack`])('rejects unsafe Git URL pre-network: %s', async (url) => {
  const fetcher = fixture()
  const client = githubHttp(target, token, { fetcher })
  try { await expect(client.request({ url })).rejects.toThrow() } finally { await client.close() }
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([{ url: discovery, method: 'POST' }, { url: `${target.url}/git-upload-pack`, method: 'GET' },
  { url: `${target.url}/git-receive-pack?service=git-receive-pack`, method: 'POST' },
  { url: discovery, body: requestBody(new Uint8Array([1])) }])('enforces the actual smart-Git method/query contract', async (request) => {
  const fetcher = fixture()
  const client = githubHttp(target, token, { fetcher })
  try { await expect(client.request(request)).rejects.toThrow('Git 协议') } finally { await client.close() }
  expect(fetcher).not.toHaveBeenCalled()
})

it('retains only allowed ASCII headers and its own Basic authorization', async () => {
  const fetcher = fixture(new Response('git', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'set-cookie': 'secret' } }))
  const client = githubHttp(target, token, { fetcher })
  try {
    const response = await client.request({ url: discovery, headers: { authorization: 'Bearer injected', cookie: 'secret', host: 'evil.example',
      'content-length': '9999', accept: '*/*', 'Git-Protocol': 'version=2' } })
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get('authorization')).toBe(`Basic ${btoa(`x-access-token:${token}`)}`)
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('host')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('git-protocol')).toBe('version=2')
    expect(headers.get('user-agent')).toBe('LatexStudio')
    expect(response.headers?.['set-cookie']).toBeUndefined()
  } finally { await client.close() }
})

it.each([`${target.url}/info/refs?service=git-receive-pack`, `${target.url}/git-receive-pack`])('readOnly blocks both receive routes before upload/network', async (url) => {
  const fetcher = fixture()
  const client = githubHttp(target, token, { fetcher, readOnly: true })
  try { await expect(client.request({ url, method: url.endsWith('/git-receive-pack') ? 'POST' : 'GET' })).rejects.toThrow('只读') }
  finally { await client.close() }
  expect(fetcher).not.toHaveBeenCalled()
})

it('accepts upload-pack POST with a bounded binary body in readOnly mode', async () => {
  const fetcher = fixture(new Response('pack'))
  const client = githubHttp(target, token, { fetcher, readOnly: true })
  try {
    await client.request({ url: `${target.url}/git-upload-pack`, method: 'POST', body: requestBody(new Uint8Array([1, 2])) })
    const body = fetcher.mock.calls[0]?.[1]?.body
    expect(body).toBeInstanceOf(ArrayBuffer)
    expect(Array.from(new Uint8Array(body as ArrayBuffer))).toEqual([1, 2])
  } finally { await client.close() }
})

it.each([301, 302, 307, 308])('cancels every redirect body without following it (%s)', async (status) => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const fetcher = fixture(new Response(body, { status, headers: { location: discovery } }))
  const client = githubHttp(target, token, { fetcher })
  try { await expect(client.request({ url: discovery })).rejects.toThrow('重定向') } finally { await client.close() }
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['', 'secret\r\nAuthorization: other', 'with space', '\tsecret', '秘密', '\u007f', 'x'.repeat(4097)])('invalid credential is rejected before any request', async (value) => {
  const fetcher = fixture()
  expect(() => githubHttp(target, value, { fetcher })).toThrow('有效 GitHub 凭据')
  await expect(verifyGitHub(target, value, { fetcher })).rejects.toThrow('有效 GitHub 凭据')
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['ghp_abc123', 'github_pat_aA09', 'printable!#$%&()*+,-./:;<=>?@[]^_`{|}~'])('accepts literal printable ASCII credential %s', (value) => {
  expect(checkedToken(value)).toBe(value)
})

it.each(['alice', 'A1-b2', 'a'.repeat(39)])('accepts ASCII account name %s', (value) => { expect(checkedLogin(value)).toBe(true) })
it.each(['-alice', 'alice-', 'alice--two', 'álïce', 'alice\n', 'a'.repeat(40)])('rejects unsafe account name %s', (value) => { expect(checkedLogin(value)).toBe(false) })
it.each(['main', 'papers/default_v2.1', 'feature/fix-123'])('accepts ASCII history name %s', (value) => { expect(safeBranch(value)).toBe(value) })
it.each(['HEAD', '../main', 'a..b', '-main', 'a.lock', 'a.LOCK', 'a//b', 'a\\b', 'a b', 'a\nb', 'a[1]', 'a?b', '@', 'con', '中文'])('rejects unsafe history name %s', (value) => {
  expect(() => safeBranch(value)).toThrow()
})

it('rejects mismatched structured targets before credentials can be sent', async () => {
  const fetcher = fixture()
  const forged = { ...target, owner: 'another-account' }
  expect(() => githubHttp(forged, token, { fetcher })).toThrow('不一致')
  await expect(verifyGitHub(forged, token, { fetcher })).rejects.toThrow('不一致')
  expect(fetcher).not.toHaveBeenCalled()
})

it('does not expose injected errors/URLs or remote identity fields', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error(`Authorization: ${token} https://user:password@github.com`) })
  await expect(verifyGitHub(target, token, { fetcher })).rejects.toThrow('未显示敏感')
  const invalidIdentity = fixture(json({ login: 'alice', id: -1, email: token }), json({ default_branch: 'main' }))
  await expectVerificationFailure(verifyGitHub(target, token, { fetcher: invalidIdentity }))
  expect(invalidIdentity).toHaveBeenCalledTimes(1)
})

it('accepts real numeric Content-Length and caps API JSON independently at 1MiB', async () => {
  const value = { login: 'alice', id: 1 }
  const body = JSON.stringify(value)
  const fetcher = fixture(json(value, { 'content-length': String(new TextEncoder().encode(body).byteLength) }), json({ default_branch: 'main' }))
  expect((await verifyGitHub(target, token, { fetcher })).login).toBe('alice')
  const cancel = vi.fn()
  // A finite valid payload isolates the declared 1MiB API cap from JSON/media/body errors.
  const large = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() }, cancel,
  })
  const oversized = fixture(new Response(large, { headers: { 'content-length': '1048577', 'content-type': 'application/json' } }), json({ default_branch: 'main' }))
  await expectVerificationFailure(verifyGitHub(target, token, { fetcher: oversized }))
  expect(oversized).toHaveBeenCalledTimes(1)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it.each(['text/html', 'text/plain', 'application/octet-stream', 'application/problem+json', ''])('refuses unsupported or absent identity media type: %s', async (mediaType) => {
  const fetcher = fixture(new Response(JSON.stringify({ login: 'alice', id: 1 }), { headers: { 'content-type': mediaType } }))
  await expectVerificationFailure(verifyGitHub(target, token, { fetcher }))
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('really missing media type is rejected, even for syntactically valid JSON', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ login: 'alice', id: 1 }))
  const fetcher = fixture(new Response(bytes), json({ default_branch: 'main' }))
  await expectVerificationFailure(verifyGitHub(target, token, { fetcher }))
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['application/json; charset=utf-8', 'application/vnd.github+json', 'application/vnd.github.v3+json'])('accepts only known GitHub JSON media types: %s', async (mediaType) => {
  const fetcher = fixture(json({ login: 'alice', id: 1 }, { 'content-type': mediaType }), json({ default_branch: 'main' }))
  expect((await verifyGitHub(target, token, { fetcher })).login).toBe('alice')
})

it('mutating constructor options cannot grant write capability to a readOnly client', async () => {
  const fetcher = fixture()
  const options = { fetcher, readOnly: true }
  const client = githubHttp(target, token, options)
  options.readOnly = false
  try { await expect(client.request({ url: `${target.url}/git-receive-pack`, method: 'POST' })).rejects.toThrow('只读') }
  finally { await client.close() }
  expect(fetcher).not.toHaveBeenCalled()
})

it('honors HttpClient request.signal pre-abort without closing a reusable client', async () => {
  const controller = new AbortController()
  controller.abort()
  const fetcher = fixture(new Response('next'))
  const client = githubHttp(target, token, { fetcher, limits: { requests: 1 } })
  try {
    await expect(client.request({ url: discovery, signal: controller.signal })).rejects.toThrow('取消')
    expect(fetcher).not.toHaveBeenCalled()
    await client.request({ url: discovery })
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await client.close() }
})

it('request.signal abort during upload returns the source and permits a later request', async () => {
  const controller = new AbortController()
  const returned = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }))
  const source: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() { return this },
    next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
    return: returned,
  }
  const fetcher = fixture(new Response('next'))
  const client = githubHttp(target, token, { fetcher })
  const pending = client.request({ url: `${target.url}/git-upload-pack`, method: 'POST', body: source, signal: controller.signal }).catch((error: Error) => error)
  controller.abort()
  expect(await pending).toMatchObject({ message: expect.stringContaining('取消') })
  try {
    expect(returned).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    await client.request({ url: discovery })
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally { await client.close() }
})

it('request.signal abort owns the ready reader but does not close the entire client', async () => {
  const controller = new AbortController()
  const cancel = vi.fn()
  const fetcher = fixture(new Response(new ReadableStream({ cancel })), new Response('next'))
  const client = githubHttp(target, token, { fetcher })
  try {
    const response = await client.request({ url: discovery, signal: controller.signal })
    const iterator = (response.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const pending = iterator.next().catch((error: Error) => error)
    controller.abort()
    expect(await pending).toMatchObject({ message: expect.stringContaining('取消') })
    expect(cancel).toHaveBeenCalledTimes(1)
    await client.request({ url: discovery })
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally { await client.close() }
})

it('a single request limit also bounds the two identity API calls cumulatively', async () => {
  const fetcher = fixture(json({ login: 'alice', id: 1 }), json({ default_branch: 'main' }))
  await expectVerificationFailure(verifyGitHub(target, token, { fetcher, limits: { requests: 1 } }))
  expect(fetcher).toHaveBeenCalledTimes(1)
})
