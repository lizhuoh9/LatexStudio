import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { lstat } from 'node:fs/promises'
import type { RevisionDetail, RevisionEntry } from '../../shared/workspace-contracts'
import { code, decodeText, digest, LIMITS, projectPath } from './paths'
import { HistoryStore } from './history-store'
import { cleanHistoryLabel, HISTORY_ID, historyFailure, parseHistoryRecord, serializeHistoryEntry, UNKNOWN_AUTHOR } from './history-validation'

export interface VersionChange {
  path: string
  before: Buffer | null
  after: Buffer
  kind?: 'create' | 'save' | 'restore'
  summary?: string
}
export interface VersionReceipt { commit(): Promise<void>; abort(): Promise<void> }
export interface VersionHistoryOptions { author?: string; now?: () => Date; maxBytes?: number; maxEntries?: number }

/** Shared, append-only file history, NOT an authenticated audit log. Mutations require the project's write lock. */
export class VersionHistory {
  private readonly store: HistoryStore
  private readonly author: string
  private readonly now: () => Date
  constructor(root: string, options: VersionHistoryOptions = {}) {
    const maxBytes = options.maxBytes ?? 128 * 1024 * 1024, maxEntries = options.maxEntries ?? 10_000
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 10_000)
      throw historyFailure('历史配额配置无效')
    this.store = new HistoryStore(root, { maxBytes, maxEntries })
    this.author = cleanHistoryLabel(options.author ?? userInfo().username) || 'LatexStudio 用户'
    this.now = options.now ?? (() => new Date())
  }
  async list(): Promise<RevisionEntry[]> {
    if (!await this.store.initialize(false)) return []
    await this.store.ensureBudget(0, 0, 0)
    const entries = await this.entries('entries')
    await this.verifyObjects(entries)
    return entries.sort(compareEntries).reverse()
  }
  async detail(id: string): Promise<RevisionDetail> {
    if (typeof id !== 'string' || !HISTORY_ID.test(id)) throw historyFailure('历史编号无效')
    const entry = parseHistoryRecord(await this.store.read('entries', `${id}.json`))
    if (entry.id !== id) throw historyFailure('历史编号与文件不一致')
    const before = entry.beforeRevision ? decodeText(await this.store.read('objects', entry.beforeRevision)) : null
    const after = decodeText(await this.store.read('objects', entry.afterRevision))
    return { entry, before, after }
  }
  /** Called only inside withProjectWriteLock, before changing the project file. */
  async prepare(change: VersionChange): Promise<VersionReceipt> {
    this.validateChange(change)
    await this.store.initialize(true)
    await this.recover()
    if (await this.current(change.path) !== (change.before ? digest(change.before) : null))
      throw historyFailure('文件在历史准备期间发生变化')
    const entries = await this.list(), latest = entries.find(entry => entry.path === change.path)
    let time = Math.max(this.now().getTime(), ...entries.map(entry => Date.parse(entry.date) + 1))
    if (!Number.isFinite(time)) throw historyFailure('系统时间无效')
    const external = change.before && latest?.afterRevision !== digest(change.before)
      ? this.makeEntry(change.path, 'external', latest?.afterRevision ?? null, digest(change.before), UNKNOWN_AUTHOR,
        latest ? '检测到外部修改（作者未知）' : '保存前原始内容（作者未知）', new Date(time++).toISOString()) : null
    const entry = this.makeEntry(change.path, change.kind ?? (change.before ? 'save' : 'create'),
      change.before ? digest(change.before) : null, digest(change.after), this.author,
      cleanHistoryLabel(change.summary ?? `${change.kind === 'restore' ? '回退' : change.before ? '保存' : '新建'} ${change.path}`, 200), new Date(time).toISOString())
    const records = external ? [external, entry] : [entry]
    await this.reserveAndWrite(change, records)
    if (external) await this.store.publish(external.id)
    let settled = false
    return {
      commit: async () => {
        if (settled) throw historyFailure('历史事务已结束')
        if (await this.current(entry.path) !== entry.afterRevision) throw historyFailure('保存后的文件与历史不一致')
        await this.store.publish(entry.id)
        settled = true
      },
      abort: async () => {
        if (settled) return
        await this.reconcile(entry)
        settled = true
      }
    }
  }
  /** Pending survives crashes/disconnects; ambiguous content blocks the next write, never guesses an author. */
  private async recover(): Promise<void> {
    const pending = await this.entries('pending')
    await this.verifyObjects(pending)
    for (const entry of pending.sort(compareEntries)) await this.reconcile(entry)
  }
  private async reconcile(entry: RevisionEntry): Promise<void> {
    const current = await this.current(entry.path)
    if (current === entry.afterRevision) await this.store.publish(entry.id)
    else if (current === entry.beforeRevision) await this.store.removePending(entry.id)
    else throw historyFailure('存在未完成保存，且实际内容无法确认；已保留前后版本和待恢复记录')
  }
  private async current(path: string): Promise<string | null> {
    try { return digest(await this.store.project.readBytes(path, LIMITS.text)) }
    catch (error) {
      if (code(error) !== 'ENOENT') throw error
      // ENOENT from readBytes may mean a missing root/parent or a lost connection, NOT a missing leaf.
      const target = await this.store.project.resolve(path, true)
      const leaf = await lstat(target).catch((cause: unknown) => { if (code(cause) !== 'ENOENT') throw cause; return null })
      if (leaf) throw historyFailure('文件在历史检查期间重新出现，请重新读取')
      await this.store.project.verifyRoot()
      const separator = path.lastIndexOf('/')
      if (separator >= 0) await this.store.project.resolve(path.slice(0, separator))
      return null
    }
  }
  private async entries(bucket: 'entries' | 'pending'): Promise<RevisionEntry[]> {
    const entries: RevisionEntry[] = []
    for (const name of await this.store.names(bucket)) {
      const entry = parseHistoryRecord(await this.store.read(bucket, name))
      if (`${entry.id}.json` !== name) throw historyFailure('历史编号与文件不一致')
      entries.push(entry)
    }
    return entries
  }
  private async verifyObjects(entries: RevisionEntry[]): Promise<void> {
    const checked = new Set<string>()
    for (const entry of entries) for (const hash of [entry.beforeRevision, entry.afterRevision]) {
      if (!hash || checked.has(hash)) continue
      decodeText(await this.store.read('objects', hash))
      checked.add(hash)
    }
  }
  private async reserveAndWrite(change: VersionChange, entries: RevisionEntry[]): Promise<void> {
    const objects = new Map<string, Buffer>()
    for (const bytes of [change.before, change.after]) if (bytes) objects.set(digest(bytes), bytes)
    const missing: [string, Buffer][] = []
    for (const [hash, bytes] of objects) {
      try { if (!(await this.store.read('objects', hash)).equals(bytes)) throw historyFailure('内容哈希冲突') }
      catch (error) { if (code(error) !== 'ENOENT') throw error; missing.push([hash, bytes]) }
    }
    const records = entries.map(entry => [entry.id, serializeHistoryEntry(entry)] as const)
    await this.store.ensureBudget(missing.reduce((n, [, b]) => n + b.length, 0) + records.reduce((n, [, b]) => n + b.length, 0), records.length, missing.length)
    for (const [hash, bytes] of missing) await this.store.put('objects', hash, bytes)
    for (const [id, bytes] of records) await this.store.put('pending', `${id}.json`, bytes)
  }
  private makeEntry(path: string, kind: RevisionEntry['kind'], beforeRevision: string | null,
    afterRevision: string, author: string, summary: string, date: string): RevisionEntry {
    return { id: randomUUID(), path, kind, beforeRevision, afterRevision, author, summary, date }
  }
  private validateChange(change: VersionChange): void {
    projectPath(change.path)
    if (change.before !== null) decodeText(change.before)
    decodeText(change.after)
    if (change.kind && !['save', 'create', 'restore'].includes(change.kind)) throw historyFailure('保存类型无效')
    if (change.summary !== undefined && typeof change.summary !== 'string') throw historyFailure('摘要无效')
  }
}
function compareEntries(a: RevisionEntry, b: RevisionEntry): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
}
