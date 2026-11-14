import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectService, type ProjectWrite } from '../src/main/local/project'
import { SafeProject } from '../src/main/local/paths'
import { PROJECT_WRITE_LOCK, withProjectWriteLock } from '../src/main/local/write-lock'

const folders: string[] = [], children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited
    }
  }
  // Fixture teardown only: all test clients are stopped, not production stale-lock recovery.
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true, maxRetries: 3 })
})
async function fixture(): Promise<{ root: string; project: SafeProject }> {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-write-lock-test-'))
  folders.push(root)
  await writeFile(join(root, 'main.tex'), 'original')
  const project = new SafeProject(root); await project.initialize()
  return { root, project }
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
interface WorkerMessage { kind: string; ok?: boolean; message?: string; content?: string }
function worker(root: string, content: string, hold = false): { child: ChildProcess; take: (kind: string) => Promise<WorkerMessage> } {
  const child = fork(fileURLToPath(new URL('./fixtures/save-worker.cjs', import.meta.url)), [root, content, hold ? 'hold' : ''],
    { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  children.push(child)
  const messages: WorkerMessage[] = [], listeners: (() => void)[] = []
  child.on('message', message => { messages.push(message as WorkerMessage); for (const listener of listeners.splice(0)) listener() })
  return { child, take: async kind => {
    for (;;) {
      const fatal = messages.find(message => message.kind === 'fatal')
      if (fatal) throw new Error(fatal.message)
      const index = messages.findIndex(message => message.kind === kind)
      if (index >= 0) return messages.splice(index, 1)[0]!
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('worker exited without ' + kind)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('worker timed out waiting for ' + kind)), 7000)
        listeners.push(() => { clearTimeout(timeout); resolve() })
      })
    }
  } }
}

describe('shared project write lock', () => {
  it('holds a persistent exclusive marker and removes only its own marker after completion', async () => {
    const { root, project } = await fixture()
    await withProjectWriteLock(project, async () => {
      expect((await lstat(join(root, PROJECT_WRITE_LOCK))).isDirectory()).toBe(true)
      expect(JSON.parse(await readFile(join(root, PROJECT_WRITE_LOCK, 'owner.json'), 'utf8'))).toMatchObject({ schema: 1 })
      expect((await project.list()).map(file => file.path)).toEqual(['main.tex'])
    })
    await expect(lstat(join(root, PROJECT_WRITE_LOCK))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never steals an old marker based on time or a foreign PID, and does not run the action', async () => {
    const { root, project } = await fixture(), lock = join(root, PROJECT_WRITE_LOCK)
    await mkdir(lock)
    const marker = '{"schema":1,"token":"foreign","pid":99999999,"created":0}'
    await writeFile(join(lock, 'owner.json'), marker)
    let called = false
    await expect(withProjectWriteLock(project, async () => { called = true })).rejects.toThrow('所有客户端')
    expect(called).toBe(false)
    expect(await readFile(join(lock, 'owner.json'), 'utf8')).toBe(marker)
  })
  it('rejects linked markers without reading or deleting the destination', async () => {
    const { root, project } = await fixture(), outside = await fixture()
    await symlink(outside.root, join(root, PROJECT_WRITE_LOCK), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(withProjectWriteLock(project, async () => undefined)).rejects.toThrow('写锁')
    expect(await readFile(join(outside.root, 'main.tex'), 'utf8')).toBe('original')
  })
  it('fails closed when ownership changes and never deletes a replacement owner', async () => {
    const { root, project } = await fixture()
    const owner = join(root, PROJECT_WRITE_LOCK, 'owner.json')
    await expect(withProjectWriteLock(project, async () => {
      await writeFile(owner, '{"schema":1,"token":"replacement"}')
      throw new Error('original transaction failure')
    })).rejects.toThrow(/original transaction failure.*释放未确认/)
    expect(await readFile(owner, 'utf8')).toContain('replacement')
  })
  it('rejects root redirection and preserves the old marker for explicit recovery', async () => {
    const { root, project } = await fixture(), moved = root + '-moved'
    folders.push(moved)
    await expect(withProjectWriteLock(project, async () => { await rename(root, moved); await mkdir(root) })).rejects.toThrow('释放未确认')
    expect((await lstat(join(moved, PROJECT_WRITE_LOCK))).isDirectory()).toBe(true)
    expect(await readdir(root)).toEqual([])
  })
  it('rejects nested acquisition promptly rather than deadlocking a history callback', async () => {
    const { project } = await fixture()
    await withProjectWriteLock(project, async () => {
      await expect(withProjectWriteLock(project, async () => undefined)).rejects.toThrow('不能嵌套')
    })
  })
})

describe('ProjectService cross-instance transactions', () => {
  it('keeps prepare, replacement, read-back and history commit under the same shared lock', async () => {
    const { root } = await fixture(), changes: ProjectWrite[] = [], events: string[] = []
    const service = new ProjectService(root, { beforeWrite: async (_, change) => {
      changes.push(change); events.push('prepare')
      expect((await lstat(join(root, PROJECT_WRITE_LOCK))).isDirectory()).toBe(true)
      return { commit: async () => {
        events.push('commit')
        expect(await readFile(join(root, change.path), 'utf8')).toBe(change.after.toString())
        expect((await lstat(join(root, PROJECT_WRITE_LOCK))).isDirectory()).toBe(true)
      }, abort: async () => { events.push('abort') } }
    } })
    const initial = await service.read('main.tex')
    await service.save('main.tex', 'restored', initial.revision, { kind: 'restore', summary: 'restore version' })
    await service.create('new.tex', 'new')
    expect(events).toEqual(['prepare', 'commit', 'prepare', 'commit'])
    expect(changes[0]).toMatchObject({ kind: 'restore', summary: 'restore version' })
    expect(changes[0]?.before?.toString()).toBe('original')
    expect(changes[1]?.before).toBeNull()
    expect(changes[1]?.kind).toBe('create')
    service.dispose()
  })
  it('forces the second instance to validate its revision after the first transaction finishes', async () => {
    const { root } = await fixture(), entered = deferred(), proceed = deferred()
    const a = new ProjectService(root, { beforeWrite: async () => { entered.resolve(); await proceed.promise } })
    const b = new ProjectService(root), revision = (await a.read('main.tex')).revision
    const first = a.save('main.tex', 'winner', revision)
    await entered.promise
    const second = b.save('main.tex', 'stale', revision)
    proceed.resolve()
    await expect(first).resolves.toMatchObject({ content: 'winner' })
    await expect(second).rejects.toThrow('保存冲突')
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('winner')
    a.dispose(); b.dispose()
  })
  it('does not report success if the acknowledgement/history commit fails after the write', async () => {
    const { root } = await fixture(), events: string[] = []
    const service = new ProjectService(root, { beforeWrite: async () => ({
      commit: async () => { events.push('commit'); throw new Error('simulated connection lost after rename') },
      abort: async () => { events.push('abort'); throw new Error('recovery also unavailable') }
    }) })
    const revision = (await service.read('main.tex')).revision
    await expect(service.save('main.tex', 'draft retained by caller', revision)).rejects.toThrow(/connection lost.*恢复未确认/)
    expect(events).toEqual(['commit', 'abort'])
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('draft retained by caller')
    // Reconnecting with the old draft revision never overwrites the already changed file.
    const reconnected = new ProjectService(root)
    await expect(reconnected.save('main.tex', 'blind retry', revision)).rejects.toThrow('保存冲突')
    service.dispose(); reconnected.dispose()
  })
  it('aborts the prepared receipt on a pre-write external conflict without losing the external edit', async () => {
    const { root } = await fixture(), events: string[] = []
    const service = new ProjectService(root, { beforeWrite: async () => {
      await writeFile(join(root, 'main.tex'), 'external')
      return { commit: async () => { events.push('commit') }, abort: async () => { events.push('abort') } }
    } })
    const revision = (await service.read('main.tex')).revision
    await expect(service.save('main.tex', 'draft', revision)).rejects.toThrow('修改')
    expect(events).toEqual(['abort'])
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('external')
    service.dispose()
  })
})

describe('real independent Node processes', () => {
  it('admits exactly one same-revision writer and reports a conflict to the other process', async () => {
    const { root } = await fixture(), a = worker(root, 'writer A', true), b = worker(root, 'writer B')
    await Promise.all([a.take('ready'), b.take('ready')])
    a.child.send({ kind: 'start' }); await a.take('prepared')
    b.child.send({ kind: 'start' }); a.child.send({ kind: 'release' })
    expect(await a.take('result')).toMatchObject({ ok: true, content: 'writer A' })
    expect(await b.take('result')).toMatchObject({ ok: false, message: expect.stringContaining('保存冲突') })
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('writer A')
  }, 15000)
  it('does not steal a crashed remote-equivalent process marker; retry keeps the original content', async () => {
    const { root } = await fixture(), holder = worker(root, 'must not be written', true)
    await holder.take('ready'); holder.child.send({ kind: 'start' }); await holder.take('prepared')
    const exited = once(holder.child, 'exit'); holder.child.kill(); await exited
    const marker = await readFile(join(root, PROJECT_WRITE_LOCK, 'owner.json'), 'utf8')
    const restarted = new ProjectService(root), revision = (await restarted.read('main.tex')).revision
    await expect(restarted.save('main.tex', 'retained draft', revision)).rejects.toThrow('所有客户端')
    expect(await readFile(join(root, 'main.tex'), 'utf8')).toBe('original')
    expect(await readFile(join(root, PROJECT_WRITE_LOCK, 'owner.json'), 'utf8')).toBe(marker)
    restarted.dispose()
  }, 15000)
})
