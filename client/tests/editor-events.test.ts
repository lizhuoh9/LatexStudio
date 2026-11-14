import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Documents, type DocumentUi } from '../src/renderer/documents'
import type { DocumentSnapshot, WorkspaceApi } from '../src/shared/workspace-contracts'

const original = { path: 'main.tex', content: 'original', revision: '1' }
const files = [{ path: 'main.tex', kind: 'text' as const, size: 8 }]
let api: WorkspaceApi
let ui: DocumentUi
let documents: Documents

beforeEach(async () => {
  api = { readFile: vi.fn().mockResolvedValue(original), files: vi.fn().mockResolvedValue([...files]),
    saveFile: vi.fn(), setDirty: vi.fn() } as unknown as WorkspaceApi
  ui = { show: vi.fn(), state: vi.fn(), files: vi.fn(), project: vi.fn(), notify: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true), input: vi.fn() }
  documents = new Documents(api, ui)
  await documents.adopt({ id: 'fixture', name: 'fixture', root: '/fixture', files: [...files], defaultMain: 'main.tex' })
  vi.mocked(ui.show).mockClear(); vi.mocked(ui.files).mockClear()
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function saveDraft(): Promise<DocumentSnapshot> {
  const saved = { ...original, content: 'saved draft', revision: '2' }
  documents.edited(saved.content)
  vi.mocked(api.saveFile).mockResolvedValue(saved)
  await documents.save()
  vi.mocked(api.readFile).mockResolvedValue(saved)
  return saved
}

describe('acknowledged self-write watcher events', () => {
  it('does not reset editor state, cursor or undo history after a clean save', async () => {
    await saveDraft(); const version = documents.buffer.editVersion
    await documents.refresh(['main.tex'])
    expect(ui.show).not.toHaveBeenCalled(); expect(documents.buffer.editVersion).toBe(version)
    expect(documents.buffer.conflict).toBe(false)
  })
  it('keeps typing after save and permits another CAS save using the acknowledged baseline', async () => {
    await saveDraft(); documents.edited('newer typing')
    await documents.refresh(['main.tex'])
    expect(documents.buffer.conflict).toBe(false); expect(documents.buffer.content).toBe('newer typing')
    expect(ui.show).not.toHaveBeenCalled()
    vi.mocked(api.saveFile).mockResolvedValue({ ...original, content: 'newer typing', revision: '3' })
    expect(await documents.save()).toBe(true)
    expect(api.saveFile).toHaveBeenLastCalledWith('main.tex', 'newer typing', '2')
  })
  it('ignores a baseline event even when new typing arrives during the read', async () => {
    const saved = await saveDraft(); const pending = deferred<DocumentSnapshot>()
    vi.mocked(api.readFile).mockReturnValue(pending.promise)
    const refresh = documents.refresh(['main.tex'])
    await Promise.resolve(); documents.edited('typed during baseline read')
    pending.resolve(saved); await refresh
    expect(documents.buffer.conflict).toBe(false); expect(documents.buffer.dirty).toBe(true)
    expect(documents.buffer.content).toBe('typed during baseline read'); expect(ui.show).not.toHaveBeenCalled()
  })
  it('handles a root rescan event without resetting an unchanged document', async () => {
    await documents.refresh([''])
    expect(ui.show).not.toHaveBeenCalled(); expect(api.readFile).toHaveBeenLastCalledWith('main.tex')
  })
})

describe('real external writes remain protected', () => {
  it('still detects a different external revision after skipping a self-write event', async () => {
    await saveDraft(); documents.edited('new draft'); await documents.refresh(['main.tex'])
    vi.mocked(api.readFile).mockResolvedValue({ ...original, content: 'external', revision: '3' })
    await documents.refresh(['main.tex'])
    expect(documents.buffer.conflict).toBe(true); expect(documents.buffer.content).toBe('new draft')
    expect(await documents.save()).toBe(false); expect(ui.show).not.toHaveBeenCalled()
  })
  it('does not replace typing-and-undo activity with an asynchronous external read', async () => {
    const pending = deferred<DocumentSnapshot>(); vi.mocked(api.readFile).mockReturnValue(pending.promise)
    const refresh = documents.refresh(['main.tex'])
    await Promise.resolve(); documents.edited('typed'); documents.edited('original')
    pending.resolve({ ...original, content: 'external', revision: '2' }); await refresh
    expect(documents.buffer.content).toBe('original'); expect(documents.buffer.conflict).toBe(true)
  })
  it('clears a stale content conflict if disk genuinely returns to the exact CAS baseline', async () => {
    documents.edited('draft'); documents.buffer.conflict = true
    await documents.refresh(['main.tex'])
    expect(documents.buffer.conflict).toBe(false); expect(documents.buffer.content).toBe('draft')
    expect(documents.buffer.dirty).toBe(true); expect(ui.show).not.toHaveBeenCalled()
  })
})

describe('closing freezes pending external reads and edits', () => {
  it('does not start new reads or accept late edit callbacks while frozen', async () => {
    vi.mocked(api.files).mockClear(); documents.setClosing(true)
    documents.edited('late input'); await documents.refresh(['main.tex'])
    expect(api.files).not.toHaveBeenCalled(); expect(documents.buffer.content).toBe('original')
    documents.setClosing(false); documents.edited('resumed input')
    expect(documents.buffer.content).toBe('resumed input')
  })
  it('does not publish file lists that complete after the close handshake starts', async () => {
    const pending = deferred<typeof files>(); vi.mocked(api.files).mockReturnValue(pending.promise)
    const refresh = documents.refresh(['main.tex']); documents.setClosing(true)
    pending.resolve([]); await refresh
    expect(ui.files).not.toHaveBeenCalled(); expect(documents.project?.files).toEqual(files)
    documents.setClosing(false)
  })
  it('drops an in-flight external read while frozen and permits explicit rescan after cancellation', async () => {
    const pending = deferred<DocumentSnapshot>(); vi.mocked(api.readFile).mockReturnValue(pending.promise)
    const refresh = documents.refresh(['main.tex']); await Promise.resolve()
    documents.setClosing(true); pending.resolve({ ...original, content: 'external', revision: '2' }); await refresh
    expect(documents.buffer.content).toBe('original'); expect(ui.show).not.toHaveBeenCalled()
    documents.setClosing(false)
    vi.mocked(api.readFile).mockResolvedValue({ ...original, content: 'external', revision: '2' })
    await documents.refresh(['main.tex']); expect(documents.buffer.content).toBe('external')
  })
})

describe('closing and asynchronous save acknowledgements', () => {
  it('does not publish a pending save baseline until a canceled close thaws the UI', async () => {
    documents.edited('sent'); const pending = deferred<DocumentSnapshot>()
    vi.mocked(api.saveFile).mockReturnValue(pending.promise)
    const save = documents.save(); documents.setClosing(true)
    pending.resolve({ ...original, content: 'sent', revision: '2' }); await Promise.resolve()
    expect(documents.buffer.revision).toBe('1'); expect(documents.buffer.dirty).toBe(true)
    documents.setClosing(false); await save
    expect(documents.buffer.revision).toBe('2'); expect(documents.buffer.dirty).toBe(false)
  })
  it('does not thaw a pending acknowledgement if another close starts immediately', async () => {
    documents.edited('sent'); const pending = deferred<DocumentSnapshot>()
    vi.mocked(api.saveFile).mockReturnValue(pending.promise)
    const save = documents.save(); documents.setClosing(true)
    pending.resolve({ ...original, content: 'sent', revision: '2' }); await Promise.resolve()
    documents.setClosing(false); documents.setClosing(true); await Promise.resolve()
    expect(documents.buffer.revision).toBe('1')
    documents.setClosing(false); await save; expect(documents.buffer.revision).toBe('2')
  })
})
