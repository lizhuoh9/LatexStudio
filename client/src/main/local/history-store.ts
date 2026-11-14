import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { code, digest, LIMITS, SafeProject } from './paths'
import { HISTORY_HASH, HISTORY_ID, HISTORY_RECORD_LIMIT, historyFailure } from './history-validation'

type Bucket = 'objects' | 'entries' | 'pending'
export interface HistoryBudget { maxBytes: number; maxEntries: number }
export class HistoryStore {
  readonly project: SafeProject
  private readonly base: string
  constructor(root: string, private readonly budget: HistoryBudget) {
    this.project = new SafeProject(root)
    this.base = join(this.project.root, '.paperstudio', 'history-v1')
  }
  async initialize(create: boolean): Promise<boolean> {
    await this.project.verifyRoot()
    for (const path of [join(this.project.root, '.paperstudio'), this.base, ...['objects', 'entries', 'pending'].map(x => join(this.base, x))]) {
      if (create) await mkdir(path).catch(error => { if (code(error) !== 'EEXIST') throw error })
      try {
        const info = await lstat(path)
        if (!info.isDirectory() || info.isSymbolicLink()) throw historyFailure('历史目录不是安全的真实目录')
        const canonical = await realpath(path)
        if (canonical !== join(await realpath(this.project.root), ...path.slice(this.project.root.length + 1).split(/[\\/]/)))
          throw historyFailure('历史目录被重定向')
      } catch (error) {
        if (!create && code(error) === 'ENOENT') {
          if (path === this.base || path === join(this.project.root, '.paperstudio')) return false
          throw historyFailure('历史目录不完整，已拒绝忽略旧版本')
        }
        throw error
      }
    }
    return true
  }
  async names(bucket: Bucket): Promise<string[]> {
    const names = await readdir(join(this.base, bucket))
    if (names.length > this.budget.maxEntries * 2 + 2) throw historyFailure('历史目录项超过限额')
    const pattern = bucket === 'objects' ? HISTORY_HASH : /^[a-f0-9-]+\.json$/
    for (const name of names) {
      if (!pattern.test(name) || (bucket !== 'objects' && !HISTORY_ID.test(name.slice(0, -5))))
        throw historyFailure('历史目录中存在未知或损坏的条目')
    }
    return names.sort()
  }
  async read(bucket: Bucket, name: string): Promise<Buffer> {
    await this.initialize(false)
    const target = this.target(bucket, name), info = await lstat(target)
    const limit = bucket === 'objects' ? LIMITS.text : HISTORY_RECORD_LIMIT
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit)
      throw historyFailure('历史文件类型、链接数或大小无效')
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await handle.stat()
      if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw historyFailure('历史读取发生变化')
      const bytes = Buffer.alloc(info.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat(), current = await lstat(target)
      if (bytesRead !== info.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() || current.nlink !== 1)
        throw historyFailure('历史读取发生变化')
      if (bucket === 'objects' && digest(bytes.subarray(0, bytesRead)) !== name) throw historyFailure('历史内容哈希不匹配')
      return bytes.subarray(0, bytesRead)
    } finally { await handle.close() }
  }
  async put(bucket: Bucket, name: string, bytes: Buffer): Promise<void> {
    await this.initialize(true)
    const target = this.target(bucket, name)
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error
      if (!(await this.read(bucket, name)).equals(bytes)) throw historyFailure('历史文件已有不同内容')
    }
    if (!(await this.read(bucket, name)).equals(bytes)) throw historyFailure('历史写入校验失败')
  }
  async removePending(id: string): Promise<void> {
    await this.read('pending', `${id}.json`)
    await unlink(this.target('pending', `${id}.json`))
  }
  async publish(id: string): Promise<void> {
    const bytes = await this.read('pending', `${id}.json`)
    try {
      const current = await this.read('entries', `${id}.json`)
      if (!current.equals(bytes)) throw historyFailure('历史编号冲突')
      await this.removePending(id)
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error
      await rename(this.target('pending', `${id}.json`), this.target('entries', `${id}.json`))
      if (!(await this.read('entries', `${id}.json`)).equals(bytes)) throw historyFailure('历史提交校验失败')
    }
  }
  async ensureBudget(extraBytes: number, extraRecords: number, extraObjects: number): Promise<void> {
    let total = 0, records = 0, objects = 0
    for (const bucket of ['objects', 'entries', 'pending'] as const) {
      const names = await this.names(bucket)
      if (bucket === 'objects') objects = names.length
      else records += names.length
      for (const name of names) {
        const info = await lstat(this.target(bucket, name))
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw historyFailure('历史包含链接或特殊文件')
        total += info.size
      }
    }
    if (total + extraBytes > this.budget.maxBytes || records + extraRecords > this.budget.maxEntries || objects + extraObjects > this.budget.maxEntries * 2)
      throw historyFailure('历史空间或版本数量已满，请备份项目历史后再处理；不会自动删除旧版本')
  }
  private target(bucket: Bucket, name: string): string {
    if (bucket === 'objects' ? !HISTORY_HASH.test(name) : !name.endsWith('.json') || !HISTORY_ID.test(name.slice(0, -5)))
      throw historyFailure('历史文件名无效')
    return join(this.base, bucket, name)
  }
}
