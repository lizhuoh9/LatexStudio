import type { ProjectInfo } from '../shared/workspace-contracts'

/** Main has already committed this workspace. Preview teardown is not project authority. */
export async function adoptCommittedProject(project: ProjectInfo, clearPreview: () => Promise<void>,
  adopt: (project: ProjectInfo) => Promise<void>, notify: (message: string) => void): Promise<void> {
  let previewFailed = false
  try { await clearPreview() } catch { previewFailed = true }
  await adopt(project)
  if (previewFailed) notify('PDF 预览未能重置；项目已打开，请保存后重新启动软件。')
}
