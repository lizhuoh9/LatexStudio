import type { RevisionEntry } from '../../shared/workspace-contracts'
import { projectPath } from './paths'

export const HISTORY_HASH = /^[a-f0-9]{64}$/
export const HISTORY_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export const UNKNOWN_AUTHOR = '未知来源（外部修改）'
export const HISTORY_RECORD_LIMIT = 8192
const KINDS = new Set(['create', 'save', 'restore', 'external'])
const KEYS = ['id', 'path', 'author', 'date', 'kind', 'summary', 'beforeRevision', 'afterRevision']

export function historyFailure(detail: string): Error {
  return new Error(`共享文件历史不可用：${detail}；文件可能已保存，请保留草稿并检查实际文件，勿反复覆盖。`)
}
export function cleanHistoryLabel(value: string, limit = 64): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, limit)
}
export function parseHistoryRecord(bytes: Buffer): RevisionEntry {
  let record: unknown
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw historyFailure('历史记录损坏') }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw historyFailure('历史记录格式无效')
  const wrapper = record as Record<string, unknown>
  if (Object.keys(wrapper).sort().join(',') !== 'entry,schema' || wrapper.schema !== 1)
    throw historyFailure('历史记录版本无效')
  return validateHistoryEntry(wrapper.entry)
}
export function validateHistoryEntry(value: unknown): RevisionEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw historyFailure('历史条目无效')
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).sort().join(',') !== [...KEYS].sort().join(',')) throw historyFailure('历史字段无效')
  if (typeof entry.id !== 'string' || !HISTORY_ID.test(entry.id)) throw historyFailure('历史编号无效')
  if (typeof entry.path !== 'string') throw historyFailure('历史路径无效')
  projectPath(entry.path)
  if (typeof entry.author !== 'string' || !entry.author || entry.author !== cleanHistoryLabel(entry.author))
    throw historyFailure('历史作者无效')
  if (typeof entry.summary !== 'string' || entry.summary !== cleanHistoryLabel(entry.summary, 200))
    throw historyFailure('历史摘要无效')
  if (typeof entry.kind !== 'string' || !KINDS.has(entry.kind)) throw historyFailure('历史类型无效')
  if (typeof entry.date !== 'string' || !Number.isFinite(Date.parse(entry.date)) || new Date(entry.date).toISOString() !== entry.date)
    throw historyFailure('历史时间无效')
  if (entry.beforeRevision !== null && (typeof entry.beforeRevision !== 'string' || !HISTORY_HASH.test(entry.beforeRevision)))
    throw historyFailure('历史前版本无效')
  if (typeof entry.afterRevision !== 'string' || !HISTORY_HASH.test(entry.afterRevision)) throw historyFailure('历史后版本无效')
  if (entry.kind === 'external' && entry.author !== UNKNOWN_AUTHOR) throw historyFailure('外部修改不可归属于当前用户')
  return Object.freeze({ ...entry }) as unknown as RevisionEntry
}
export function serializeHistoryEntry(entry: RevisionEntry): Buffer {
  validateHistoryEntry(entry)
  const bytes = Buffer.from(JSON.stringify({ schema: 1, entry }), 'utf8')
  if (bytes.length > HISTORY_RECORD_LIMIT) throw historyFailure('历史记录过大')
  return bytes
}
