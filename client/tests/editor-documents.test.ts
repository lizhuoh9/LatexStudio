import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Documents, type DocumentUi } from '../src/renderer/documents'
import type { DocumentSnapshot, ProjectInfo, WorkspaceApi } from '../src/shared/workspace-contracts'

const snapshot = { path: 'main.tex', content: 'original', revision: '1' }
const files = [{ path: 'main.tex', kind: 'text' as const, size: 8 }, { path: 'image.png', kind: 'binary' as const, size: 12 }]
const project: ProjectInfo = { id: 'local', name: 'local', root: '/real/local', defaultMain: 'main.tex', files }
let api: WorkspaceApi
let ui: DocumentUi
let documents: Documents

beforeEach(async () => {
  api = { readFile: vi.fn().mockResolvedValue(snapshot), saveFile: vi.fn(), createFile: vi.fn(),
    files: vi.fn().mockResolvedValue([...files]), setDirty: vi.fn() } as unknown as WorkspaceApi
  ui = { show: vi.fn(), state: vi.fn(), files: vi.fn(), project: vi.fn(), notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true), input: vi.fn().mockResolvedValue('copy.tex') }
  documents = new Documents(api, ui)
  await documents.adopt({ ...project, files: [...files] })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('real workspace document API coordination', () => {
  it('opens the main file and propagates actual dirty state to main', () => {
    expect(api.readFile).toHaveBeenCalledWith('main.tex')
    documents.edited('draft'); expect(api.setDirty).toHaveBeenLastCalledWith(true)
    documents.edited('original'); expect(api.setDirty).toHaveBeenLastCalledWith(false)
  })
  it('uses the read revision as save CAS precondition', async () => {
    documents.edited('draft')
    vi.mocked(api.saveFile).mockResolvedValue({ ...snapshot, content: 'draft', revision: '2' })
    expect(await documents.save()).toBe(true)
    expect(api.saveFile).toHaveBeenCalledWith('main.tex', 'draft', '1')
    expect(api.setDirty).toHaveBeenLastCalledWith(false)
  })
  it('preserves new input arriving while saving and keeps close protection', async () => {
    documents.edited('sent')
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(api.saveFile).mockReturnValue(pending.promise)
    const save = documents.save(); documents.edited('newer')
    pending.resolve({ ...snapshot, content: 'sent', revision: '2' }); await save
    expect(documents.buffer.content).toBe('newer')
    expect(api.setDirty).toHaveBeenLastCalledWith(true)
  })
  it('does not clear dirty state or retry with a newer revision on a CAS error', async () => {
    documents.edited('draft'); vi.mocked(api.saveFile).mockRejectedValue(new Error('revision conflict'))
    await expect(documents.save()).rejects.toThrow('revision conflict')
    expect(documents.buffer.dirty).toBe(true); expect(documents.buffer.revision).toBe('1')
    expect(api.saveFile).toHaveBeenCalledTimes(1)
  })
  it('never replaces dirty content on files-changed', async () => {
    documents.edited('draft')
    vi.mocked(api.readFile).mockResolvedValue({ ...snapshot, content: 'external', revision: '2' })
    await documents.refresh(['main.tex'])
    expect(documents.buffer.content).toBe('draft')
    expect(documents.buffer.conflict).toBe(true)
    expect(await documents.save()).toBe(false); expect(api.saveFile).not.toHaveBeenCalled()
  })
})

describe('external file refresh and race handling', () => {
  it('refreshes a clean document from the filesystem API', async () => {
    vi.mocked(api.readFile).mockResolvedValue({ ...snapshot, content: 'external AI', revision: '2' })
    await documents.refresh(['main.tex'])
    expect(documents.buffer.content).toBe('external AI'); expect(documents.buffer.revision).toBe('2')
  })
  it('checks dirty state again after asynchronous external file reads', async () => {
    const pending = deferred<DocumentSnapshot>()
    vi.mocked(api.readFile).mockReturnValue(pending.promise)
    const refresh = documents.refresh(['main.tex'])
    await Promise.resolve(); documents.edited('typed while reading')
    pending.resolve({ ...snapshot, content: 'external', revision: '2' }); await refresh
    expect(documents.buffer.content).toBe('typed while reading')
    expect(documents.buffer.conflict).toBe(true)
    expect(await documents.save()).toBe(false)
  })
  it('preserves the visible content if the external file was removed', async () => {
    vi.mocked(api.files).mockResolvedValue([])
    await documents.refresh(['main.tex'])
    expect(documents.buffer.content).toBe('original'); expect(documents.buffer.conflict).toBe(true)
    expect(await documents.save()).toBe(false)
  })
  it.each([
    { kind: 'directory', dirty: false }, { kind: 'directory', dirty: true },
    { kind: 'binary', dirty: false }, { kind: 'binary', dirty: true }
  ] as const)('preserves content and exposes recovery after replacement by $kind (dirty=$dirty)', async ({ kind, dirty }) => {
    if (dirty) documents.edited('kept draft')
    const content = documents.buffer.content
    vi.mocked(api.files).mockResolvedValue([{ path: 'main.tex', kind, size: 0 }])
    vi.mocked(api.readFile).mockClear()
    await documents.refresh(['main.tex'])
    expect(api.readFile).not.toHaveBeenCalled()
    expect(documents.buffer.content).toBe(content); expect(documents.buffer.revision).toBe('1')
    expect(documents.buffer.dirty).toBe(dirty); expect(documents.buffer.conflict).toBe(true)
    expect(ui.state).toHaveBeenLastCalledWith(documents.buffer)
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('另存副本'))
    expect(await documents.save()).toBe(false); expect(api.saveFile).not.toHaveBeenCalled()
  })
  it('does not reload or retarget a missing file by basename after an external move', async () => {
    documents.edited('kept draft')
    vi.mocked(api.files).mockResolvedValue([{ path: 'paper/main.tex', kind: 'text', size: 8 }])
    await documents.refresh(['main.tex']); vi.mocked(api.readFile).mockClear(); vi.mocked(ui.confirm).mockClear()
    await documents.reload()
    expect(api.readFile).not.toHaveBeenCalled(); expect(ui.confirm).not.toHaveBeenCalled()
    expect(documents.buffer.path).toBe('main.tex'); expect(documents.buffer.content).toBe('kept draft')
    expect(documents.buffer.dirty).toBe(true); expect(documents.buffer.conflict).toBe(true)
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('原位置已不存在'))
  })
  it('handles a deletion between listing and reload without losing the visible content', async () => {
    vi.mocked(api.readFile).mockRejectedValue(new Error("ENOENT: lstat '/fixture/main.tex'"))
    await documents.reload()
    expect(documents.buffer.content).toBe('original'); expect(documents.buffer.revision).toBe('1')
    expect(documents.buffer.conflict).toBe(true)
    expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining('原位置已不存在'))
    expect(JSON.stringify(vi.mocked(ui.notify).mock.calls)).not.toContain('lstat')
  })
  it('preserves nested paths when reading a newly selected file', async () => {
    documents.project!.files.push({ path: 'paper/refs.bib', kind: 'text', size: 8 })
    vi.mocked(api.readFile).mockResolvedValue({ path: 'paper/refs.bib', content: 'nested', revision: '2' })
    await documents.open('paper/refs.bib')
    expect(api.readFile).toHaveBeenLastCalledWith('paper/refs.bib')
    expect(documents.buffer.path).toBe('paper/refs.bib')
  })
  it('cancels file changes when a user refuses to discard the draft', async () => {
    documents.project!.files.push({ path: 'chapter.tex', kind: 'text', size: 0 })
    documents.edited('draft'); vi.mocked(ui.confirm).mockResolvedValue(false)
    vi.mocked(api.readFile).mockClear(); await documents.open('chapter.tex')
    expect(api.readFile).not.toHaveBeenCalled(); expect(documents.buffer.path).toBe('main.tex')
  })
  it('does not decode binary attachments as editable text', async () => {
    vi.mocked(api.readFile).mockClear(); await documents.open('image.png')
    expect(api.readFile).not.toHaveBeenCalled(); expect(documents.buffer.path).toBe('main.tex')
  })
})

describe('draft copy recovery', () => {
  it('creates a copy before replacing a conflicted draft', async () => {
    documents.edited('kept draft'); documents.buffer.conflict = true
    vi.mocked(api.createFile).mockResolvedValue({ path: 'copy.tex', content: 'kept draft', revision: 'copy' })
    await documents.create(true)
    expect(api.createFile).toHaveBeenCalledWith('copy.tex', 'kept draft')
    expect(documents.buffer.path).toBe('copy.tex'); expect(documents.buffer.dirty).toBe(false)
  })
  it('retains the draft if creating a copy fails', async () => {
    documents.edited('kept draft'); vi.mocked(api.createFile).mockRejectedValue(new Error('exists'))
    await expect(documents.create(true)).rejects.toThrow('exists')
    expect(documents.buffer.content).toBe('kept draft'); expect(documents.buffer.dirty).toBe(true)
  })
})
