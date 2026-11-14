import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ body: 'fixed offline ZIP fixture bytes' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
// Small local fixture pins only: no 247 MB download, native program or production resource is used in these units.
vi.mock('../src/main/tex/manifest', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/tex/manifest')>()
  const { createHash } = await import('node:crypto')
  actual.TEX_ASSETS.win32.bytes = Buffer.byteLength(fixture.body)
  actual.TEX_ASSETS.win32.sha256 = createHash('sha256').update(fixture.body).digest('hex')
  return actual
})
vi.mock('../src/main/tex/download', () => ({ downloadTexAsset: vi.fn() }))
vi.mock('../src/main/tex/archive', () => ({ extractWindowsTexZip: vi.fn() }))
vi.mock('../src/main/tex/catalog', () => ({ verifyInstallationCatalog: vi.fn(async () => {}) }))
vi.mock('../src/main/tex/patched-engines', () => ({
  findPatchedEngineSource: vi.fn(async () => 'fixture-pinned-engines'), installPatchedEngines: vi.fn()
}))
vi.mock('../src/main/tex/package-tree', () => ({
  findPackageSource: vi.fn(async () => 'fixture-pinned-packages'), installPackageTree: vi.fn(async () => {})
}))
import { bundledTexArchiveCandidates, findBundledTexArchive } from '../src/main/tex/bundled-runtime'
import { downloadTexAsset } from '../src/main/tex/download'
import { extractWindowsTexZip } from '../src/main/tex/archive'
import { verifyInstallationCatalog } from '../src/main/tex/catalog'
import { installPatchedEngines } from '../src/main/tex/patched-engines'
import { installPackageTree } from '../src/main/tex/package-tree'
import { enginePaths, RUNTIME_MANIFEST, TEX_ASSETS } from '../src/main/tex/manifest'
import { prepareNativeTex } from '../src/main/tex/prepare'

const folders: string[] = []
const descriptors = new Map<string, PropertyDescriptor | undefined>()
let fetcher: ReturnType<typeof vi.fn>, resources: string
function processValue(name: string, value: unknown): void {
  if (!descriptors.has(name)) descriptors.set(name, Object.getOwnPropertyDescriptor(process, name))
  Object.defineProperty(process, name, { configurable: true, value })
}
async function folder(): Promise<string> {
  const path = await files.mkdtemp(join(tmpdir(), 'paperstudio-offline-tex-'))
  folders.push(path); return path
}
async function bundle(body = fixture.body): Promise<string> {
  const path = join(resources, 'tex-runtime', `${TEX_ASSETS.win32.sha256}.zip`)
  await files.mkdir(join(path, '..'), { recursive: true }); await files.writeFile(path, body)
  return path
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.mocked(files.open).mockReset()
  processValue('platform', 'win32'); resources = await folder(); processValue('resourcesPath', resources)
  fetcher = vi.fn(async () => { throw new Error('Network forbidden by offline fixture') })
  vi.stubGlobal('fetch', fetcher)
  vi.mocked(downloadTexAsset).mockImplementation(async () => { throw new Error('Unexpected legacy download') })
  vi.mocked(verifyInstallationCatalog).mockResolvedValue(undefined)
  vi.mocked(installPackageTree).mockResolvedValue(undefined)
  vi.mocked(extractWindowsTexZip).mockImplementation(async (_archive, installation) => {
    for (const path of ['texmf-var/web2c/pdftex/pdflatex.fmt', 'texmf-var/web2c/xetex/xelatex.fmt']) {
      await files.mkdir(join(installation, path, '..'), { recursive: true })
      await files.writeFile(join(installation, path), Buffer.alloc(1024))
    }
    return { entries: 2, bytes: 2048 }
  })
  vi.mocked(installPatchedEngines).mockImplementation(async installation => {
    for (const path of Object.values(enginePaths('win32'))) {
      const target = join(installation, path.slice('install/'.length))
      await files.mkdir(join(target, '..'), { recursive: true }); await files.writeFile(target, 'MZ fixture engine')
    }
  })
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(process, name, descriptor)
    else Reflect.deleteProperty(process, name)
  }
  descriptors.clear()
  for (const path of folders.splice(0)) await files.rm(path, { recursive: true, force: true })
})

describe('fixed bundled archive lookup, never network', () => {
  it('selects only the fixed resource name after exact size/hash verification without modifying the payload', async () => {
    const path = await bundle(), before = await files.stat(path)
    expect(bundledTexArchiveCandidates()[0]).toBe(path)
    expect(await findBundledTexArchive()).toBe(path)
    expect((await files.stat(path)).mtimeMs).toBe(before.mtimeMs)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('has fixed development candidates, no user/cache URL or caller path parameter', () => {
    expect(bundledTexArchiveCandidates()).toContain(resolve(process.cwd(), 'resources/tex-runtime', `${TEX_ASSETS.win32.sha256}.zip`))
    expect(bundledTexArchiveCandidates().every(path => path.endsWith(`${TEX_ASSETS.win32.sha256}.zip`))).toBe(true)
    expect(findBundledTexArchive.length).toBe(1)
  })
  it.each(['missing', 'wrong-size', 'wrong-hash', 'directory'])('fails closed for %s rather than downloading or accepting a broken install', async kind => {
    if (kind !== 'missing') {
      const path = await bundle(kind === 'wrong-size' ? 'short' : kind === 'wrong-hash' ? 'x'.repeat(fixture.body.length) : fixture.body)
      if (kind === 'directory') { await files.unlink(path); await files.mkdir(path) }
    }
    await expect(findBundledTexArchive()).rejects.toThrow('不会改为联网下载')
    expect(fetcher).not.toHaveBeenCalled(); expect(downloadTexAsset).not.toHaveBeenCalled()
  })
  it('rejects a linked resource directory even if target bytes match the pin', async () => {
    const original = await bundle(), linkedRoot = await folder()
    await files.symlink(join(original, '..'), join(linkedRoot, 'tex-runtime'), 'junction')
    processValue('resourcesPath', linkedRoot)
    await expect(findBundledTexArchive()).rejects.toThrow('离线资源')
    expect(await files.readFile(original, 'utf8')).toBe(fixture.body)
  })
  it('rejects a multiply linked archive without removing either file', async () => {
    const path = await bundle(), other = join(await folder(), 'other.zip')
    await files.link(path, other)
    await expect(findBundledTexArchive()).rejects.toThrow('离线资源')
    expect(await files.readFile(other, 'utf8')).toBe(fixture.body)
  })
  it('honors cancellation before lookup without network', async () => {
    await expect(findBundledTexArchive(AbortSignal.abort())).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('closes an already opened file on cancellation', async () => {
    await bundle()
    const controller = new AbortController(), { open: original } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let closed: ReturnType<typeof vi.spyOn> | undefined
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const file = await original(...args); closed = vi.spyOn(file, 'close'); controller.abort(); return file
    })
    await expect(findBundledTexArchive(controller.signal)).rejects.toThrow()
    expect(closed).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not report success when a source handle cannot confirm close', async () => {
    await bundle()
    const { open: original } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const file = await original(...args), close = file.close.bind(file)
      vi.spyOn(file, 'close').mockImplementation(async () => { await close(); throw new Error('PRIVATE provider failure') })
      return file
    })
    const error = await findBundledTexArchive().catch((value: unknown) => value)
    expect(String(error)).toContain('离线资源'); expect(String(error)).not.toContain('PRIVATE')
  })
  it('refuses unaccepted macOS even when Windows bytes are present', async () => {
    await bundle(); processValue('platform', 'darwin')
    await expect(findBundledTexArchive()).rejects.toThrow('macOS 尚未启用')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('offline preparation reuses the existing verification chain', () => {
  it('passes pinned SHA and signal into extraction, keeps catalog/overlays/manifest and never marks compile verified', async () => {
    const archivePath = await bundle(), controller = new AbortController(), onProgress = vi.fn()
    const prepared = await prepareNativeTex(await folder(), { archivePath, signal: controller.signal, onProgress })
    expect(extractWindowsTexZip).toHaveBeenCalledWith(archivePath, join(prepared.root, 'install'),
      expect.objectContaining({ expectedSha256: TEX_ASSETS.win32.sha256, signal: controller.signal }))
    expect(installPatchedEngines).toHaveBeenCalledOnce(); expect(installPackageTree).toHaveBeenCalledOnce()
    expect(verifyInstallationCatalog).toHaveBeenCalledWith(prepared.root, controller.signal)
    expect(prepared.manifest.chineseResources).toBe(false); expect(prepared.manifest).not.toHaveProperty('compileVerified')
    expect(JSON.parse(await files.readFile(join(prepared.root, RUNTIME_MANIFEST), 'utf8'))).toEqual(prepared.manifest)
    expect(onProgress.mock.calls.some(([state]) => state.phase === 'downloading')).toBe(false)
    expect(downloadTexAsset).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('reuses an already validated private runtime without extracting/downloading again', async () => {
    const archivePath = await bundle(), root = await folder()
    const first = await prepareNativeTex(root, { archivePath })
    const next = await prepareNativeTex(root, { archivePath: join(resources, 'now-missing.zip') })
    expect(next.root).toBe(first.root); expect(extractWindowsTexZip).toHaveBeenCalledOnce()
    expect(downloadTexAsset).not.toHaveBeenCalled()
  })
  it.each(['relative.zip', '', null, 42])('rejects invalid explicit archivePath %s, never falling back to download', async archivePath => {
    await expect(prepareNativeTex(await folder(), { archivePath: archivePath as string })).rejects.toThrow('路径无效')
    expect(downloadTexAsset).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects missing or wrong-size local payload before extraction and without a legacy download', async () => {
    await expect(prepareNativeTex(await folder(), { archivePath: join(resources, 'absent.zip') })).rejects.toThrow()
    await expect(prepareNativeTex(await folder(), { archivePath: await bundle('short') })).rejects.toThrow('固定大小')
    expect(extractWindowsTexZip).not.toHaveBeenCalled(); expect(downloadTexAsset).not.toHaveBeenCalled()
  })
  it('leaves no reusable manifest after extraction/hash failure and never retries online', async () => {
    const root = await folder(), archivePath = await bundle()
    vi.mocked(extractWindowsTexZip).mockRejectedValueOnce(new Error('TeX ZIP SHA-256 来源校验失败'))
    await expect(prepareNativeTex(root, { archivePath })).rejects.toThrow('SHA-256')
    expect(await files.readdir(join(root, 'tex/runtimes'))).toEqual([])
    expect(installPatchedEngines).not.toHaveBeenCalled(); expect(downloadTexAsset).not.toHaveBeenCalled()
  })
  it('keeps the original whole-tree catalog as a mandatory veto', async () => {
    const root = await folder(), archivePath = await bundle()
    vi.mocked(verifyInstallationCatalog).mockRejectedValueOnce(new Error('TeX catalog mismatch'))
    await expect(prepareNativeTex(root, { archivePath })).rejects.toThrow('catalog')
    expect(await files.readdir(join(root, 'tex/runtimes'))).toEqual([])
    expect(downloadTexAsset).not.toHaveBeenCalled()
  })
  it('honors a canceled local preparation before any extraction or download', async () => {
    await expect(prepareNativeTex(await folder(), { archivePath: await bundle(), signal: AbortSignal.abort() })).rejects.toThrow()
    expect(extractWindowsTexZip).not.toHaveBeenCalled(); expect(downloadTexAsset).not.toHaveBeenCalled()
  })
  it('preserves legacy download only when a developer explicitly omits the local archive option', async () => {
    const archivePath = await bundle()
    vi.mocked(downloadTexAsset).mockResolvedValueOnce(archivePath)
    await prepareNativeTex(await folder(), { platform: 'win32' })
    expect(downloadTexAsset).toHaveBeenCalledOnce()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
