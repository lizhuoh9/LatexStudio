/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Documents, type DocumentUi } from '../src/renderer/documents'
import type { DocumentSnapshot, RevisionDetail, WorkspaceApi, WorkspaceEvent } from '../src/shared/workspace-contracts'
import type { Dialogs } from '../src/renderer/dialogs'

interface NodeMock {
  value: string; disabled: boolean; hidden: boolean; textContent: string; children: NodeMock[]
  tagName: string; className: string; type: string; title: string; dateTime: string
  dataset: Record<string, string>; attributes: Map<string, string>; listeners: Map<string, () => void>
  addEventListener(name: string, handler: () => void): void
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void; scrollIntoView(): void; focus(): void
  append(...nodes: NodeMock[]): void
  replaceChildren(...nodes: NodeMock[]): void
  click(): void
}
const dom = vi.hoisted(() => {
  const nodes = new Map<string, NodeMock>(), handlers = new Map<string, () => void>()
  const make = (tagName = 'div'): NodeMock => {
    let ownText = ''
    return { value: '', disabled: false, hidden: false, tagName, className: '', type: '', title: '', dateTime: '',
      children: [], dataset: {}, attributes: new Map(), listeners: new Map(),
      get textContent() { return ownText + this.children.map(node => node.textContent).join('') },
      set textContent(value: string) { ownText = value; this.children = [] },
      addEventListener(name, handler) { this.listeners.set(name, handler) },
      setAttribute(name, value) { this.attributes.set(name, value); if (name === 'title') this.title = value },
      removeAttribute(name) { this.attributes.delete(name) }, scrollIntoView() {}, focus() {},
      append(...children) { this.children.push(...children) },
      replaceChildren(...children) { this.children = children },
      click() { if (!this.disabled) this.listeners.get('click')?.() } }
  }
  const get = (id: string): NodeMock => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id)! }
  return { nodes, handlers, make, get }
})
vi.mock('../src/renderer/dom', () => ({ element: dom.get, button: (id: string, handler: () => void) => dom.handlers.set(id, handler),
  text: (id: string, value: string) => { dom.get(id).textContent = value } }))
import { VersionPanel } from '../src/renderer/version-panel'
import { historyLines } from '../src/renderer/history-comparison'

let api: WorkspaceApi, docs: Documents, dialogs: Dialogs, panel: VersionPanel
let pending: Promise<void>, receive: (event: WorkspaceEvent) => void, disk: DocumentSnapshot
let detail: RevisionDetail
const runs: Array<{ label: string; freeze?: boolean }> = []
const notify = vi.fn()
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
beforeEach(async () => {
  dom.nodes.clear(); dom.handlers.clear(); runs.length = 0; notify.mockClear()
  vi.stubGlobal('document', { createElement: dom.make })
  disk = { path: 'main.tex', content: 'current', revision: 'current-revision' }
  detail = { entry: { id: 'version-1', path: 'main.tex', author: 'alice', date: '2026-11-13', kind: 'save',
    summary: 'Changed introduction', beforeRevision: 'before', afterRevision: 'after' }, before: 'old\nline', after: 'restored\nline' }
  api = { revisions: vi.fn(async () => [detail.entry]), revisionDetail: vi.fn(async () => detail),
    restoreRevision: vi.fn(async () => { disk = { ...disk, content: detail.after, revision: 'restored-revision' }; return disk }),
    readFile: vi.fn(async () => ({ ...disk })), files: vi.fn(async () => [{ path: 'main.tex', kind: 'text', size: 7 }]),
    saveFile: vi.fn(async (path: string, content: string) => { disk = { path, content, revision: 'saved-draft' }; return { ...disk } }),
    setDirty: vi.fn(), onEvent: vi.fn((handler: (event: WorkspaceEvent) => void) => { receive = handler; return vi.fn() }) } as unknown as WorkspaceApi
  const ui: DocumentUi = { show: vi.fn(), state: vi.fn(), files: vi.fn(), project: vi.fn(), notify,
    confirm: vi.fn().mockResolvedValue(false), input: vi.fn() }
  docs = new Documents(api, ui)
  await docs.adopt({ id: 'paper', root: '/paper', name: 'paper', files: [{ path: 'main.tex', kind: 'text', size: 7 }], defaultMain: 'main.tex' })
  dialogs = { confirm: vi.fn().mockResolvedValue(true) } as unknown as Dialogs
  pending = Promise.resolve()
  panel = new VersionPanel(api, docs, dialogs, (label, action, freeze) => { runs.push({ label, freeze }); pending = action() }, notify)
})
afterEach(() => vi.unstubAllGlobals())
async function click(id: string): Promise<void> { dom.handlers.get(id)!(); await pending }
function revisionButton(id = detail.entry.id): NodeMock {
  const found = dom.get('revision-list').children.map(row => row.children[0]).find(node => node?.dataset.revisionId === id)
  if (!found) throw new Error(`Missing timeline button: ${id}`)
  return found
}
function descendants(node: NodeMock): NodeMock[] { return node.children.flatMap(child => [child, ...descendants(child)]) }
async function choose(id = detail.entry.id): Promise<void> { revisionButton(id).click(); await pending }
async function select(): Promise<void> { await panel.refresh(); await choose() }

describe('shared file versions and bounded text-only comparisons', () => {
  it('lists author/path/action/date without interpreting project content as HTML', async () => {
    detail.entry.author = '<img src=x>'; detail.after = '<script>alert(1)</script>'
    await select()
    const row = revisionButton(), fields = descendants(row)
    expect(row.type).toBe('button'); expect(row.attributes.get('aria-current')).toBe('true')
    expect(row.attributes.get('aria-pressed')).toBe('true')
    expect(fields.find(node => node.className === 'revision-path')?.textContent).toBe('main.tex')
    expect(fields.find(node => node.className === 'revision-kind')?.textContent).toBe('保存修改')
    expect(fields.find(node => node.className === 'revision-author')?.textContent).toBe('<img src=x>')
    expect(fields.find(node => node.className === 'revision-summary')?.textContent).toBe('Changed introduction')
    expect(row.title).toContain('OS 显示名，未经认证')
    expect(dom.get('history-source').textContent).toContain(detail.after)
    expect(dom.get('history-source')).not.toHaveProperty('innerHTML')
  })
  it('labels external edits as unknown even when an author field is present', async () => {
    detail.entry.kind = 'external'; detail.entry.author = 'untrusted attribution'
    await select()
    expect(dom.get('revision-description').textContent).toContain('作者未知（无法溯源）')
    expect(dom.get('revision-list').children[0]?.textContent).not.toContain('untrusted attribution')
  })
  it('identifies Git entries as commit authors rather than authenticated editors', async () => {
    detail.entry.id = 'git:abc:main.tex'
    await select()
    expect(dom.get('revision-description').textContent).toContain('提交作者：alice')
    expect(revisionButton().title).toContain('非逐次编辑来源')
    expect(descendants(revisionButton()).find(node => node.className === 'revision-author')?.textContent).toBe('提交 · alice')
  })
  it('bounds long display comparisons without changing stored content', () => {
    const large = historyLines('a\n'.repeat(5000), 'b'.repeat(140000))
    expect(large.truncated).toBe(true); expect(large.rows.length).toBeLessThanOrEqual(2400)
  })
  it('summarizes an initial snapshot without automatically showing its entire document', async () => {
    detail.before = null; detail.after = 'whole document\n'.repeat(408); await select()
    expect(dom.get('revision-diff-summary').textContent).toContain('初始记录')
    expect(descendants(dom.get('history-source')).filter(node => node.className.includes('history-line-added'))).toHaveLength(0)
    expect(dom.get('history-source').textContent).toContain('whole document')
  })
  it('clears selected contents on explicit refresh and limits the rendered list', async () => {
    await select()
    vi.mocked(api.revisions).mockResolvedValue(Array.from({ length: 350 }, (_, index) => ({ ...detail.entry, id: `v-${index}` })))
    await panel.refresh()
    expect(dom.get('history-source').textContent).toBe(''); expect(dom.get('revision-restore').disabled).toBe(true)
    expect(dom.get('revision-list').children).toHaveLength(300); expect(dom.get('revision-status').textContent).toContain('仅显示前 300 条')
  })
})

describe('native timeline order, selection and project reset', () => {
  it('keeps narrow timeline and comparison styles scoped to the inline history aside', () => {
    const css = readFileSync('src/renderer/version-panel-style.css', 'utf8')
    expect(css).toContain('#revision-panel .revision-entry[aria-current="true"]')
    expect(css).toContain('#revision-panel #revision-list'); expect(css).toContain('overflow: auto')
    expect(css).toContain('flex: 1'); expect(css).toContain('background: #185c3b')
    expect(css).not.toMatch(/\.workspace|\.files-panel|@import|url\(/)
    for (const rule of css.split('}').filter(value => value.includes('{'))) {
      expect(rule.slice(0, rule.indexOf('{')).replace(/\/\*[\s\S]*?\*\//g, '').trim().startsWith('#revision-panel')).toBe(true)
    }
  })
  it('orders timestamped entries newest first without auto-selecting or mutating backend data', async () => {
    const entries = [{ ...detail.entry, id: 'old', date: '2026-11-12T08:00:00Z' },
      { ...detail.entry, id: 'new', date: '2026-11-14T09:30:00Z', author: 'bob', path: 'chapter.tex', kind: 'create' as const, summary: 'New chapter' },
      { ...detail.entry, id: 'unknown-time', date: 'unavailable' }]
    vi.mocked(api.revisions).mockResolvedValue(entries); await panel.refresh()
    expect(dom.get('revision-list').children.map(row => row.children[0]?.dataset.revisionId)).toEqual(['new', 'old', 'unknown-time'])
    const fields = descendants(revisionButton('new'))
    expect(fields.find(node => node.tagName === 'time')?.dateTime).toBe('2026-11-14T09:30:00Z')
    expect(fields.find(node => node.className === 'revision-author')?.textContent).toBe('bob')
    expect(fields.find(node => node.className === 'revision-path')?.textContent).toBe('chapter.tex')
    expect(fields.find(node => node.className === 'revision-kind')?.textContent).toBe('创建')
    expect(fields.find(node => node.className === 'revision-summary')?.textContent).toBe('New chapter')
    expect(entries[0]?.id).toBe('old'); expect(api.revisionDetail).not.toHaveBeenCalled()
    expect(revisionButton('new').attributes.get('aria-pressed')).toBe('false')
  })
  it('uses native buttons and marks only the explicitly chosen version', async () => {
    const other = { ...detail.entry, id: 'other-version' }
    vi.mocked(api.revisions).mockResolvedValue([detail.entry, other])
    vi.mocked(api.revisionDetail).mockImplementation(async id => ({ ...detail, entry: id === other.id ? other : detail.entry }))
    await panel.refresh(); await choose(); await choose(other.id)
    expect(revisionButton().attributes.get('aria-current')).toBe('false')
    expect(revisionButton(other.id).attributes.get('aria-current')).toBe('true')
    expect(revisionButton(other.id).type).toBe('button'); expect(revisionButton(other.id).attributes.has('role')).toBe(false)
  })
  it('clears a switched project synchronously without requests, draft mutation or stale row actions', async () => {
    await select(); const oldButton = revisionButton(), draft = docs.buffer.content
    vi.mocked(api.revisions).mockClear(); vi.mocked(api.revisionDetail).mockClear()
    docs.project = { ...docs.project!, id: 'next-paper' }; panel.projectChanged()
    expect(dom.get('revision-list').children).toHaveLength(0); expect(dom.get('history-source').textContent).toBe('')
    expect(dom.get('revision-restore').disabled).toBe(true); expect(docs.buffer.content).toBe(draft)
    oldButton.click(); await pending
    expect(api.revisions).not.toHaveBeenCalled(); expect(api.revisionDetail).not.toHaveBeenCalled(); expect(api.restoreRevision).not.toHaveBeenCalled()
  })
  it('invalidates a late list reply when projectChanged clears the old project', async () => {
    const request = deferred<RevisionDetail['entry'][]>(); vi.mocked(api.revisions).mockReturnValue(request.promise)
    const reading = panel.refresh(); docs.project = { ...docs.project!, id: 'next-paper' }; panel.projectChanged()
    request.resolve([detail.entry]); await reading
    expect(dom.get('revision-list').children).toHaveLength(0); expect(dom.get('revision-description').textContent).toBe('')
    expect(dom.get('revision-restore').disabled).toBe(true)
  })
  it('disables native timeline actions during closing and resumes without auto-loading details', async () => {
    await select(); vi.mocked(api.revisionDetail).mockClear(); const row = revisionButton()
    receive({ kind: 'close-request', requestId: 'close' }); expect(row.disabled).toBe(true); row.click(); await pending
    expect(api.revisionDetail).not.toHaveBeenCalled()
    receive({ kind: 'close-state', closing: false }); expect(row.disabled).toBe(false)
    expect(row.attributes.get('aria-pressed')).toBe('false'); expect(dom.get('history-source').textContent).toBe('')
  })
})

describe('reference History file selection, comparison range and leaving without edits', () => {
  async function setupRange(): Promise<RevisionDetail> {
    const older = { ...detail, entry: { ...detail.entry, id: 'older', date: '2026-11-12' }, after: 'baseline' }
    vi.mocked(api.revisions).mockResolvedValue([detail.entry, older.entry, { ...older.entry, id: 'other-file', path: 'chapter.tex' }])
    vi.mocked(api.revisionDetail).mockImplementation(async id => id === 'older' ? older : detail)
    await select(); return older
  }
  async function from(id: string): Promise<void> { dom.get('revision-from').value = id; dom.get('revision-from').listeners.get('change')!(); await pending }
  it('compares older same-file snapshots while restoring only the selected target version', async () => {
    const older = await setupRange(); await from(older.entry.id)
    expect(dom.get('history-source').textContent).toContain('baseline')
    expect(dom.get('revision-from').children.map(option => option.value)).toEqual(['', 'older'])
    await click('revision-restore'); expect(api.restoreRevision).toHaveBeenCalledWith(detail.entry.id, 'current-revision')
  })
  it('never reads a forged or different-file range and disables stale restore intent', async () => {
    await setupRange(); vi.mocked(api.revisionDetail).mockClear(); await from('other-file')
    expect(api.revisionDetail).not.toHaveBeenCalled(); expect(dom.get('revision-restore').disabled).toBe(true)
  })
  it('rejects mismatched range replies and drops responses after leaving History', async () => {
    await setupRange(); vi.mocked(api.revisionDetail).mockResolvedValue({ ...detail, entry: { ...detail.entry, id: 'older', path: 'forged.tex' } })
    await expect(from('older')).rejects.toThrow('不一致'); expect(dom.get('revision-restore').disabled).toBe(true)
    await setupRange(); const request = deferred<RevisionDetail>(); vi.mocked(api.revisionDetail).mockReturnValue(request.promise)
    dom.get('revision-from').value = 'older'; dom.get('revision-from').listeners.get('change')!(); panel.exit(); request.resolve(detail); await pending
    expect(dom.get('history-source').textContent).toBe(''); expect(dom.get('revision-restore').disabled).toBe(true)
  })
  it('filters historical file entries without loading another editor file or accepting detached timeline buttons', async () => {
    await setupRange(); const stale = revisionButton(); vi.mocked(api.revisionDetail).mockClear(); vi.mocked(api.readFile).mockClear()
    const file = dom.get('revision-files').children.map(row => row.children[0]).find(node => node?.textContent === 'chapter.tex')!
    file.click(); stale.click(); await pending
    expect(dom.get('revision-list').children.map(row => row.children[0]?.dataset.revisionId)).toEqual(['other-file'])
    expect(api.revisionDetail).not.toHaveBeenCalled(); expect(api.readFile).not.toHaveBeenCalled(); expect(docs.buffer.path).toBe('main.tex')
  })
  it('leaves and disposes without saving or dropping a live draft', async () => {
    await select(); docs.edited('unsaved draft'); panel.exit(); panel.dispose()
    expect(docs.buffer.content).toBe('unsaved draft'); expect(docs.buffer.dirty).toBe(true)
    expect(api.saveFile).not.toHaveBeenCalled(); expect(api.restoreRevision).not.toHaveBeenCalled(); expect(dom.get('revision-restore').disabled).toBe(true)
  })
})

describe('file-only restoration retains drafts and fresh CAS intent', () => {
  it('reads the current target revision, confirms one file and refreshes Documents', async () => {
    await select(); vi.mocked(api.readFile).mockClear()
    await click('revision-restore')
    expect(runs.at(-1)?.freeze).toBe(true)
    expect(api.readFile).toHaveBeenCalledWith('main.tex')
    expect(dialogs.confirm).toHaveBeenCalledWith('仅回退此文件至所选版本？', expect.stringContaining('不回退整个项目'))
    expect(api.restoreRevision).toHaveBeenCalledExactlyOnceWith('version-1', 'current-revision')
    expect(docs.buffer.content).toBe('restored\nline'); expect(docs.buffer.dirty).toBe(false)
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('其他文件未回退'))
  })
  it('saves a dirty draft before restoring and passes the saved current revision', async () => {
    await select(); docs.edited('my draft')
    await click('revision-restore')
    expect(api.saveFile).toHaveBeenCalledWith('main.tex', 'my draft', 'current-revision')
    expect(api.restoreRevision).toHaveBeenCalledWith('version-1', 'saved-draft')
  })
  it('keeps a dirty draft when the save-first prompt is canceled', async () => {
    await select(); docs.edited('my draft'); vi.mocked(dialogs.confirm).mockResolvedValue(false)
    await click('revision-restore')
    expect(api.saveFile).not.toHaveBeenCalled(); expect(api.restoreRevision).not.toHaveBeenCalled()
    expect(docs.buffer.content).toBe('my draft'); expect(docs.buffer.dirty).toBe(true)
  })
  it('refuses to restore if document conflict protection prevents saving', async () => {
    await select(); docs.edited('conflicting draft'); docs.buffer.conflict = true
    await click('revision-restore')
    expect(api.restoreRevision).not.toHaveBeenCalled(); expect(docs.buffer.content).toBe('conflicting draft')
  })
  it('does not discard typing arriving while a previous draft save is pending', async () => {
    await select(); docs.edited('draft'); const saved = deferred<DocumentSnapshot>()
    vi.mocked(api.saveFile).mockReturnValue(saved.promise)
    dom.handlers.get('revision-restore')!(); await Promise.resolve(); await Promise.resolve()
    docs.edited('newer typing'); saved.resolve({ path: 'main.tex', content: 'draft', revision: 'saved' }); await pending
    expect(api.restoreRevision).not.toHaveBeenCalled(); expect(docs.buffer.content).toBe('newer typing')
  })
  it('cancels after the file-only confirmation without calling the backend', async () => {
    await select(); vi.mocked(dialogs.confirm).mockResolvedValue(false)
    await click('revision-restore'); expect(api.restoreRevision).not.toHaveBeenCalled()
  })
  it('rejects a backend CAS/native-confirm failure without reloading or losing the buffer', async () => {
    await select(); vi.mocked(api.restoreRevision).mockRejectedValue(new Error('文件已变化或取消确认'))
    await expect(click('revision-restore')).rejects.toThrow('文件已变化')
    expect(docs.buffer.content).toBe('current'); expect(docs.buffer.revision).toBe('current-revision')
  })
  it('restores only the selected target even when a different file is in the editor', async () => {
    detail.entry.path = 'chapter.tex'; await select()
    await click('revision-restore')
    expect(api.readFile).toHaveBeenCalledWith('chapter.tex')
    expect(api.restoreRevision).toHaveBeenCalledExactlyOnceWith('version-1', 'current-revision')
  })
})

describe('late reads, project changes and close handshakes', () => {
  it('drops late detail results after switching project identity', async () => {
    await panel.refresh(); const request = deferred<RevisionDetail>(); vi.mocked(api.revisionDetail).mockReturnValue(request.promise)
    revisionButton().click()
    docs.project = { ...docs.project! }; request.resolve(detail); await pending
    expect(dom.get('history-source').textContent).toBe(''); expect(dom.get('revision-restore').disabled).toBe(true)
  })
  it('drops a late history reply during close and does not automatically reload after thaw', async () => {
    const request = deferred<RevisionDetail['entry'][]>(); vi.mocked(api.revisions).mockReturnValue(request.promise)
    const refresh = panel.refresh(); receive({ kind: 'close-request', requestId: 'close' })
    request.resolve([detail.entry]); await refresh
    receive({ kind: 'close-state', closing: false })
    expect(dom.get('revision-list').children).toHaveLength(0); expect(api.revisions).toHaveBeenCalledOnce()
  })
  it('does not restore after a close request invalidates an outstanding confirmation', async () => {
    await select(); const confirm = deferred<boolean>(); vi.mocked(dialogs.confirm).mockReturnValue(confirm.promise)
    dom.handlers.get('revision-restore')!(); await Promise.resolve()
    receive({ kind: 'close-request', requestId: 'close' }); confirm.resolve(true); await pending
    expect(api.restoreRevision).not.toHaveBeenCalled()
  })
  it('preserves new edits during confirmation and refuses a stale restore', async () => {
    await select(); const confirm = deferred<boolean>(); vi.mocked(dialogs.confirm).mockReturnValue(confirm.promise)
    dom.handlers.get('revision-restore')!(); await Promise.resolve()
    docs.edited('late draft'); confirm.resolve(true); await pending
    expect(api.restoreRevision).not.toHaveBeenCalled(); expect(docs.buffer.content).toBe('late draft')
  })
  it('refuses mismatched version details without enabling restore', async () => {
    await panel.refresh(); vi.mocked(api.revisionDetail).mockResolvedValue({ ...detail, entry: { ...detail.entry, path: 'other.tex' } })
    await expect(choose()).rejects.toThrow('不一致')
    expect(dom.get('revision-restore').disabled).toBe(true)
  })
})
