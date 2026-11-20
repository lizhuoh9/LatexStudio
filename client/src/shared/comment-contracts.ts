/** PDF comments travel as ordinary project files: `.latexstudio/comments/<device>.jsonl`, one event per line.
 * Each device only ever appends to its own file, so two collaborators never edit the same file. Authors are what
 * the writing app recorded; anyone with write access to the repository could write other names into these files.
 */
export const COMMENT_DIRECTORY = '.latexstudio/comments'
export const COMMENT_FILE_NAME = /^[a-f0-9]{32}\.jsonl$/
export const COMMENT_LIMITS = Object.freeze({
  body: 4000, quote: 600, context: 160, path: 1024, line: 10_000_000, page: 100_000,
  lineBytes: 32 * 1024, fileBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, files: 500, events: 20_000
})

export type CommentAuthor =
  | { kind: 'github'; login: string; id: number }
  | { kind: 'local'; device: string }

/** Where the selected PDF text came from: SyncTeX source location plus the selected text and a little context. */
export interface CommentAnchor {
  file: string
  line: number
  endLine: number
  quote: string
  before: string
  after: string
  page: number
}

interface EventBase { v: 1; id: string; at: string; author: CommentAuthor }
export type CommentThreadEvent = EventBase & { type: 'thread'; anchor: CommentAnchor; body: string }
export type CommentReplyEvent = EventBase & { type: 'reply'; thread: string; body: string }
export type CommentStateEvent = EventBase & { type: 'resolve' | 'reopen'; thread: string }
export type CommentEvent = CommentThreadEvent | CommentReplyEvent | CommentStateEvent

/** Who new comments will be signed as: the verified session, the last account verified on this device, or nobody. */
export type CommentIdentity =
  | { source: 'session' | 'device'; login: string; id: number }
  | { source: 'anonymous' }

export interface CommentSnapshot {
  events: CommentEvent[]
  /** Lines or files that could not be read as comments (damaged, newer format or over a limit); never repaired. */
  unreadable: number
  identity: CommentIdentity
}

export interface NewCommentThread { anchor: CommentAnchor; body: string }

export interface CommentApi {
  list(): Promise<CommentSnapshot>
  create(input: NewCommentThread): Promise<CommentSnapshot>
  reply(thread: string, body: string): Promise<CommentSnapshot>
  setResolved(thread: string, resolved: boolean): Promise<CommentSnapshot>
}

export const COMMENT_CHANNELS = {
  list: 'comments:list', create: 'comments:create', reply: 'comments:reply', resolve: 'comments:resolve'
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const DEVICE = /^[a-f0-9]{32}$/
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u
const RESERVED = /^(?:con|conin\$|conout\$|clock\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

type Fields = Record<string, unknown>
function record(value: unknown, keys: readonly string[]): Fields | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const names = Object.keys(value)
  return names.length === keys.length && keys.every(key => Object.hasOwn(value, key)) ? value as Fields : null
}
const integer = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max

export function isCommentId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
export function isCommentDevice(value: unknown): value is string { return typeof value === 'string' && DEVICE.test(value) }

export function isCommentTime(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
}

/** A comment body: non-empty after trimming, bounded, newlines allowed, no other control characters. */
export function commentBody(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const body = value.replace(/\r\n?/g, '\n').trim()
  return body && body.length <= COMMENT_LIMITS.body && !UNSAFE_TEXT.test(body) && !body.includes('\t') ? body : null
}

/** Selected PDF text and its context are stored as single-line, whitespace-collapsed text. */
export function commentSnippet(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= limit && !UNSAFE_TEXT.test(text) ? text : null
}

export function commentPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > COMMENT_LIMITS.path || /^[\\/]|[\\:%<>"|?*\x00-\x1f\x7f]/.test(value) ||
    /[\uD800-\uDFFF]/u.test(value)) return null
  const parts = value.split('/')
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || RESERVED.test(part))) return null
  return value
}

export function commentAuthor(value: unknown): CommentAuthor | null {
  const github = record(value, ['kind', 'login', 'id'])
  if (github && github.kind === 'github' && typeof github.login === 'string' && LOGIN.test(github.login) &&
    integer(github.id, Number.MAX_SAFE_INTEGER)) return { kind: 'github', login: github.login, id: github.id }
  const local = record(value, ['kind', 'device'])
  if (local && local.kind === 'local' && isCommentDevice(local.device)) return { kind: 'local', device: local.device }
  return null
}

export function commentAnchor(value: unknown): CommentAnchor | null {
  const data = record(value, ['file', 'line', 'endLine', 'quote', 'before', 'after', 'page'])
  if (!data) return null
  const file = commentPath(data.file), quote = commentSnippet(data.quote, COMMENT_LIMITS.quote)
  const before = commentSnippet(data.before, COMMENT_LIMITS.context), after = commentSnippet(data.after, COMMENT_LIMITS.context)
  if (!file || !quote || before === null || after === null || !integer(data.line, COMMENT_LIMITS.line) ||
    !integer(data.endLine, COMMENT_LIMITS.line) || data.endLine < data.line || !integer(data.page, COMMENT_LIMITS.page)) return null
  return { file, line: data.line, endLine: data.endLine, quote, before, after, page: data.page }
}

const EVENT_KEYS = {
  thread: ['v', 'type', 'id', 'at', 'author', 'anchor', 'body'],
  reply: ['v', 'type', 'id', 'at', 'author', 'thread', 'body'],
  resolve: ['v', 'type', 'id', 'at', 'author', 'thread'],
  reopen: ['v', 'type', 'id', 'at', 'author', 'thread']
} as const

/** Strict parse of one stored event. Anything else (including a newer format) is reported as unreadable, not guessed. */
export function parseCommentEvent(value: unknown): CommentEvent | null {
  const type = value && typeof value === 'object' && !Array.isArray(value) ? (value as Fields).type : undefined
  if (type !== 'thread' && type !== 'reply' && type !== 'resolve' && type !== 'reopen') return null
  const data = record(value, EVENT_KEYS[type])
  const author = data && commentAuthor(data.author)
  if (!data || data.v !== 1 || !isCommentId(data.id) || !isCommentTime(data.at) || !author) return null
  const base = { v: 1 as const, id: data.id, at: data.at, author }
  if (type === 'thread') {
    const anchor = commentAnchor(data.anchor), body = commentBody(data.body)
    return anchor && body && body === data.body ? { ...base, type, anchor, body } : null
  }
  if (!isCommentId(data.thread)) return null
  if (type === 'reply') {
    const body = commentBody(data.body)
    return body && body === data.body ? { ...base, type, thread: data.thread, body } : null
  }
  return { ...base, type, thread: data.thread }
}

/** One JSON line with a fixed key order, so the files stay readable and diff cleanly. */
export function serializeCommentEvent(event: CommentEvent): string {
  const head = { v: event.v, type: event.type, id: event.id, at: event.at, author: event.author }
  const body = event.type === 'thread' ? { ...head, anchor: { ...event.anchor }, body: event.body }
    : event.type === 'reply' ? { ...head, thread: event.thread, body: event.body } : { ...head, thread: event.thread }
  const line = JSON.stringify(body)
  if (parseCommentEvent(JSON.parse(line)) === null || new TextEncoder().encode(line).length > COMMENT_LIMITS.lineBytes) {
    throw new Error('评论内容无效。')
  }
  return line
}
