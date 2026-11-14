import { AsyncLocalStorage } from 'node:async_hooks'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { code, failure, SafeProject } from './paths'

/** Persistent marker: never expire/steal a remote lock using clocks, heartbeats or local PIDs. */
export const PROJECT_WRITE_LOCK = '.paperstudio-write-lock'
export const WRITE_LOCK_WAIT_MS = 2000
const context = new AsyncLocalStorage<ReadonlySet<string>>()
const BUSY = '项目正由其他客户端保存，或上次写入未确认完成。请保留草稿后重试；如锁持续存在，须先停止所有客户端并备份项目，再由管理员人工恢复写锁。'
const LOST = '项目写锁或连接状态已变化，无法确认安全保存；请保留草稿并重新读取比较，不要直接覆盖。'
interface Identity { ino: number; dev: number }
interface Lease { folder: string; owner: string; token: string; identity: Identity }

function same(a: Identity, b: Identity): boolean { return a.ino === b.ino && a.dev === b.dev }

async function acquire(project: SafeProject): Promise<Lease> {
  const folder = join(project.root, PROJECT_WRITE_LOCK), started = Date.now()
  for (;;) {
    await project.verifyRoot()
    try { await mkdir(folder, { mode: 0o700 }); break } catch (error) {
      if (code(error) !== 'EEXIST') throw failure(`无法取得项目写锁，未确认保存；请保留草稿。${error instanceof Error ? error.message : ''}`)
      const info = await lstat(folder).catch((cause: unknown) => { if (code(cause) !== 'ENOENT') throw cause; return null })
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw failure(LOST)
      if (Date.now() - started >= WRITE_LOCK_WAIT_MS) throw failure(BUSY)
      await delay(40)
    }
  }
  // Any uncertain creation/metadata failure leaves the marker in place, never an unsafe auto-unlock.
  await project.verifyRoot()
  const info = await lstat(folder)
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure(LOST)
  const lease = { folder, owner: join(folder, 'owner.json'), token: randomUUID(), identity: { ino: info.ino, dev: info.dev } }
  const handle = await open(lease.owner, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify({ schema: 1, token: lease.token })); await handle.sync() }
  finally { await handle.close() }
  await verify(project, lease)
  return lease
}

async function verify(project: SafeProject, lease: Lease): Promise<void> {
  await project.verifyRoot()
  const info = await lstat(lease.folder)
  if (!info.isDirectory() || info.isSymbolicLink() || !same(info, lease.identity)) throw failure(LOST)
  const handle = await open(lease.owner, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat(), current = await lstat(lease.owner)
    if (!before.isFile() || before.size > 256 || current.isSymbolicLink() || !same(before, current)) throw failure(LOST)
    const bytes = Buffer.alloc(257), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as { schema?: unknown; token?: unknown }
    if (value.schema !== 1 || value.token !== lease.token) throw failure(LOST)
  } finally { await handle.close() }
}

async function release(project: SafeProject, lease: Lease): Promise<void> {
  await verify(project, lease)
  await unlink(lease.owner)
  // Non-recursive only: never delete a replacement lock or unknown files during recovery.
  await rmdir(lease.folder)
}

/** Cooperative cross-process/NAS transaction. Await every operation; hooks must not reacquire this lock. */
export async function withProjectWriteLock<T>(project: SafeProject, action: () => Promise<T>): Promise<T> {
  if (context.getStore()?.has(project.root)) throw failure('项目写事务不能嵌套；请在已有写锁内完成历史与文件操作。')
  const lease = await acquire(project)
  let primary: unknown, failed = false, result: T | undefined
  try {
    const roots = new Set(context.getStore()); roots.add(project.root)
    result = await context.run(roots, action)
    await verify(project, lease)
  } catch (error) { failed = true; primary = error }
  try { await release(project, lease) } catch (error) {
    const message = `写锁释放未确认，不能确认保存成功。${LOST}`
    if (failed) throw new AggregateError([primary, error], `${primary instanceof Error ? primary.message : '保存失败'}；${message}`)
    throw new AggregateError([error], message)
  }
  if (failed) throw primary
  return result as T
}
