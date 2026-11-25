import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DARWIN_INSTALL_TREE_SHA256, DARWIN_TOOLS, MAC_HELPER_SHA256 } from '../src/main/tex/darwin-runtime'

/**
 * The Mac compile helper is signed once on a Mac; its executable and its signature list are committed and every build
 * only puts the bundle together again. These checks run on any platform and catch the one mistake that would
 * otherwise only show on the release build machine: changing something the signature covers without re-signing.
 */
const signed = join(process.cwd(), 'resources', 'darwin', 'signed')
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function sealed(): Map<string, string> {
  const text = gunzipSync(readFileSync(join(signed, 'CodeResources.gz'))).toString('utf8')
  const from = text.indexOf('<key>files2</key>'), to = text.indexOf('<key>rules</key>')
  if (from < 0 || to < from) throw new Error('unexpected layout of the signature list')
  const files2 = text.slice(from, to)
  const entries = new Map<string, string>()
  for (const match of files2.matchAll(/<key>([^<]+)<\/key>\s*<dict>\s*<key>hash2<\/key>\s*<data>\s*([A-Za-z0-9+/=]+)\s*<\/data>/g))
    entries.set(match[1]!, Buffer.from(match[2]!, 'base64').toString('hex'))
  // Every listed file must have been read: an entry of another shape would otherwise be skipped without a word.
  if (entries.size !== files2.split('<key>Resources/').length - 1 || entries.size !== files2.split('<key>hash2</key>').length - 1)
    throw new Error('unexpected entry shape in the signature list')
  return entries
}
function walk(directory: string, prefix = ''): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name
    return statSync(path).isDirectory() ? walk(path, relative) : [relative]
  })
}

describe('committed Mac compile helper', () => {
  it('is the executable the app pins', () => {
    expect(MAC_HELPER_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(sha256(readFileSync(join(signed, 'latexstudio-compiler')))).toBe(MAC_HELPER_SHA256)
  })

  it('carries a signature list that covers exactly the package tree of this checkout', () => {
    const entries = sealed(), packages = join(process.cwd(), 'resources', 'tex-packages')
    const shipped = walk(packages)
    expect(shipped.length).toBeGreaterThan(50)
    for (const name of shipped)
      expect(entries.get(`Resources/tex-packages/${name}`), `${name} changed or was added after the helper was signed`)
        .toBe(sha256(readFileSync(join(packages, name))))
    const listed = [...entries.keys()].filter(key => key.startsWith('Resources/tex-packages/'))
    expect(listed.length, 'a package file was removed after the helper was signed').toBe(shipped.length)
  })

  it('carries a signature list whose TeX entries give exactly the pinned tree digest', () => {
    // Same definition as installationDigest (src/main/tex/catalog.ts): sorted relative paths with their SHA-256.
    const prefix = 'Resources/tex-darwin/install/'
    const tree = [...sealed()].filter(([key]) => key.startsWith(prefix)).map(([key, digest]) => ({ path: key.slice(prefix.length), digest }))
    tree.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    const hash = createHash('sha256')
    for (const { path, digest } of tree) { hash.update(path); hash.update('\0'); hash.update(digest); hash.update('\n') }
    expect(tree.length).toBeGreaterThan(10_000)
    expect(hash.digest('hex'), 'the tree pin and the signed TeX tree have drifted apart').toBe(DARWIN_INSTALL_TREE_SHA256)
  })

  it('was built from the helper source, Info.plist and entitlements of this checkout', () => {
    const record = JSON.parse(readFileSync(join(signed, 'PROVENANCE.json'), 'utf8')) as { sources: Record<string, string>; signed: Record<string, string> }
    expect(Object.keys(record.sources).sort()).toEqual(['compiler/Info.plist', 'compiler/compiler.entitlements.plist', 'compiler/latexstudio-compiler.c'])
    for (const [name, digest] of Object.entries(record.sources))
      expect(sha256(readFileSync(join(signed, '..', ...name.split('/')))), `${name} changed after the helper was signed: rebuild and re-sign on a Mac`).toBe(digest)
    for (const [name, digest] of Object.entries(record.signed)) expect(sha256(readFileSync(join(signed, name))), name).toBe(digest)
    expect(record.signed['latexstudio-compiler']).toBe(MAC_HELPER_SHA256)
  })

  it('carries a signature list that covers the four tools and both formats', () => {
    const entries = sealed()
    for (const path of [...Object.values(DARWIN_TOOLS), 'install/texmf-var/web2c/pdftex/pdflatex.fmt', 'install/texmf-var/web2c/xetex/xelatex.fmt'])
      expect(entries.get(`Resources/tex-darwin/${path}`), path).toMatch(/^[a-f0-9]{64}$/)
    // Everything the list names lives in one of the two trees; nothing else is inside the bundle's Resources.
    expect([...entries.keys()].every(key => key.startsWith('Resources/tex-darwin/install/') || key.startsWith('Resources/tex-packages/'))).toBe(true)
  })
})
