import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Static regression definitions only; no browser, Node bridge or owner execution.
const source = (name: string): string => readFileSync(resolve('src/renderer', name), 'utf8')
const html = source('index.html')
const main = source('main.ts')
const panel = source('repository-transfer-panel.ts')
const model = source('repository-transfer-model.ts')

function transferMarkup(): string {
  return html.slice(html.indexOf('<section id="repository-transfer"'), html.indexOf('</section>', html.indexOf('<section id="repository-transfer"')))
}

describe('transfer controls stay reachable during ordinary busy operations', () => {
  it('keeps the control inside the modal and outside closed developer details', () => {
    const dialog = html.indexOf('<dialog id="cloud-dialog"')
    const transfer = html.indexOf('<section id="repository-transfer"')
    expect(transfer).toBeGreaterThan(dialog); expect(transfer).toBeLessThan(html.indexOf('<details id="developer-sync"'))
    expect(transferMarkup()).not.toContain('id="github-token"')
  })
  it('does not put cancellation or its entry point in the general busy lock', () => {
    for (const id of ['repository-transfer-cancel', 'repository-transfer-status', 'cloud-open']) {
      const start = html.indexOf(`id="${id}"`)
      expect(start).toBeGreaterThan(-1); expect(html.slice(start, html.indexOf('>', start))).not.toContain('data-lock')
    }
    expect(panel).not.toContain('RunAction'); expect(panel).not.toContain('this.run(')
  })
  it('states cancellation uncertainty rather than rollback, success or ordinary sync delivery', () => {
    expect(transferMarkup()).toContain('不保证回滚'); expect(transferMarkup()).toContain('不会撤回已生效修改')
    expect(transferMarkup()).toContain('实际登录、项目访问与传输状态分别显示')
    expect(transferMarkup()).toContain('未配置发布方 GitHub App 时，不会启用普通云端操作')
    expect(model).toContain('这不代表成功、连接清理已确认或修改已撤回')
    expect(panel).toContain("setAttribute('data-cancel-pending', String(this.model.requesting))")
    expect(model).not.toContain("this.offer({ ...this.latest, phase: 'cancelling' })")
  })
})

describe('typed feature detection and event wiring', () => {
  it('detects both methods and initializes with cached status only', () => {
    expect(panel).toContain("typeof api?.repositoryTransfer === 'function'")
    expect(panel).toContain("typeof api.cancelRepositoryTransfer === 'function'")
    expect(panel).toContain("void this.request('status')")
    expect(main).toContain('this.repositoryTransfer.initialize()')
    expect(panel).not.toMatch(/(?:connectGitHub|cloneProject|startLogin|setInterval|setTimeout|fetch)\s*\(/)
  })
  it('uses no-payload calls and consumes the event before files-changed fallthrough', () => {
    expect(panel).toContain('api.repositoryTransfer!()'); expect(panel).toContain('api.cancelRepositoryTransfer!()')
    expect(main.indexOf("if (event.kind === 'repository-transfer')")).toBeLessThan(main.indexOf('for (const path of event.paths)'))
    expect(main).toContain('this.repositoryTransfer.receive(event.state)')
  })
  it('preserves close/dirty handling and disposes without hidden cancellation', () => {
    expect(main).toContain('this.repositoryTransfer.setClosing(closing)')
    expect(main).toContain('this.api.acknowledgeClose(event.requestId, this.documents.buffer.dirty)')
    expect(main).toContain('this.documents.setClosing(closing)'); expect(main).toContain('this.collaboration.setClosing(closing)')
    expect(main).toContain('this.repositoryTransfer.dispose()')
    expect(panel.slice(panel.indexOf('  dispose():'))).not.toContain("this.request('cancel')")
  })
})

describe('prior inert and closing freeze source contracts', () => {
  it('remembers prior editor inert and cannot undo it on entry or finally', () => {
    expect(main).toContain('const previousInert = editorPanel.inert')
    expect(main).toContain('editorPanel.inert = previousInert || freeze || this.closing')
    expect(main).toContain('editorPanel.inert = this.closing || previousInert')
    expect(main).not.toContain("element('editor-panel').inert = false")
  })
  it('repairs the close restore snapshot when an operation finishes while frozen', () => {
    expect(main).toContain('if (this.closing && this.frozen.has(editorPanel)) this.frozen.set(editorPanel, previousInert)')
    expect(main).toContain("[document.body, element('editor-panel'), ...document.querySelectorAll<HTMLDialogElement>('dialog')]")
    expect(main).toContain('for (const [node, inert] of this.frozen) node.inert = inert')
  })
  it('does not introduce remote UI, logs, browser persistence or HTML injection', () => {
    expect(html).toContain("connect-src 'none'"); expect(html).toContain("frame-src 'none'")
    expect(panel + model).not.toMatch(/innerHTML|outerHTML|localStorage|sessionStorage|console\.|window\.open|value\.message/)
    expect(panel).toContain("text('repository-transfer-state', this.model.summary)")
  })
})
