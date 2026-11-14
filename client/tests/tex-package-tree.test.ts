import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installationDigest, OVERLAY_DIRS } from '../src/main/tex/catalog'
import { hashFile } from '../src/main/tex/manifest'
import { findPackageSource, installPackageTree, PACKAGE_MANIFEST_SHA256, PACKAGE_TREE_DIR, readPackageManifest,
  verifyPackageTree } from '../src/main/tex/package-tree'

const roots: string[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
async function source(files: Record<string, string>, manifestFiles?: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'paperstudio-pkg-')); roots.push(root)
  const tree = join(root, 'src', PACKAGE_TREE_DIR)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(tree, name, '..'), { recursive: true }); await writeFile(join(tree, name), content)
  }
  const manifest = JSON.stringify({ schema: 1, files: manifestFiles ?? Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha(c)])) })
  await writeFile(join(root, 'src', 'manifest.json'), manifest)
  const install = join(root, 'install'); await mkdir(install)
  return { root, src: join(root, 'src'), install, pin: sha(manifest) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('pinned TeX package tree', () => {
  const files = { 'tex/latex/ctex/ctex.sty': 'CTEX', 'bibtex/bst/gbt7714/gbt7714-numerical.bst': 'BST' }

  it('installs and verifies exactly the manifest files', async () => {
    const t = await source(files)
    await installPackageTree(t.install, t.src, undefined, t.pin)
    await verifyPackageTree(t.install, await readPackageManifest(t.src, t.pin))
  })

  it('refuses a manifest that does not match the pin, and traversal or absolute entries', async () => {
    const t = await source(files)
    await expect(readPackageManifest(t.src, sha('other'))).rejects.toThrow('校验值不符')
    for (const bad of ['../escape.sty', 'tex/../../x.sty', '/abs.sty', 'C:/x.sty']) {
      const b = await source({ 'tex/ok.sty': 'OK' }, { [bad]: sha('x') })
      await expect(readPackageManifest(b.src, b.pin)).rejects.toThrow('条目无效')
    }
  })

  it('refuses changed source bytes, and extra, missing or changed installed files', async () => {
    const changed = await source(files, { ...Object.fromEntries(Object.entries(files).map(([n, c]) => [n, sha(c)])), 'tex/latex/ctex/ctex.sty': sha('NOT') })
    await expect(installPackageTree(changed.install, changed.src, undefined, changed.pin)).rejects.toThrow('与清单不符')
    const t = await source(files)
    await installPackageTree(t.install, t.src, undefined, t.pin)
    const manifest = await readPackageManifest(t.src, t.pin), tree = join(t.install, PACKAGE_TREE_DIR)
    await writeFile(join(tree, 'tex', 'extra.sty'), 'X')
    await expect(verifyPackageTree(t.install, manifest)).rejects.toThrow('内容不符')
    await rm(join(tree, 'tex', 'extra.sty'))
    await writeFile(join(tree, 'tex/latex/ctex/ctex.sty'), 'TAMPERED')
    await expect(verifyPackageTree(t.install, manifest)).rejects.toThrow('校验失败')
    await rm(join(tree, 'tex/latex/ctex/ctex.sty'))
    await expect(verifyPackageTree(t.install, manifest)).rejects.toThrow('内容不符')
  })

  it('is excluded from the TinyTeX tree digest together with the engine overlay', async () => {
    const t = await source(files)
    await writeFile(join(t.install, 'texmf.cnf'), 'base')
    const before = await installationDigest(t.install, undefined, OVERLAY_DIRS)
    await installPackageTree(t.install, t.src, undefined, t.pin)
    expect(await installationDigest(t.install, undefined, OVERLAY_DIRS)).toBe(before)
    expect(OVERLAY_DIRS).toEqual(['bin/paperstudio-x64', 'texmf-paperstudio'])
  })

  it('ships a manifest matching the pin and files matching the manifest', async () => {
    const shipped = resolve('resources/tex-packages')
    expect(await findPackageSource([shipped])).toBe(shipped)
    const manifest = await readPackageManifest(shipped, PACKAGE_MANIFEST_SHA256)
    expect(Object.keys(manifest.files).some(name => name.endsWith('ctex.sty'))).toBe(true)
    expect(Object.keys(manifest.files).some(name => name.endsWith('xeCJK.sty'))).toBe(true)
    for (const [name, hash] of Object.entries(manifest.files)) expect(await hashFile(join(shipped, PACKAGE_TREE_DIR, ...name.split('/')))).toBe(hash)
  })
})
