import { constants, type Stats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ReadonlyProjectAccess } from '../collaboration/project-access'
import { checkedLogin, checkedTarget } from './remote-policy'
import { githubTarget, GitHubError, safeBranch } from './policy'

/** Secret-free routing metadata, never an authorization capability or stored credential. */
export interface CloudBinding { projectId: number; owner: string; name: string; branch: string; accountId: number }
const NAME = 'paperstudio-app.json', MAX_BYTES = 2048
const invalid = (): GitHubError => new GitHubError('普通协作关联无法安全读取；本地历史仍保留，请重新确认项目。')
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const equal = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino
const directory = (value: Stats): boolean => value.isDirectory() && !value.isSymbolicLink()

function checked(value: unknown): CloudBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const data = value as Record<string, unknown>, keys = ['projectId', 'owner', 'name', 'branch', 'accountId']
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) throw invalid()
  if (!Number.isSafeInteger(data.projectId) || (data.projectId as number) <= 0 ||
    !Number.isSafeInteger(data.accountId) || (data.accountId as number) <= 0 ||
    typeof data.owner !== 'string' || typeof data.name !== 'string' || typeof data.branch !== 'string') throw invalid()
  const target = githubTarget(`https://github.com/${data.owner}/${data.name}.git`)
  if (target.owner !== data.owner || target.repository !== data.name) throw invalid()
  return { projectId: data.projectId as number, owner: target.owner, name: target.repository,
    branch: safeBranch(data.branch), accountId: data.accountId as number }
}

async function directories(root: string): Promise<{ root: Stats; git: Stats }> {
  const parent = await lstat(root), git = await lstat(join(root, '.git'))
  if (!directory(parent) || !directory(git)) throw invalid()
  return { root: parent, git }
}
async function verify(root: string, before: Awaited<ReturnType<typeof directories>>): Promise<void> {
  const after = await directories(root)
  if (!equal(before.root, after.root) || !equal(before.git, after.git)) throw invalid()
}

export function cloudBindingForAccess(access: ReadonlyProjectAccess): CloudBinding {
  access.check()
  const target = checkedTarget(access.target), project = access.project
  if (!checkedLogin(access.account.login) || target.owner !== project.owner || target.repository !== project.name) throw invalid()
  const value = checked({ projectId: project.id, owner: project.owner, name: project.name,
    branch: access.branch, accountId: access.account.id })
  access.check()
  return value
}
export function assertCloudAccess(binding: CloudBinding, access: ReadonlyProjectAccess): void {
  const fresh = cloudBindingForAccess(access)
  if ((Object.keys(fresh) as Array<keyof CloudBinding>).some(key => fresh[key] !== binding[key])) throw invalid()
}

export async function readCloudBinding(root: string): Promise<CloudBinding | null> {
  const parent = await lstat(root)
  if (!directory(parent)) throw invalid()
  let before: Awaited<ReturnType<typeof directories>>
  try { before = await directories(root) } catch (error) {
    if (!missing(error)) throw invalid()
    if (!equal(parent, await lstat(root))) throw invalid()
    // A missing .git is an unbound local folder; a linked/invalid .git never is.
    try { await lstat(join(root, '.git')) } catch (absent) { if (missing(absent)) return null; throw invalid() }
    throw invalid()
  }
  const path = join(root, '.git', NAME)
  let stat: Stats
  try { stat = await lstat(path) } catch (error) {
    if (!missing(error)) throw invalid()
    await verify(root, before); return null
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw invalid()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat(), buffer = Buffer.alloc(MAX_BYTES + 1)
    if (!equal(stat, opened) || !opened.isFile() || opened.nlink !== 1) throw invalid()
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_BYTES || bytesRead !== opened.size) throw invalid()
    const value = checked(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))))
    const current = await lstat(path)
    if (!equal(stat, current) || current.isSymbolicLink() || current.nlink !== 1 || current.size !== bytesRead) throw invalid()
    await verify(root, before)
    return value
  } catch { throw invalid() } finally { await handle.close() }
}

export async function writeCloudBinding(root: string, binding: CloudBinding): Promise<void> {
  const value = checked(binding), before = await directories(root)
  await readCloudBinding(root)
  const path = join(root, '.git', NAME), temporary = `${path}.${randomUUID()}.tmp`
  let created = false
  try {
    const handle = await open(temporary, 'wx', 0o600); created = true
    try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() } finally { await handle.close() }
    await verify(root, before)
    await rename(temporary, path); created = false
    await verify(root, before)
  } finally { if (created) { await verify(root, before); await unlink(temporary) } }
}

export async function removeCloudBinding(root: string): Promise<void> {
  if (!await readCloudBinding(root)) return
  const before = await directories(root)
  await verify(root, before)
  await unlink(join(root, '.git', NAME))
  await verify(root, before)
}
