import { expect, it, vi } from 'vitest'
import { adoptCommittedProject } from '../src/renderer/adopt-committed-project'
import type { ProjectInfo } from '../src/shared/workspace-contracts'

const project: ProjectInfo = { id: 'committed', name: 'joined', root: '/fixture/joined', files: [], defaultMain: null }
it('adopts a Main-committed workspace after preview teardown without another download or selection', async () => {
  const order: string[] = [], notify = vi.fn()
  await adoptCommittedProject(project, async () => { order.push('preview') }, async next => {
    expect(next).toBe(project); order.push('adopt')
  }, notify)
  expect(order).toEqual(['preview', 'adopt']); expect(notify).not.toHaveBeenCalled()
})
it('does not leave Renderer on the previous workspace when PDF destruction rejects', async () => {
  const adopt = vi.fn(async (_project: ProjectInfo) => undefined), notify = vi.fn()
  await adoptCommittedProject(project, async () => { throw new Error('private diagnostic must not appear') }, adopt, notify)
  expect(adopt).toHaveBeenCalledExactlyOnceWith(project)
  expect(notify).toHaveBeenCalledExactlyOnceWith('PDF 预览未能重置；项目已打开，请保存后重新启动软件。')
  expect(JSON.stringify(notify.mock.calls)).not.toContain('private diagnostic')
})
it('still propagates genuine document-adoption failure instead of claiming workspace success', async () => {
  const failure = new Error('document could not be adopted'), notify = vi.fn()
  await expect(adoptCommittedProject(project, async () => undefined, async () => { throw failure }, notify)).rejects.toBe(failure)
  expect(notify).not.toHaveBeenCalled()
})
