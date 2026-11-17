import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CloudLinkTrust } from '../src/main/workspace/cloud-link-trust'

const folders: string[] = []
async function folder(): Promise<string> {
  // Canonical fixture root avoids macOS /var -> /private/var aliases without weakening production checks.
  const root = await files.realpath(await files.mkdtemp(join(tmpdir(), 'paperstudio-links-')))
  folders.push(root); return root
}
const target = (root: string): string => join(root, 'cloud-links.json')
const binding = { projectId: 1, owner: 'alice', name: 'paper', branch: 'main', accountId: 7 }
afterEach(async () => { for (const root of folders.splice(0)) await files.rm(root, { recursive: true, force: true }) })

describe('device record of confirmed cloud links', () => {
  it('treats an unknown folder as unconfirmed without creating any data', async () => {
    const parent = await folder(), data = join(parent, 'profile')
    expect(await new CloudLinkTrust(data).has(join(parent, 'paper'), binding)).toBe(false)
    expect(await files.readdir(parent)).toEqual([])
  })

  it('keeps a confirmed link across restarts in one private strict record', async () => {
    const data = await folder(), paper = join(await folder(), 'paper')
    expect(await new CloudLinkTrust(data).remember(paper, binding)).toBe(true)
    expect(await new CloudLinkTrust(data).has(paper, binding)).toBe(true)
    const info = await files.stat(target(data))
    expect(JSON.parse(await files.readFile(target(data), 'utf8'))).toEqual({ version: 1, links: [{ root: paper, ...binding }] })
    expect(info.nlink).toBe(1)
    if (process.platform !== 'win32') expect(info.mode & 0o077).toBe(0)
    expect(await files.readdir(data)).toEqual(['cloud-links.json'])
  })

  it.each([{ projectId: 2 }, { owner: 'mallory' }, { name: 'other' }, { branch: 'dev' }, { accountId: 8 }])(
    'does not extend a confirmation to a link that differs by %j', async change => {
      const data = await folder(), paper = join(await folder(), 'paper'), store = new CloudLinkTrust(data)
      await store.remember(paper, binding)
      expect(await store.has(paper, { ...binding, ...change })).toBe(false)
      expect(await new CloudLinkTrust(data).has(paper, { ...binding, ...change })).toBe(false)
    })

  it('does not extend a confirmation to another folder that carries the same link', async () => {
    const data = await folder(), parent = await folder(), store = new CloudLinkTrust(data)
    await store.remember(join(parent, 'paper'), binding)
    expect(await store.has(join(parent, 'copy'), binding)).toBe(false)
    expect(await store.has(join(parent, 'paper', 'nested'), binding)).toBe(false)
  })

  it('replaces the earlier link of a folder instead of keeping both confirmed', async () => {
    const data = await folder(), paper = join(await folder(), 'paper'), store = new CloudLinkTrust(data)
    await store.remember(paper, binding)
    await store.remember(paper, { ...binding, projectId: 2, name: 'second' })
    const fresh = new CloudLinkTrust(data)
    expect(await fresh.has(paper, { ...binding, projectId: 2, name: 'second' })).toBe(true)
    expect(await fresh.has(paper, binding)).toBe(false)
    expect(JSON.parse(await files.readFile(target(data), 'utf8')).links).toHaveLength(1)
  })

  it.runIf(process.platform === 'win32')('matches a Windows folder regardless of path letter case', async () => {
    const data = await folder(), paper = join(await folder(), 'Paper')
    await new CloudLinkTrust(data).remember(paper, binding)
    expect(await new CloudLinkTrust(data).has(paper.toUpperCase(), binding)).toBe(true)
  })

  it('keeps the newest 200 folders and forgets the oldest', async () => {
    const data = await folder(), parent = await folder()
    const links = Array.from({ length: 200 }, (_, index) => ({ root: join(parent, `p${index}`), ...binding }))
    await files.writeFile(target(data), JSON.stringify({ version: 1, links }) + '\n', { mode: 0o600 })
    const store = new CloudLinkTrust(data)
    expect(await store.has(join(parent, 'p199'), binding)).toBe(true)
    expect(await store.remember(join(parent, 'newest'), binding)).toBe(true)
    const fresh = new CloudLinkTrust(data)
    expect(await fresh.has(join(parent, 'newest'), binding)).toBe(true)
    expect(await fresh.has(join(parent, 'p0'), binding)).toBe(true)
    expect(await fresh.has(join(parent, 'p199'), binding)).toBe(false)
    expect(JSON.parse(await files.readFile(target(data), 'utf8')).links).toHaveLength(200)
  })

  it.each([
    Buffer.from('{broken'), Buffer.from([0xff, 0xfe]), Buffer.from('{"version":2,"links":[]}'),
    Buffer.from('{"version":1,"links":[],"token":"PRIVATE"}'), Buffer.from('{"version":1,"links":[{"root":"relative","projectId":1}]}'),
    Buffer.alloc(1024 * 1024 + 1, ' ')
  ])('never trusts or rewrites an unreadable record (case %#)', async bytes => {
    const data = await folder(), paper = join(await folder(), 'paper')
    await files.writeFile(target(data), bytes, { mode: 0o600 })
    const store = new CloudLinkTrust(data)
    expect(await store.has(paper, binding)).toBe(false)
    expect(await store.remember(paper, binding)).toBe(false)
    expect((await files.readFile(target(data))).equals(bytes)).toBe(true)
    expect(await files.readdir(data)).toEqual(['cloud-links.json'])
    // The confirmation still holds for this run, so the user is not asked again before restarting.
    expect(await store.has(paper, binding)).toBe(true)
    expect(await store.has(paper, { ...binding, name: 'other' })).toBe(false)
    expect(await new CloudLinkTrust(data).has(paper, binding)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('never follows a linked record', async () => {
    const data = await folder(), outside = join(await folder(), 'elsewhere.json'), paper = join(await folder(), 'paper')
    await files.writeFile(outside, JSON.stringify({ version: 1, links: [{ root: paper, ...binding }] }) + '\n', { mode: 0o600 })
    await files.symlink(outside, target(data))
    const store = new CloudLinkTrust(data)
    expect(await store.has(paper, binding)).toBe(false)
    expect(await store.remember(join(paper, 'other'), binding)).toBe(false)
    expect(JSON.parse(await files.readFile(outside, 'utf8')).links).toHaveLength(1)
  })

  it.each(['relative/paper', '', 'x'.repeat(5000), join(tmpdir(), 'x'.repeat(17000)), join(tmpdir(), 'line\nbreak')])('never confirms an unusable folder path %#', async root => {
    const data = await folder(), store = new CloudLinkTrust(data)
    expect(await store.remember(root, binding)).toBe(false)
    expect(await store.has(root, binding)).toBe(false)
    expect(await files.readdir(data)).toEqual([])
  })

  it('keeps a link found in the record confirmed for this run when the record later becomes unreadable', async () => {
    const data = await folder(), paper = join(await folder(), 'paper')
    await new CloudLinkTrust(data).remember(paper, binding)
    const store = new CloudLinkTrust(data)
    expect(await store.has(paper, binding)).toBe(true)
    await files.writeFile(target(data), '{broken')
    expect(await store.has(paper, binding)).toBe(true)
    expect(await store.has(paper, { ...binding, name: 'other' })).toBe(false)
    expect(await new CloudLinkTrust(data).has(paper, binding)).toBe(false)
  })

  it('shares one record between two stores of the same data directory', async () => {
    const data = await folder(), parent = await folder()
    const first = new CloudLinkTrust(data), second = new CloudLinkTrust(data)
    expect(await first.remember(join(parent, 'a'), binding)).toBe(true)
    expect(await second.remember(join(parent, 'b'), binding)).toBe(true)
    const fresh = new CloudLinkTrust(data)
    expect(await fresh.has(join(parent, 'a'), binding)).toBe(true)
    expect(await fresh.has(join(parent, 'b'), binding)).toBe(true)
  })

  it('serializes concurrent confirmations without losing one', async () => {
    const data = await folder(), parent = await folder(), store = new CloudLinkTrust(data)
    const roots = ['a', 'b', 'c', 'd'].map(name => join(parent, name))
    expect(await Promise.all(roots.map(root => store.remember(root, binding)))).toEqual([true, true, true, true])
    const fresh = new CloudLinkTrust(data)
    for (const root of roots) expect(await fresh.has(root, binding)).toBe(true)
  })
})
