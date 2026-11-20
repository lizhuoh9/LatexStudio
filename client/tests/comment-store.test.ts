import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeCommentEvent, type CommentEvent } from '../src/shared/comment-contracts'
import { CommentStore } from '../src/main/comments/comment-store'
import { WorkspaceComments } from '../src/main/comments/comment-service'
import type { VerifiedAccount } from '../src/main/comments/comment-identity'
import { projectPath, SafeProject } from '../src/main/local/paths'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'latexstudio-comments-'))
  folders.push(path)
  return path
}
const deviceA = 'a'.repeat(32), deviceB = 'b'.repeat(32)
const anchor = { file: 'main.tex', line: 2, endLine: 2, quote: 'strong gains', before: 'shows', after: 'over', page: 1 }
const event = (n: number, body = `comment ${n}`): CommentEvent => ({ v: 1, type: 'thread', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  at: `2026-11-19T10:00:0${n}.000Z`, author: { kind: 'github', login: 'alice', id: 42 }, anchor, body })
const commentsDir = (root: string): string => join(root, '.latexstudio', 'comments')

describe('comment files inside a project', () => {
  it('reads nothing and creates nothing until the first comment is written', async () => {
    const root = await folder()
    expect(await new CommentStore(root).list()).toEqual({ events: [], unreadable: 0 })
    expect(await readdir(root)).toEqual([])
  })

  it('appends one line per event to this device file and reads every device file', async () => {
    const root = await folder(), store = new CommentStore(root)
    await store.append(deviceA, event(1))
    await store.append(deviceA, event(2))
    await writeFile(join(commentsDir(root), `${deviceB}.jsonl`), `${serializeCommentEvent(event(3))}\n`)
    const text = await readFile(join(commentsDir(root), `${deviceA}.jsonl`), 'utf8')
    expect(text.split('\n')).toHaveLength(3)
    expect(text.endsWith('\n')).toBe(true)
    expect((await store.list()).events.map(item => item.id.slice(-1))).toEqual(['1', '2', '3'])
    expect((await readdir(commentsDir(root))).sort()).toEqual([`${deviceA}.jsonl`, `${deviceB}.jsonl`])
  })

  it('keeps valid lines, counts damaged ones and ignores files that are not comment logs', async () => {
    const root = await folder()
    await mkdir(commentsDir(root), { recursive: true })
    await writeFile(join(commentsDir(root), `${deviceA}.jsonl`), `${serializeCommentEvent(event(1))}\n{"broken":\nnot json\n${serializeCommentEvent(event(2))}`)
    await writeFile(join(commentsDir(root), 'README.md'), 'notes')
    await writeFile(join(commentsDir(root), `${deviceB}.jsonl`), Buffer.from([0xff, 0xfe, 0x00]))
    const read = await new CommentStore(root).list()
    expect(read.events.map(item => item.type === 'thread' ? item.body : item.type)).toEqual(['comment 1', 'comment 2'])
    expect(read.unreadable).toBe(3)
  })

  it('starts a new line when the existing log lost its final newline', async () => {
    const root = await folder()
    await mkdir(commentsDir(root), { recursive: true })
    await writeFile(join(commentsDir(root), `${deviceA}.jsonl`), serializeCommentEvent(event(1)))
    await new CommentStore(root).append(deviceA, event(2))
    expect((await new CommentStore(root).list()).events).toHaveLength(2)
  })

  it('refuses an invalid device name or a full log without changing the file', async () => {
    const root = await folder(), store = new CommentStore(root)
    await expect(store.append('../escape', event(1))).rejects.toThrow('本机评论身份无效')
    await mkdir(commentsDir(root), { recursive: true })
    const line = `${serializeCommentEvent(event(1))}\n`
    const big = line.repeat(Math.floor((2 * 1024 * 1024 - 1000) / line.length))
    await writeFile(join(commentsDir(root), `${deviceA}.jsonl`), big)
    await expect(store.append(deviceA, event(2, 'x'.repeat(3000)))).rejects.toThrow('已达到大小上限')
    expect(await readFile(join(commentsDir(root), `${deviceA}.jsonl`), 'utf8')).toBe(big)
  })

  it('refuses a comment folder that is a link out of the project', async () => {
    const root = await folder(), outside = await folder()
    await mkdir(join(root, '.latexstudio'))
    await symlink(outside, commentsDir(root), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new CommentStore(root).list()).rejects.toThrow('评论目录包含符号链接')
    await expect(new CommentStore(root).append(deviceA, event(1))).rejects.toThrow('评论目录包含符号链接')
    expect(await readdir(outside)).toEqual([])
  })

  it('keeps comment logs out of the editor, file tree and compile copy', async () => {
    const root = await folder()
    await new CommentStore(root).append(deviceA, event(1))
    await writeFile(join(root, 'main.tex'), 'paper')
    const project = new SafeProject(root); await project.initialize()
    expect((await project.list(true)).map(file => file.path)).toEqual(['main.tex'])
    expect(() => projectPath(`.latexstudio/comments/${deviceA}.jsonl`)).toThrow()
  })
})

describe('comment operations and signatures', () => {
  let account: VerifiedAccount | null = null
  async function service(): Promise<{ root: string; comments: WorkspaceComments; data: string }> {
    const root = await folder(), data = await folder()
    return { root, data, comments: new WorkspaceComments(data, { root: () => root, account: () => account }) }
  }
  afterEach(() => { account = null })

  it('signs with the verified session and later, offline, with the last account verified on this device', async () => {
    const { comments, data } = await service()
    account = { login: 'alice', id: 42 }
    const first = await comments.create({ anchor, body: '  needs a citation ' })
    expect(first.identity).toEqual({ source: 'session', login: 'alice', id: 42 })
    expect(first.events[0]).toMatchObject({ type: 'thread', body: 'needs a citation', author: { kind: 'github', login: 'alice', id: 42 } })
    account = null
    const offline = await comments.reply(first.events[0]!.id, 'fixed?')
    expect(offline.identity).toEqual({ source: 'device', login: 'alice', id: 42 })
    expect(offline.events.at(-1)).toMatchObject({ type: 'reply', author: { kind: 'github', login: 'alice', id: 42 } })
    const record = JSON.parse(await readFile(join(data, 'comment-identity.json'), 'utf8'))
    expect(Object.keys(record)).toEqual(['version', 'device', 'account'])
    expect(record.account).toEqual({ login: 'alice', id: 42 })
  })

  it('signs as this device when no account was ever verified here, in a file named after the device', async () => {
    const { root, comments } = await service()
    const created = await comments.create({ anchor, body: 'local note' })
    expect(created.identity).toEqual({ source: 'anonymous' })
    const author = created.events[0]!.author
    expect(author.kind).toBe('local')
    expect(await readdir(commentsDir(root))).toEqual([`${(author as { device: string }).device}.jsonl`])
  })

  it('marks fixed and reopens once per change, and rejects unknown threads and invalid input', async () => {
    const { comments } = await service()
    account = { login: 'bob', id: 7 }
    const thread = (await comments.create({ anchor, body: 'typo' })).events[0]!.id
    await comments.setResolved(thread, true)
    const again = await comments.setResolved(thread, true)
    expect(again.events.filter(item => item.type === 'resolve')).toHaveLength(1)
    const reopened = await comments.setResolved(thread, false)
    expect(reopened.events.map(item => item.type)).toEqual(['thread', 'resolve', 'reopen'])
    await expect(comments.reply('00000000-0000-4000-8000-000000000099', 'x')).rejects.toThrow('找不到这条评论')
    await expect(comments.reply(thread, '   ')).rejects.toThrow('回复内容不能为空')
    await expect(comments.create({ anchor, body: 'x', extra: 1 })).rejects.toThrow('评论位置无效')
    await expect(comments.create({ anchor: { ...anchor, file: '../outside.tex' }, body: 'x' })).rejects.toThrow('评论位置无效')
    await expect(comments.setResolved(thread, 'yes')).rejects.toThrow('评论状态无效')
  })

  it('refuses to write when the device record is unreadable and leaves that record untouched', async () => {
    const { comments, data } = await service()
    await writeFile(join(data, 'comment-identity.json'), '{"version":1,"device":"zz","account":null}\n')
    await expect(comments.create({ anchor, body: 'x' })).rejects.toThrow('本机评论身份记录无法读取或保存')
    expect(await readFile(join(data, 'comment-identity.json'), 'utf8')).toBe('{"version":1,"device":"zz","account":null}\n')
  })

  it('requires an open project', async () => {
    const data = await folder()
    const comments = new WorkspaceComments(data, { root: () => null, account: () => null })
    await expect(comments.list()).rejects.toThrow('请先打开一个本地论文项目')
  })
})
