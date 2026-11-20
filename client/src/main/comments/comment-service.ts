import { randomUUID } from 'node:crypto'
import { commentAnchor, commentBody, isCommentId, type CommentEvent, type CommentSnapshot } from '../../shared/comment-contracts'
import { buildThreads } from '../../shared/comment-threads'
import { CommentIdentityStore, type VerifiedAccount } from './comment-identity'
import { CommentStore } from './comment-store'

export interface WorkspaceCommentsHost {
  /** The active project's root, or null when no project is open. */
  root(): string | null
  /** The currently verified GitHub account, or null (signed out, offline or still recovering). */
  account(): VerifiedAccount | null
}

/** IPC-facing comment operations for the active project. Main builds every event itself (id, time, author);
 * the renderer only supplies the anchor, the text and which thread to reply to or mark.
 */
export class WorkspaceComments {
  private readonly identity: CommentIdentityStore
  constructor(dataRoot: string, private readonly host: WorkspaceCommentsHost) { this.identity = new CommentIdentityStore(dataRoot) }

  async list(): Promise<CommentSnapshot> {
    const root = this.requireRoot(), account = this.host.account()
    if (account) await this.identity.remember(account).catch(() => undefined)
    const read = await new CommentStore(root).list()
    return { events: read.events, unreadable: read.unreadable, identity: await this.identity.preview(account) }
  }

  async create(input: unknown): Promise<CommentSnapshot> {
    const data = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
    const anchor = commentAnchor(data.anchor), body = commentBody(data.body)
    if (Object.keys(data).length !== 2 || !anchor) throw new Error('评论位置无效，请重新选择 PDF 文字。')
    if (!body) throw new Error('评论内容不能为空，且不能超过 4000 字。')
    return this.write(author => ({ v: 1, type: 'thread', id: randomUUID(), at: new Date().toISOString(), author, anchor, body }))
  }

  async reply(thread: unknown, text: unknown): Promise<CommentSnapshot> {
    const body = commentBody(text)
    if (!body) throw new Error('回复内容不能为空，且不能超过 4000 字。')
    await this.requireThread(thread)
    return this.write(author => ({ v: 1, type: 'reply', id: randomUUID(), at: new Date().toISOString(), author, thread: thread as string, body }))
  }

  async setResolved(thread: unknown, resolved: unknown): Promise<CommentSnapshot> {
    if (typeof resolved !== 'boolean') throw new Error('评论状态无效。')
    const current = await this.requireThread(thread)
    if ((current.resolved !== null) === resolved) return this.list()
    return this.write(author => ({ v: 1, type: resolved ? 'resolve' : 'reopen', id: randomUUID(),
      at: new Date().toISOString(), author, thread: thread as string }))
  }

  private async write(build: (author: CommentEvent['author']) => CommentEvent): Promise<CommentSnapshot> {
    const root = this.requireRoot()
    const signer = await this.identity.signer(this.host.account()).catch(() => {
      throw new Error('本机评论身份记录无法读取或保存，未写入评论。')
    })
    await new CommentStore(root).append(signer.device, build(signer.author))
    return this.list()
  }

  private async requireThread(thread: unknown): Promise<ReturnType<typeof buildThreads>[number]> {
    if (!isCommentId(thread)) throw new Error('评论编号无效。')
    const found = buildThreads((await new CommentStore(this.requireRoot()).list()).events).find(item => item.id === thread)
    if (!found) throw new Error('找不到这条评论，可能已在其他设备上更改；请刷新评论后重试。')
    return found
  }

  private requireRoot(): string {
    const root = this.host.root()
    if (!root) throw new Error('请先打开一个本地论文项目。')
    return root
  }
}
