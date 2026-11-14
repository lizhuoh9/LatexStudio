import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { assertPrivateDirectory, hashFile } from './manifest'
import { mapVerification } from './verification'

/**
 * Pinned TeX packages that TinyTeX lacks (ctex, xeCJK, zhnumber, gbt7714; TeX Live containers verified against
 * texlive.tlpdb SHA-512). Installed as install/texmf-paperstudio, which the sandbox helper adds to TEXINPUTS and
 * BSTINPUTS. Excluded from the TinyTeX tree pin and verified file by file against the pinned manifest instead.
 */
export const PACKAGE_TREE_DIR = 'texmf-paperstudio'
export const PACKAGE_MANIFEST_SHA256 = '03ccf4932b490f5335bb35e18635d25408390c18d1a507da97c1be03ffdd50ca'
const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_FILES = 2000
const PATH = /^(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/
const HASH = /^[a-f0-9]{64}$/

export interface PackageManifest { readonly files: Readonly<Record<string, string>> }

/** Packaged resources first, then development checkouts; bytes are always checked against the pinned manifest. */
export function packageSourceCandidates(): string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [resources ? join(resources, 'tex-packages') : '', resolve(__dirname, '../../resources/tex-packages'),
    resolve(__dirname, '../../../resources/tex-packages'), resolve(process.cwd(), 'resources/tex-packages')].filter(Boolean)
}

/** Reads the manifest only if its bytes match the pin, then validates every entry's path and hash shape. */
export async function readPackageManifest(sourceRoot: string, pin = PACKAGE_MANIFEST_SHA256): Promise<PackageManifest> {
  const path = join(sourceRoot, 'manifest.json'), info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error('TeX 宏包清单无效')
  const bytes = await readFile(path)
  if (createHash('sha256').update(bytes).digest('hex') !== pin) throw new Error('TeX 宏包清单与软件内置校验值不符')
  const value = JSON.parse(bytes.toString('utf8')) as { files?: unknown }
  const files = value.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('TeX 宏包清单无效')
  const entries = Object.entries(files as Record<string, unknown>)
  if (!entries.length || entries.length > MAX_FILES || entries.some(([name, hash]) =>
    !PATH.test(name) || name.split('/').some(part => part === '.' || part === '..') || typeof hash !== 'string' || !HASH.test(hash)))
    throw new Error('TeX 宏包清单条目无效')
  return Object.freeze({ files: Object.freeze(Object.fromEntries(entries)) as Record<string, string> })
}

export async function findPackageSource(candidates: string[] = packageSourceCandidates(), pin = PACKAGE_MANIFEST_SHA256): Promise<string> {
  for (const candidate of candidates) {
    try { await readPackageManifest(candidate, pin); return candidate } catch { /* try the next candidate */ }
  }
  throw new Error('TeX 中文宏包未随软件打包或校验不符；不会改用其他来源')
}

/** Copies only manifest-matching bytes into a fresh tree; the installed tree is then verified as a whole. */
export async function installPackageTree(installation: string, sourceRoot: string, signal?: AbortSignal,
  pin = PACKAGE_MANIFEST_SHA256): Promise<void> {
  const manifest = await readPackageManifest(sourceRoot, pin)
  const target = join(installation, PACKAGE_TREE_DIR)
  await mkdir(target, { mode: 0o700 })
  for (const [name, hash] of Object.entries(manifest.files)) {
    signal?.throwIfAborted()
    const from = join(sourceRoot, PACKAGE_TREE_DIR, ...name.split('/'))
    if (await hashFile(from, MAX_FILE_BYTES, signal) !== hash) throw new Error('TeX 宏包文件与清单不符；未安装')
    const to = join(target, ...name.split('/'))
    await mkdir(dirname(to), { recursive: true, mode: 0o700 })
    await copyFile(from, to, constants.COPYFILE_EXCL)
  }
  await verifyPackageTree(installation, manifest, signal)
}

async function listTree(root: string, directory: string, result: string[], signal?: AbortSignal): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  const metadata = await mapVerification(entries, async entry => {
    const path = join(directory, entry.name)
    return { path, info: await lstat(path) }
  }, signal)
  for (const { path, info } of metadata) {
    signal?.throwIfAborted()
    if (info.isSymbolicLink()) throw new Error('TeX 宏包目录不能包含链接')
    if (info.isDirectory()) await listTree(root, path, result, signal)
    else if (info.isFile()) result.push(relative(root, path).split(sep).join('/'))
    else throw new Error('TeX 宏包目录包含特殊文件')
    if (result.length > MAX_FILES) throw new Error('TeX 宏包目录文件过多')
  }
}

/** The installed tree must hold exactly the manifest's files with exactly the pinned bytes. */
export async function verifyPackageTree(installation: string, manifest: PackageManifest, signal?: AbortSignal): Promise<void> {
  const root = join(installation, PACKAGE_TREE_DIR)
  await assertPrivateDirectory(root)
  const found: string[] = []
  await listTree(root, root, found, signal)
  const expected = Object.keys(manifest.files).sort(), actual = found.sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]))
    throw new Error('TeX 宏包目录内容不符；请重新准备')
  await mapVerification(expected, async name => {
    if (await hashFile(join(root, ...name.split('/')), MAX_FILE_BYTES, signal) !== manifest.files[name])
      throw new Error('TeX 宏包文件校验失败；请重新准备')
  }, signal)
}
