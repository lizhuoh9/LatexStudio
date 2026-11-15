/// <reference lib="dom" />
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorBuffer } from '../src/renderer/editor-model'
import type { WorkspaceApi } from '../src/shared/workspace-contracts'
import type { Documents } from '../src/renderer/documents'
import type { Dialogs } from '../src/renderer/dialogs'

interface NodeMock { value: string; open: boolean; addEventListener: ReturnType<typeof vi.fn>;
  replaceChildren: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> }
const dom = vi.hoisted(() => ({ handlers: new Map<string, () => void>(), nodes: new Map<string, NodeMock>(), text: vi.fn() }))
vi.mock('../src/renderer/history-comparison', () => ({ HistoryComparison: class {
  clear = vi.fn(); dispose = vi.fn(); move = vi.fn()
  show = vi.fn(() => ({ added: 0, removed: 0, initial: false, truncated: false }))
} }))
vi.mock('../src/renderer/dom', () => ({
  button: (id: string, handler: () => void) => dom.handlers.set(id, handler), text: dom.text,
  element: (id: string) => {
    if (!dom.nodes.has(id)) dom.nodes.set(id, { value: '', open: false, addEventListener: vi.fn(), replaceChildren: vi.fn(), append: vi.fn() })
    return dom.nodes.get(id)
  }, listItem: (label: string) => ({ label })
}))
import { SyncPanel } from '../src/renderer/sync-panel'
let api: WorkspaceApi
let panel: SyncPanel
let pending: Promise<void>
let notify: (message: string) => void
beforeEach(() => {
  vi.stubGlobal('document', { body: { dataset: {} }, addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelector: vi.fn() })
  dom.handlers.clear(); dom.nodes.clear(); dom.text.mockClear(); pending = Promise.resolve(); notify = vi.fn()
  api = { repository: vi.fn().mockRejectedValue(new Error('fixture unavailable account transport')),
    history: vi.fn().mockResolvedValue([{ summary: 'local writing', author: 'fixture', date: 'fixture date' }]),
    revisions: vi.fn().mockResolvedValue([]), onEvent: vi.fn().mockReturnValue(vi.fn()),
    snapshot: vi.fn().mockResolvedValue({ summary: 'local writing' }), sync: vi.fn(), connectGitHub: vi.fn() } as unknown as WorkspaceApi
  const documents = { project: { id: 'local' }, buffer: new EditorBuffer(), save: vi.fn().mockResolvedValue(true) } as unknown as Documents
  panel = new SyncPanel(api, documents, {} as Dialogs, (_label, action) => { pending = action() }, vi.fn(), notify)
})

describe('ordinary cooperation does not require developer configuration', () => {
  it('loads local history without touching account or repository APIs', async () => {
    await panel.refresh()
    expect(api.history).toHaveBeenCalledOnce(); expect(api.repository).not.toHaveBeenCalled()
    expect(dom.nodes.get('history-list')!.replaceChildren).toHaveBeenCalled()
  })
  it('keeps local snapshots available without graphical sign-in', async () => {
    dom.handlers.get('cloud-snapshot')!(); await pending
    expect(api.snapshot).toHaveBeenCalledWith('保存写作进展'); expect(api.repository).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('已保存本地历史快照。')
  })
  it('still loads shared file versions when local Git snapshots fail', async () => {
    vi.mocked(api.history).mockRejectedValue(new Error('local Git unavailable'))
    await panel.refresh()
    expect(api.revisions).toHaveBeenCalledOnce()
    expect(dom.nodes.get('history-list')!.replaceChildren).toHaveBeenCalledWith({ label: '本机 Git 快照读取失败，可重试。' })
  })
  it('retains local snapshots and developer status if shared versions fail', async () => {
    vi.mocked(api.revisions).mockRejectedValue(new Error('shared history unavailable'))
    dom.nodes.get('developer-sync')!.open = true
    await panel.refresh()
    expect(api.history).toHaveBeenCalledOnce(); expect(api.repository).toHaveBeenCalledOnce()
    expect(dom.text).toHaveBeenCalledWith('revision-status', expect.stringContaining('历史读取失败'))
  })
  it('does not trigger hidden manual sync or authentication when details is closed', async () => {
    dom.handlers.get('cloud-sync')!(); await pending
    dom.handlers.get('cloud-connect')!(); await pending
    expect(api.sync).not.toHaveBeenCalled(); expect(api.connectGitHub).not.toHaveBeenCalled()
  })
  it('does not lose already loaded history if developer status fails', async () => {
    dom.nodes.get('developer-sync')!.open = true
    await panel.refresh()
    expect(api.history).toHaveBeenCalledOnce(); expect(api.repository).toHaveBeenCalledOnce()
    expect(dom.text).toHaveBeenCalledWith('cloud-status', expect.stringContaining('本地历史已单独加载'))
  })
})

describe('ordinary markup advertises only delivered boundaries', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8')
  it('keeps manual URL/PAT and sync inside explicitly closed developer details', () => {
    const start = html.indexOf('<details id="developer-sync"')
    const end = html.indexOf('</details>', start)
    expect(html.slice(start, html.indexOf('>', start))).not.toContain(' open')
    for (const id of ['github-url', 'github-token', 'cloud-sync']) {
      expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(start)
      expect(html.indexOf(`id="${id}"`)).toBeLessThan(end)
    }
    expect(html).toContain('开发者调试（旧 PAT 适配器）')
  })
  it('does not fake ordinary login, compile readiness or disk-space acceptance', () => {
    expect(html).toContain('id="collaboration-state" class="collaboration-state" role="status" aria-live="polite"')
    expect(html).toContain('id="collaboration-error" class="collaboration-error" role="alert" hidden')
    expect(html).toContain('id="cloud-project-workspace"')
    const panel = readFileSync('src/renderer/collaboration-panel.ts', 'utf8')
    expect(panel).toContain("state.phase === 'unconfigured'")
    expect(panel).toContain("return 'GitHub 登录未配置'")
    expect(html).not.toContain('已成功登录')
    for (const obsolete of ['约 247 MB', '约 3 GB', '基础候选', 'Windows / macOS 原生桌面方向', 'setup-space']) {
      expect(html).not.toContain(obsolete)
    }
    expect(html).toContain('id="setup-prepare" disabled hidden>重试配置')
    expect(html).toContain('id="setup-native-detail" class="setup-error" role="alert" hidden')
    const main = readFileSync('src/renderer/main.ts', 'utf8')
    expect(main).toContain('return this.setup.verified && this.environment?.available === true')
    expect(main).toContain("element('environment-summary').hidden = notice.hidden")
    expect(html).not.toMatch(/id="(?:login|sign-in|share)-[^\"]*"/)
    expect(html).toContain("connect-src 'none'")
  })
})
