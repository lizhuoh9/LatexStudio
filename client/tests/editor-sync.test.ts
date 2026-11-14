/// <reference lib="dom" />
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorBuffer } from '../src/renderer/editor-model'
import type { WorkspaceApi } from '../src/shared/workspace-contracts'
import type { Documents } from '../src/renderer/documents'
import type { Dialogs } from '../src/renderer/dialogs'

const dom = vi.hoisted(() => ({
  handlers: new Map<string, () => void>(), nodes: new Map<string, { value: string; open: boolean; hidden: boolean; disabled: boolean; setAttribute: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; showModal: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn>; replaceChildren: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> }>()
}))
vi.mock('../src/renderer/dom', () => ({
  button: (id: string, handler: () => void) => dom.handlers.set(id, handler),
  element: (id: string) => {
    if (!dom.nodes.has(id)) dom.nodes.set(id, { value: '', open: true, hidden: true, disabled: false, setAttribute: vi.fn(), focus: vi.fn(), showModal: vi.fn(), addEventListener: vi.fn(), replaceChildren: vi.fn(), append: vi.fn() })
    return dom.nodes.get(id)
  },
  text: vi.fn(), listItem: (label: string, detail: string) => ({ label, detail })
}))
import { SyncPanel } from '../src/renderer/sync-panel'

let api: WorkspaceApi
let documents: Documents
let dialogs: Dialogs
let notify: (message: string) => void
let pending: Promise<void>
let panel: SyncPanel

beforeEach(() => {
  dom.handlers.clear(); dom.nodes.clear()
  const status = { connection: { owner: 'fixture', repository: 'paper', login: 'writer', url: 'https://github.com/fixture/paper' },
    changes: [{ path: 'main.tex', kind: 'modified' }], conflict: true, message: 'previous conflict' }
  api = { repository: vi.fn().mockResolvedValue(status), history: vi.fn().mockResolvedValue([]),
    revisions: vi.fn().mockResolvedValue([]), onEvent: vi.fn().mockReturnValue(vi.fn()),
    sync: vi.fn().mockResolvedValue({ message: 'safe retry completed', status }) } as unknown as WorkspaceApi
  const buffer = new EditorBuffer()
  buffer.load({ path: 'main.tex', content: 'original', revision: '1' })
  documents = { save: vi.fn().mockResolvedValue(true), buffer,
    refresh: vi.fn().mockResolvedValue(undefined) } as unknown as Documents
  dialogs = { confirm: vi.fn().mockResolvedValue(true) } as unknown as Dialogs
  notify = vi.fn(); pending = Promise.resolve()
  panel = new SyncPanel(api, documents, dialogs, (_label, action) => { pending = action() }, vi.fn(), notify)
})

describe('safe retries after a persisted synchronization conflict', () => {
  it('lets the backend re-check a stale conflict without force or alternate APIs', async () => {
    dom.handlers.get('cloud-sync')!(); await pending
    expect(dialogs.confirm).toHaveBeenCalledWith('确认同步这些本地文件？', expect.stringContaining('main.tex'))
    expect(api.sync).toHaveBeenCalledExactlyOnceWith('保存写作进展')
    expect(documents.refresh).toHaveBeenCalledWith(['main.tex'])
  })
  it('still blocks unsaved new typing even if a prior save returned success', async () => {
    documents.buffer.edit('new unsaved typing')
    dom.handlers.get('cloud-sync')!(); await pending
    expect(api.sync).not.toHaveBeenCalled(); expect(dialogs.confirm).not.toHaveBeenCalled()
  })
  it('does not synchronize when document conflict protection refuses to save', async () => {
    vi.mocked(documents.save).mockResolvedValue(false)
    dom.handlers.get('cloud-sync')!(); await pending
    expect(api.repository).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled()
  })
  it('loads shared versions while retaining independent local Git history', async () => {
    documents.project = { id: 'project', root: '/project', name: 'paper', files: [], defaultMain: null }
    dom.handlers.get('cloud-refresh')!(); await pending
    expect(api.history).toHaveBeenCalledOnce(); expect(api.revisions).toHaveBeenCalledOnce()
  })
  it('opens history inline instead of opening the account dialog, and can close it independently', async () => {
    documents.project = { id: 'project', root: '/project', name: 'paper', files: [], defaultMain: null }
    dom.handlers.get('cloud-open')!(); await vi.waitFor(() => expect(api.revisions).toHaveBeenCalledOnce())
    expect(dom.nodes.get('revision-panel')!.hidden).toBe(false)
    expect(dom.nodes.get('cloud-open')!.setAttribute).toHaveBeenCalledWith('aria-expanded', 'true')
    expect(dom.nodes.get('cloud-dialog')?.showModal).toBeUndefined()
    dom.handlers.get('revision-close')!(); expect(dom.nodes.get('revision-panel')!.hidden).toBe(true)
  })
  it('does not refresh hidden or closing history', () => {
    documents.project = { id: 'project', root: '/project', name: 'paper', files: [], defaultMain: null }
    panel.refreshVisible(); expect(api.history).not.toHaveBeenCalled()
    panel.setClosing(true); dom.handlers.get('cloud-open')!(); expect(api.history).not.toHaveBeenCalled()
  })
  it('clears history on project transition without reading or syncing an unopened panel', () => {
    documents.project = { id: 'b', root: '/b', name: 'paper-b', files: [], defaultMain: null }
    panel.projectChanged(); expect(dom.nodes.get('history-list')!.replaceChildren).toHaveBeenCalled()
    expect(api.history).not.toHaveBeenCalled(); expect(api.sync).not.toHaveBeenCalled()
  })
  it('preserves the filename confirmation cancellation before retrying', async () => {
    vi.mocked(dialogs.confirm).mockResolvedValue(false)
    dom.handlers.get('cloud-sync')!(); await pending
    expect(api.sync).not.toHaveBeenCalled()
  })
})
