import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertPrivateDirectory, hashFile } from './manifest'

/**
 * Windows engines rebuilt from pinned TeX Live 2026.1 source plus reviewed kpathsea/XPDF safety patches
 * (resources/win32/tex-patches). They live in one overlay directory beside bin/windows, so the
 * verified TinyTeX tree stays byte-identical and kpathsea's SELFAUTO* layout is unchanged.
 */
export const PATCHED_ENGINE_DIR = 'bin/paperstudio-x64'
export interface PatchedEngine { readonly name: string; readonly source: string; readonly sha256: string }
// pdfTeX: clean XETEX=0 build with the XPDF null-state fix; other tools retain the accepted XETEX=1 bytes.
// All binaries import only Windows system DLLs; build-engines.sh records the reviewed source patches.
// fonts.conf is the app-authored fontconfig configuration the sandbox helper points XeTeX at (FONTCONFIG_FILE).
export const PATCHED_WINDOWS_ENGINES: ReadonlyArray<PatchedEngine> = Object.freeze([
  Object.freeze({ name: 'pdflatex.exe', source: 'pdftex.exe', sha256: '502ec6c709cd2f1edc97a18a3256fa2f8812b2d968127bfb61611b7fc85491f0' }),
  Object.freeze({ name: 'xelatex.exe', source: 'xetex.exe', sha256: '572b3dcdc7c61a45f7cd3d8e3bf73929fd5e39fdcfb537899984a02b32367e9b' }),
  Object.freeze({ name: 'xdvipdfmx.exe', source: 'xdvipdfmx.exe', sha256: '9f0e117122bbb2aa8ac63b7b431d2a496b0e168b551cea4992495d8bca8469cc' }),
  Object.freeze({ name: 'bibtex.exe', source: 'bibtex.exe', sha256: '48870f473e16fac1975ae7d8a6a5f431f3e9660dce9a5b9ef759f3ee1145d954' }),
  Object.freeze({ name: 'fonts.conf', source: 'fonts.conf', sha256: '24b0bf459ba9f256cce574012b7c5763f30d29867dda24654e3309ef77a2413f' })
])
const HASH = /^[a-f0-9]{64}$/
const MAX_ENGINE_BYTES = 64 * 1024 * 1024

function checkedPins(pins: ReadonlyArray<PatchedEngine>): ReadonlyArray<PatchedEngine> {
  if (!pins.length || pins.some(pin => !HASH.test(pin.sha256) || !/^[a-z0-9-]+\.(?:exe|conf)$/.test(pin.name)))
    throw new Error('此版本未附可信的补丁 TeX 引擎，已拒绝使用资源')
  return pins
}

/** Packaged resources first, then development checkouts. Never searches PATH or user TeX installs. */
export function patchedEngineSourceCandidates(): string[] {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [resources ? join(resources, 'win32', 'tex-engines') : '',
    resolve(__dirname, '../../resources/win32/tex-engines'),
    resolve(__dirname, '../../../resources/win32/tex-engines'),
    resolve(process.cwd(), 'resources/win32/tex-engines')].filter(Boolean)
}

/** Windows engines accepted for sandboxed compilation (both run from the pinned overlay). */
export const USABLE_WINDOWS_ENGINES = Object.freeze(['pdflatex', 'xelatex'] as const)

async function matchesPins(directory: string, pins: ReadonlyArray<PatchedEngine>, signal?: AbortSignal): Promise<boolean> {
  try {
    if (!(await lstat(directory)).isDirectory()) return false
    for (const engine of pins) {
      if (await hashFile(join(directory, engine.source), MAX_ENGINE_BYTES, signal) !== engine.sha256) return false
    }
    return true
  } catch (error) {
    if (signal?.aborted) throw error
    return false
  }
}

/** First candidate whose bytes match every pin (a stale packaged copy does not shadow a good one). */
export async function findPatchedEngineSource(candidates: string[] = patchedEngineSourceCandidates(),
  signal?: AbortSignal, pins: ReadonlyArray<PatchedEngine> = PATCHED_WINDOWS_ENGINES): Promise<string> {
  const engines = checkedPins(pins)
  for (const candidate of candidates) {
    if (await matchesPins(candidate, engines, signal)) return candidate
  }
  throw new Error('TeX 补丁引擎未随软件打包或校验不符；不会改用未修补的引擎')
}

/** Copies only pinned bytes into a fresh overlay directory; the copy is re-hashed after writing. */
export async function installPatchedEngines(installation: string, sourceDir: string, signal?: AbortSignal,
  pins: ReadonlyArray<PatchedEngine> = PATCHED_WINDOWS_ENGINES): Promise<void> {
  const engines = checkedPins(pins)
  for (const engine of engines) {
    if (await hashFile(join(sourceDir, engine.source), MAX_ENGINE_BYTES, signal) !== engine.sha256)
      throw new Error('TeX 补丁引擎与软件内置校验值不符；未安装')
  }
  const overlay = join(installation, ...PATCHED_ENGINE_DIR.split('/'))
  await mkdir(overlay, { mode: 0o700 })
  for (const engine of engines) {
    signal?.throwIfAborted()
    await copyFile(join(sourceDir, engine.source), join(overlay, engine.name), constants.COPYFILE_EXCL)
  }
  await verifyPatchedEngines(installation, signal, engines)
}

/** The overlay must hold exactly the pinned regular files: no extra, missing, linked or changed entry. */
export async function verifyPatchedEngines(installation: string, signal?: AbortSignal,
  pins: ReadonlyArray<PatchedEngine> = PATCHED_WINDOWS_ENGINES): Promise<void> {
  const engines = checkedPins(pins)
  const overlay = join(installation, ...PATCHED_ENGINE_DIR.split('/'))
  await assertPrivateDirectory(overlay)
  const entries = await readdir(overlay)
  const expected = engines.map(engine => engine.name).sort()
  if (entries.length !== expected.length || [...entries].sort().some((name, index) => name !== expected[index]))
    throw new Error('TeX 补丁引擎目录内容不符；请重新准备')
  for (const engine of engines) {
    signal?.throwIfAborted()
    const path = join(overlay, engine.name), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || await hashFile(path, MAX_ENGINE_BYTES, signal) !== engine.sha256)
      throw new Error('TeX 补丁引擎校验失败；请重新准备')
  }
}
