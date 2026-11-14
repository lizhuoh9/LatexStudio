import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const client = resolve(__dirname, '..'), directory = resolve(client, 'resources/icons')
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(pngSignature)
  expect(bytes.toString('ascii', 12, 16)).toBe('IHDR')
  expect(bytes[24]).toBe(8); expect(bytes[25]).toBe(6) // RGBA, including transparent rounded margins.
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

it.each([['paperstudio.png', 512], ['paperstudio-256.png', 256]] as const)('ships a valid %s RGBA resource at %i pixels', async (file, size) => {
  const bytes = await readFile(resolve(directory, file))
  expect(pngSize(bytes)).toEqual({ width: size, height: size })
  expect(bytes.length).toBeGreaterThan(1024)
})

it('contains every Windows ICO representation with valid bounded PNG images', async () => {
  const bytes = await readFile(resolve(directory, 'paperstudio.ico'))
  expect(bytes.readUInt16LE(0)).toBe(0); expect(bytes.readUInt16LE(2)).toBe(1)
  const count = bytes.readUInt16LE(4), sizes: number[] = []
  expect(count).toBe(7)
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16, width = bytes[entry] || 256, height = bytes[entry + 1] || 256
    const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12)
    expect(width).toBe(height); expect(offset).toBeGreaterThanOrEqual(6 + count * 16)
    expect(length).toBeGreaterThan(100); expect(offset + length).toBeLessThanOrEqual(bytes.length)
    expect(pngSize(bytes.subarray(offset, offset + length))).toEqual({ width, height })
    sizes.push(width)
  }
  expect(sizes.sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 128, 256])
})

it('maps the same original ICO to Windows and NSIS, and only the fixed runtime PNG', async () => {
  const pkg = JSON.parse(await readFile(resolve(client, 'package.json'), 'utf8')), icon = 'resources/icons/paperstudio.ico'
  expect(pkg.build.win.icon).toBe(icon)
  expect(pkg.build.nsis.installerIcon).toBe(icon); expect(pkg.build.nsis.uninstallerIcon).toBe(icon)
  expect(pkg.build.win.extraResources.filter((entry: { to: string }) => entry.to === 'icons')).toEqual([
    { from: 'resources/icons', to: 'icons', filter: ['paperstudio-256.png'] }
  ])
  expect(pkg.build.win.signExecutable).toBe(false)
  expect(pkg.build.electronFuses).toMatchObject({ runAsNode: false, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true })
})

it('keeps a portable original generator with the SCI palette, no downloaded artwork or font dependency', async () => {
  const source = await readFile(resolve(client, 'scripts/generate-app-icon.py'), 'utf8')
  expect(source).toContain('BLUE = "#00659F"'); expect(source).toContain('ORANGE = "#E69F00"')
  expect(source).toContain('Path(__file__).resolve().parents[1]')
  expect(source).not.toMatch(/requests|urllib|ImageFont|subprocess|https?:\/\//)
  expect(await readFile(resolve(directory, 'README.md'), 'utf8')).toContain('Ordinary users do not need Python')
})
