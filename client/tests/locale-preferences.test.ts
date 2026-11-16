import type { BrowserWindow } from 'electron'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale, type UiLocale } from '../src/shared/i18n'
import { isUiLocale, PREFERENCES_CHANNELS as C } from '../src/shared/locale-contracts'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const st = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => st.handlers.set(channel, handler) } }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) }
})
import { LocalePreferences, LocalePreferencesController } from '../src/main/workspace/locale'

const folders: string[] = []
async function folder(): Promise<string> {
  // Canonical fixture root avoids macOS /var -> /private/var aliases without weakening production checks.
  const root = await files.realpath(await files.mkdtemp(join(tmpdir(), 'paperstudio-language-')))
  folders.push(root); return root
}
const target = (root: string): string => join(root, 'ui-language.json')
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(files.rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(files.open).mockReset().mockImplementation(actual.open)
  st.handlers.clear(); setLocale('zh-CN')
})
afterEach(async () => {
  vi.restoreAllMocks(); setLocale('zh-CN')
  for (const root of folders.splice(0)) await files.rm(root, { recursive: true, force: true })
})

describe('bounded enum-only language persistence', () => {
  it('defaults missing state to Chinese without creating data or paper files', async () => {
    const parent = await folder(), root = join(parent, 'profile')
    expect(await new LocalePreferences(root).load()).toEqual({ locale: 'zh-CN' })
    expect(await files.readdir(parent)).toEqual([])
  })
  it.each(['zh-CN', 'en', 'ko'] as const)('round trips %s across fresh stores in a private small record', async locale => {
    const root = await folder(), store = new LocalePreferences(root)
    expect(await store.save(locale)).toEqual({ locale })
    expect(await new LocalePreferences(root).load()).toEqual({ locale })
    const body = await files.readFile(target(root), 'utf8'), info = await files.stat(target(root))
    expect(JSON.parse(body)).toEqual({ version: 1, locale }); expect(Buffer.byteLength(body)).toBeLessThanOrEqual(256)
    expect(info.nlink).toBe(1)
    if (process.platform !== 'win32') expect(info.mode & 0o077).toBe(0)
    expect(await files.readdir(root)).toEqual(['ui-language.json'])
  })
  it.each(['fr', 'EN', '', '../en', null, {}, ['en'], { locale: 'en', token: 'PRIVATE' }])('rejects non-enum input %j', async value => {
    const root = await folder(), store = new LocalePreferences(root)
    expect(isUiLocale(value)).toBe(false)
    await expect(store.save(value as UiLocale)).rejects.toThrow()
    expect(await files.readdir(root)).toEqual([])
  })
  it.each([
    Buffer.from('{broken'), Buffer.from([0xff, 0xfe]), Buffer.alloc(257, 'x'),
    Buffer.from('{"version":2,"locale":"en"}'), Buffer.from('{"version":1,"locale":"fr"}'),
    Buffer.from('{"version":1,"locale":"en","path":"PRIVATE"}'), Buffer.from('null')
  ])('preserves malformed metadata and gracefully uses Chinese', async bytes => {
    const root = await folder(), store = new LocalePreferences(root)
    await files.writeFile(target(root), bytes, { mode: 0o600 })
    expect(await store.load()).toEqual({ locale: 'zh-CN' })
    await expect(store.save('ko')).rejects.toThrow()
    expect(await files.readFile(target(root))).toEqual(bytes)
    expect(await files.readdir(root)).toEqual(['ui-language.json'])
  })
  it('preserves a directory where the fixed metadata file should be', async () => {
    const root = await folder(), store = new LocalePreferences(root)
    await files.mkdir(target(root)); await files.writeFile(join(target(root), 'keep.txt'), 'fixture')
    expect(await store.load()).toEqual({ locale: 'zh-CN' })
    await expect(store.save('en')).rejects.toThrow()
    expect(await files.readFile(join(target(root), 'keep.txt'), 'utf8')).toBe('fixture')
  })
  it('never follows or replaces a hardlinked record', async () => {
    const root = await folder(), store = new LocalePreferences(root)
    await store.save('en')
    const other = join(await folder(), 'other.json'); await files.link(target(root), other)
    const before = await files.readFile(other)
    expect(await store.load()).toEqual({ locale: 'zh-CN' })
    await expect(store.save('ko')).rejects.toThrow()
    expect(await files.readFile(other)).toEqual(before); expect((await files.stat(target(root))).nlink).toBe(2)
  })
  it.skipIf(process.platform === 'win32')('does not read or replace a symbolic-link record', async () => {
    const root = await folder(), other = join(await folder(), 'other.json')
    const before = '{"version":1,"locale":"en"}'
    await files.writeFile(other, before, { mode: 0o600 }); await files.symlink(other, target(root))
    const store = new LocalePreferences(root)
    expect(await store.load()).toEqual({ locale: 'zh-CN' })
    await expect(store.save('ko')).rejects.toThrow()
    expect((await files.lstat(target(root))).isSymbolicLink()).toBe(true)
    expect(await files.readFile(other, 'utf8')).toBe(before)
  })
  it('rejects a linked data directory without modifying its target', async () => {
    const root = await folder(), alias = join(await folder(), 'profile')
    await files.symlink(root, alias, 'junction')
    const store = new LocalePreferences(alias)
    expect(await store.load()).toEqual({ locale: 'zh-CN' })
    await expect(store.save('en')).rejects.toThrow(); expect(await files.readdir(root)).toEqual([])
  })
  it('pins data-directory identity and leaves a replacement root untouched', async () => {
    const parent = await folder(), root = join(parent, 'profile'), moved = join(parent, 'old-profile')
    const store = new LocalePreferences(root); await store.save('en')
    await files.rename(root, moved); await files.mkdir(root)
    await expect(store.save('ko')).rejects.toThrow()
    expect(await files.readdir(root)).toEqual([])
    expect(await new LocalePreferences(moved).load()).toEqual({ locale: 'en' })
  })
  it('keeps prior state, removes only its own temp file, and hides raw IO errors on failed publication', async () => {
    const root = await folder(), store = new LocalePreferences(root); await store.save('en')
    const before = await files.readFile(target(root))
    vi.mocked(files.rename).mockRejectedValueOnce(new Error('PRIVATE provider path'))
    const error = await store.save('ko').catch((cause: unknown) => cause)
    expect(String(error)).not.toContain('PRIVATE')
    expect(await files.readFile(target(root))).toEqual(before)
    expect(await store.load()).toEqual({ locale: 'en' }); expect(await files.readdir(root)).toEqual(['ui-language.json'])
  })
  it('serializes preference writes and does not retain a rejected queue item', async () => {
    const root = await folder(), store = new LocalePreferences(root)
    await Promise.all([store.save('en'), store.save('ko'), store.save('zh-CN')])
    expect(await store.load()).toEqual({ locale: 'zh-CN' })
    vi.mocked(files.rename).mockRejectedValueOnce(new Error('fixture failure'))
    await expect(store.save('ko')).rejects.toThrow()
    expect(await store.save('en')).toEqual({ locale: 'en' })
  })
  it('does not publish after an external edit observed before rename', async () => {
    const root = await folder(), store = new LocalePreferences(root); await store.save('en')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const external = '{"version":1,"locale":"zh-CN"}'
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]).includes('.paperstudio-language-')) await files.writeFile(target(root), external)
      return handle
    })
    await expect(store.save('ko')).rejects.toThrow()
    expect(await files.readFile(target(root), 'utf8')).toBe(external)
    expect(await files.readdir(root)).toEqual(['ui-language.json'])
  })
})

function controllerFixture() {
  const frame = { url: 'file:///app/workspace.html' }, send = vi.fn(), changed = vi.fn()
  const save = vi.fn(async (locale: UiLocale) => ({ locale }))
  let destroyed = false
  const window = { isDestroyed: () => destroyed, webContents: { id: 7, mainFrame: frame, send } } as unknown as BrowserWindow
  const controller = new LocalePreferencesController(window, frame.url, { save }, changed)
  controller.register()
  const event = { sender: { id: 7 }, senderFrame: frame }
  const invoke = (channel: string, args: unknown[] = [], sender: unknown = event): Promise<unknown> =>
    Promise.resolve().then(() => st.handlers.get(channel)!(sender, ...args))
  return { controller, save, send, changed, frame, event, invoke, destroy: () => { destroyed = true } }
}

describe('trusted locale-only IPC and close drain', () => {
  it('returns enum-only state and publishes after persistence and shared locale update', async () => {
    const f = controllerFixture()
    expect(await f.invoke(C.get)).toEqual({ locale: 'zh-CN' })
    expect(await f.invoke(C.set, ['ko'])).toEqual({ locale: 'ko' })
    expect(getLocale()).toBe('ko'); expect(f.changed).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledExactlyOnceWith(C.changed, { locale: 'ko' })
  })
  it('rejects all extra arguments and non-enum payloads without accessing storage', async () => {
    const f = controllerFixture()
    for (const args of [[], ['en', 'extra'], [{ locale: 'en' }], ['../path'], [null], ['fr']]) {
      await expect(f.invoke(C.set, args)).rejects.toThrow()
    }
    await expect(f.invoke(C.get, ['extra'])).rejects.toThrow()
    expect(f.save).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  })
  it('rejects wrong sender, subframe, URL, and destroyed windows for reads and writes', async () => {
    const f = controllerFixture()
    for (const event of [
      { ...f.event, sender: { id: 9 } }, { ...f.event, senderFrame: { url: f.frame.url } },
      { ...f.event, senderFrame: null }
    ]) {
      await expect(f.invoke(C.get, [], event)).rejects.toThrow()
      await expect(f.invoke(C.set, ['en'], event)).rejects.toThrow()
    }
    f.frame.url = 'https://example.invalid/'
    await expect(f.invoke(C.get)).rejects.toThrow(); await expect(f.invoke(C.set, ['en'])).rejects.toThrow()
    f.destroy(); await expect(f.invoke(C.get)).rejects.toThrow()
    expect(f.save).not.toHaveBeenCalled()
  })
  it('keeps the old language and emits no change when disk persistence fails', async () => {
    const f = controllerFixture(); f.save.mockRejectedValueOnce(new Error('PRIVATE IO path'))
    const error = await f.invoke(C.set, ['en']).catch((cause: unknown) => cause)
    expect(String(error)).not.toContain('PRIVATE'); expect(getLocale()).toBe('zh-CN')
    expect(f.changed).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
    expect(await f.invoke(C.set, ['ko'])).toEqual({ locale: 'ko' })
  })
  it('drains admitted writes, rejects new writes during close, and resumes after canceled close', async () => {
    const f = controllerFixture()
    let release!: () => void
    f.save.mockImplementationOnce(async locale => { await new Promise<void>(resolve => { release = resolve }); return { locale } })
    const first = f.invoke(C.set, ['en'])
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce())
    expect(getLocale()).toBe('zh-CN'); expect(f.send).not.toHaveBeenCalled()
    let drained = false
    const closing = f.controller.blockAndWait().then(() => { drained = true })
    await expect(f.invoke(C.set, ['ko'])).rejects.toThrow(); expect(drained).toBe(false)
    release(); await first; await closing; expect(drained).toBe(true)
    f.controller.resumeActions()
    expect(await f.invoke(C.set, ['ko'])).toEqual({ locale: 'ko' })
  })
  it('rechecks frame trust when queued work begins, rather than inheriting earlier authority', async () => {
    const f = controllerFixture()
    let release!: () => void
    f.save.mockImplementationOnce(async locale => { await new Promise<void>(resolve => { release = resolve }); return { locale } })
    const first = f.invoke(C.set, ['en'])
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledOnce())
    const second = f.invoke(C.set, ['ko'])
    await Promise.resolve(); f.frame.url = 'file:///app/other.html'; release()
    await first; await expect(second).rejects.toThrow(); expect(f.save).toHaveBeenCalledOnce()
  })
})
