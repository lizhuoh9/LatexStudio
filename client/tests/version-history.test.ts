import { afterEach, describe, expect, it } from 'vitest'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VersionHistory } from '../src/main/local/version-history'
import { digest } from '../src/main/local/paths'
import { UNKNOWN_AUTHOR } from '../src/main/local/history-validation'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(options: ConstructorParameters<typeof VersionHistory>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-version-history-')); roots.push(root)
  return { root, history: new VersionHistory(root, { author: 'alice', now: () => new Date('2026-11-13T00:00:00.000Z'), ...options }),
    base: join(root, '.paperstudio', 'history-v1') }
}
async function apply(history: VersionHistory, root: string, before: string | null, after: string, kind: 'create' | 'save' | 'restore' = before === null ? 'create' : 'save') {
  const receipt = await history.prepare({ path: 'main.tex', before: before === null ? null : Buffer.from(before), after: Buffer.from(after), kind })
  await writeFile(join(root, 'main.tex'), after)
  await receipt.commit()
}

describe('shared file version history', () => {
  it('is empty without creating metadata on read', async () => {
    const { root, history } = await setup()
    expect(await history.list()).toEqual([])
    expect(await readdir(root)).toEqual([])
  })
  it('shares create/save history across instances and stores before/after bytes', async () => {
    const { root, history, base } = await setup()
    await apply(history, root, null, 'first')
    await apply(history, root, 'first', 'second')
    const other = new VersionHistory(root, { author: 'bob' }), entries = await other.list()
    expect(entries.map(x => [x.kind, x.author])).toEqual([['save', 'alice'], ['create', 'alice']])
    expect(await other.detail(entries[0]!.id)).toEqual({ entry: entries[0], before: 'first', after: 'second' })
    expect((await other.detail(entries[1]!.id)).before).toBeNull()
    expect(await readdir(join(base, 'objects'))).toHaveLength(2)
    expect(await readdir(root)).not.toContain('.git')
  })
  it('records an existing baseline as unknown, never the current saver', async () => {
    const { root, history } = await setup()
    await writeFile(join(root, 'main.tex'), 'external-original')
    await apply(history, root, 'external-original', 'saved')
    const entries = await history.list()
    expect(entries.map(x => x.kind)).toEqual(['save', 'external'])
    expect(entries[1]!.author).toBe(UNKNOWN_AUTHOR)
    expect((await history.detail(entries[1]!.id)).after).toBe('external-original')
  })
  it('preserves known previous and unknown external versions before a subsequent save', async () => {
    const { root, history } = await setup()
    await apply(history, root, null, 'known')
    await writeFile(join(root, 'main.tex'), 'outside-app')
    await apply(history, root, 'outside-app', 'new-save')
    const external = (await history.list()).find(x => x.kind === 'external')!
    expect(external.author).toBe(UNKNOWN_AUTHOR)
    expect(await history.detail(external.id)).toEqual({ entry: external, before: 'known', after: 'outside-app' })
  })
  it('restore appends a new version and keeps the original entries', async () => {
    const { root, history } = await setup()
    await apply(history, root, null, 'first'); await apply(history, root, 'first', 'second')
    await apply(history, root, 'second', 'first', 'restore')
    const entries = await history.list()
    expect(entries).toHaveLength(3)
    expect(entries[0]!.kind).toBe('restore')
    expect((await history.detail(entries[0]!.id)).before).toBe('second')
  })
  it('cleans labels and makes ordering monotonic even if device clocks move backwards', async () => {
    const { root, history } = await setup({ author: '\u0000 alice\u202e\n' })
    await apply(history, root, null, 'one')
    const slow = new VersionHistory(root, { author: 'bob', now: () => new Date('2020-01-01T00:00:00Z') })
    await apply(slow, root, 'one', 'two')
    const entries = await history.list()
    expect(entries.map(x => x.author)).toEqual(['bob', 'alice'])
    expect(Date.parse(entries[0]!.date)).toBeGreaterThan(Date.parse(entries[1]!.date))
  })
  it('abort before writing removes pending, but keeps reusable immutable objects', async () => {
    const { root, history, base } = await setup()
    const receipt = await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('not-written') })
    await receipt.abort()
    expect(await history.list()).toEqual([])
    expect(await readdir(join(base, 'pending'))).toEqual([])
    expect(await readdir(root)).not.toContain('main.tex')
  })
  it('abort after actual writing commits the audit rather than losing recovery data', async () => {
    const { root, history, base } = await setup()
    const receipt = await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('written') })
    await writeFile(join(root, 'main.tex'), 'written'); await receipt.abort()
    expect(await history.list()).toHaveLength(1)
    expect(await readdir(join(base, 'pending'))).toEqual([])
  })
  it('does not let a read publish an active pending transaction', async () => {
    const { root, history, base } = await setup()
    const receipt = await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('later') })
    await writeFile(join(root, 'main.tex'), 'later')
    expect(await new VersionHistory(root).list()).toEqual([])
    expect(await readdir(join(base, 'pending'))).toHaveLength(1)
    await receipt.commit()
  })
  it('recovers a written pending mutation before the next save', async () => {
    const { root, history } = await setup()
    await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('crash-after-write') })
    await writeFile(join(root, 'main.tex'), 'crash-after-write')
    const next = new VersionHistory(root, { author: 'bob' })
    await apply(next, root, 'crash-after-write', 'next-save')
    expect((await next.list()).map(x => x.author)).toEqual(['bob', 'alice'])
  })
  it('recovers an unwritten pending mutation without attributing it as a save', async () => {
    const { root, history } = await setup()
    await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('never-written') })
    await apply(new VersionHistory(root, { author: 'bob' }), root, null, 'actual')
    expect((await history.list()).map(x => x.author)).toEqual(['bob'])
  })
  it('does not mistake a missing parent for an absent create target or discard pending', async () => {
    const { root, history, base } = await setup()
    await mkdir(join(root, 'chapters'))
    const receipt = await history.prepare({ path: 'chapters/main.tex', before: null, after: Buffer.from('intended') })
    await rm(join(root, 'chapters'), { recursive: true })
    await expect(receipt.abort()).rejects.toThrow()
    expect(await readdir(join(base, 'pending'))).toHaveLength(1)
    await expect(history.prepare({ path: 'main.tex', before: null, after: Buffer.from('next') })).rejects.toThrow()
    expect(await readdir(join(base, 'pending'))).toHaveLength(1)
  })
  it('preserves pending while the project root is disconnected (local rename simulation)', async () => {
    const { root, history, base } = await setup()
    const receipt = await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('intended') })
    const disconnected = `${root}-disconnected`
    roots.push(disconnected)
    await rename(root, disconnected)
    try {
      await expect(receipt.abort()).rejects.toThrow()
      expect(await readdir(join(disconnected, '.paperstudio', 'history-v1', 'pending'))).toHaveLength(1)
    } finally { await rename(disconnected, root) }
    expect(await readdir(join(base, 'pending'))).toHaveLength(1)
    await receipt.abort()
    expect(await readdir(join(base, 'pending'))).toEqual([])
  })
  it('preserves ambiguous pending and fails closed rather than guessing an author', async () => {
    const { root, history, base } = await setup()
    const receipt = await history.prepare({ path: 'main.tex', before: null, after: Buffer.from('intended') })
    await writeFile(join(root, 'main.tex'), 'unknown-external')
    await expect(receipt.commit()).rejects.toThrow('历史不一致')
    await expect(receipt.abort()).rejects.toThrow('未完成保存')
    await expect(history.prepare({ path: 'main.tex', before: Buffer.from('unknown-external'), after: Buffer.from('next') })).rejects.toThrow('未完成保存')
    expect(await readdir(join(base, 'pending'))).toHaveLength(1)
    expect(await readFile(join(base, 'objects', digest(Buffer.from('intended'))), 'utf8')).toBe('intended')
  })
  it('rejects stale preparation before storing an attributable revision', async () => {
    const { root, history } = await setup()
    await writeFile(join(root, 'main.tex'), 'current')
    await expect(history.prepare({ path: 'main.tex', before: Buffer.from('old'), after: Buffer.from('new') })).rejects.toThrow('发生变化')
    expect(await history.list()).toEqual([])
  })
  it.each([{ maxBytes: 10 }, { maxEntries: 1 }])('rejects exhausted quotas without changing current content: %j', async options => {
    const { root, history } = await setup(options)
    await writeFile(join(root, 'main.tex'), 'original')
    await expect(history.prepare({ path: 'main.tex', before: Buffer.from('original'), after: Buffer.from('next') })).rejects.toThrow('已满')
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('original')
    expect(await history.list()).toEqual([])
  })
  it('rejects malformed ids and traversal paths', async () => {
    const { history } = await setup()
    await expect(history.detail('../anything')).rejects.toThrow('编号无效')
    await expect(history.prepare({ path: '../escape.tex', before: null, after: Buffer.from('x') })).rejects.toThrow('项目路径')
  })
  it('detects object corruption and does not publish more writes', async () => {
    const { root, history, base } = await setup()
    await apply(history, root, null, 'first')
    await writeFile(join(base, 'objects', digest(Buffer.from('first'))), 'tampered')
    await expect(history.list()).rejects.toThrow('哈希不匹配')
    await expect(history.prepare({ path: 'main.tex', before: Buffer.from('first'), after: Buffer.from('next') })).rejects.toThrow('哈希不匹配')
  })
  it('rejects metadata corruption and extra unsafe fields', async () => {
    const { root, history, base } = await setup()
    await apply(history, root, null, 'first')
    const name = (await readdir(join(base, 'entries')))[0]!, file = join(base, 'entries', name)
    const parsed = JSON.parse(await readFile(file, 'utf8')); parsed.entry.author = 'a\nb'
    await writeFile(file, JSON.stringify(parsed)); await expect(history.list()).rejects.toThrow('作者无效')
    parsed.entry.author = 'alice'; parsed.entry.extra = 'x'
    await writeFile(file, JSON.stringify(parsed)); await expect(history.list()).rejects.toThrow('字段无效')
  })
  it('rejects missing referenced objects, incomplete directories and unexpected files', async () => {
    const { root, history, base } = await setup()
    await apply(history, root, null, 'first')
    await rm(join(base, 'objects'), { recursive: true })
    await expect(history.list()).rejects.toThrow('目录不完整')
    await mkdir(join(base, 'objects')); await expect(history.list()).rejects.toThrow()
    await writeFile(join(base, 'entries', 'unexpected.json'), '{}')
    await expect(history.list()).rejects.toThrow('未知或损坏')
  })
  it('rejects hardlinked version objects', async () => {
    const { root, history, base } = await setup()
    await apply(history, root, null, 'first')
    await link(join(base, 'objects', digest(Buffer.from('first'))), join(root, 'linked-object'))
    await expect(history.list()).rejects.toThrow('链接')
  })
  it('rejects a redirected history directory before writing any object', async () => {
    const { root, history } = await setup(), outside = await mkdtemp(join(tmpdir(), 'paperstudio-history-outside-')); roots.push(outside)
    await mkdir(join(root, '.paperstudio'))
    await symlink(outside, join(root, '.paperstudio', 'history-v1'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(history.prepare({ path: 'main.tex', before: null, after: Buffer.from('x') })).rejects.toThrow('真实目录')
    expect(await readdir(outside)).toEqual([])
  })
})
