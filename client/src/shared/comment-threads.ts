import type { CommentAnchor, CommentAuthor, CommentEvent } from './comment-contracts'

export interface CommentReply { id: string; at: string; author: CommentAuthor; body: string }
export interface CommentThread {
  id: string
  at: string
  author: CommentAuthor
  anchor: CommentAnchor
  body: string
  replies: CommentReply[]
  /** Latest "marked as fixed" event, or null while the thread is open (a later reopen clears it). */
  resolved: { at: string; author: CommentAuthor } | null
}

const order = (a: CommentEvent, b: CommentEvent): number => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Folds the merged event logs of every device into threads. Devices' clocks may differ, so replies and state
 * changes attach to their thread regardless of order; the latest resolve/reopen (by time, then id) wins.
 * The first copy of a duplicated event id is kept; events for an unknown thread are ignored.
 */
export function buildThreads(events: readonly CommentEvent[]): CommentThread[] {
  const seen = new Set<string>(), sorted: CommentEvent[] = []
  for (const event of [...events].sort(order)) {
    if (seen.has(event.id)) continue
    seen.add(event.id); sorted.push(event)
  }
  const threads = new Map<string, CommentThread>()
  for (const event of sorted) {
    if (event.type !== 'thread') continue
    threads.set(event.id, { id: event.id, at: event.at, author: event.author, anchor: event.anchor, body: event.body,
      replies: [], resolved: null })
  }
  for (const event of sorted) {
    if (event.type === 'thread') continue
    const thread = threads.get(event.thread)
    if (!thread) continue
    if (event.type === 'reply') thread.replies.push({ id: event.id, at: event.at, author: event.author, body: event.body })
    else thread.resolved = event.type === 'resolve' ? { at: event.at, author: event.author } : null
  }
  return [...threads.values()]
}

export function sameAuthor(a: CommentAuthor, b: CommentAuthor): boolean {
  return a.kind === 'github' ? b.kind === 'github' && a.id === b.id : b.kind === 'local' && a.device === b.device
}
