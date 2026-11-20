import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({ rename: null as NodeJS.ErrnoException | null }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, rename: async (from: string, to: string) => { if (failures.rename) throw failures.rename; return real.rename(from, to) } }
})
import { CompiledPdfExport, defaultPdfName, writePdfCopy, type PdfExportHost } from '../src/main/workspace/pdf-export'
import { translate } from '../src/shared/i18n'
import { readFileSync } from 'node:fs'

describe('the Download PDF control', () => {
  const markup = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')
  it('sits in the PDF toolbar beside Log and Comments, disabled until a compile succeeds', () => {
    expect(markup).toMatch(/<div class="compile-actions">[\s\S]*?<button id="comments-open"[\s\S]*?<\/button><button id="pdf-download" class="text-button" data-lock disabled title="把最近一次编译成功的 PDF 另存到本机">下载 PDF<\/button><\/div>/)
  })
  it.each(['en', 'ko'] as const)('has %s text for every fixed message and keeps saved paths literal', locale => {
    for (const text of ['下载 PDF', '把最近一次编译成功的 PDF 另存到本机', '保存 PDF', '还没有编译成功的 PDF，请先编译。', '磁盘空间不足，PDF 未保存。',
      '没有写入该位置的权限，或文件正被其他程序占用；PDF 未保存，请换个位置或关闭占用它的程序后重试。', '所选位置是文件夹，请输入文件名后保存。',
      '已保存 PDF：D:\\论文\\thesis.pdf', '已保存最近一次编译成功的 PDF：D:\\论文\\thesis.pdf。之后的源码改动不在其中，需要时请重新编译后再下载。',
      'PDF 未能保存（EIO），请换个位置重试。']) {
      expect(translate(text, locale).replace('D:\\论文\\thesis.pdf', ''), text).not.toMatch(/[\u3400-\u9fff]/)
    }
    expect(translate('已保存 PDF：D:\\论文\\thesis.pdf', locale)).toContain('D:\\论文\\thesis.pdf')
  })
})

const folders: string[] = []
afterEach(async () => { failures.rename = null; await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function folder(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'latexstudio-export-')); folders.push(path); return path }
const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])

describe('writing a copy of the PDF', () => {
  it('names the copy after the main file', () => {
    expect(defaultPdfName('chapters/thesis.tex')).toBe('thesis.pdf')
    expect(defaultPdfName('main.tex')).toBe('main.pdf')
    expect(defaultPdfName('notes')).toBe('notes.pdf')
    expect(defaultPdfName('dir\\论文.tex')).toBe('论文.pdf')
    expect(defaultPdfName('.tex')).toBe('paper.pdf')
  })

  it('writes the exact bytes, replaces an existing file and leaves no temporary file', async () => {
    const root = await folder(), target = join(root, 'paper.pdf')
    await writeFile(target, 'old contents that are longer')
    await writePdfCopy(target, pdf)
    expect([...await readFile(target)]).toEqual([...pdf])
    expect(await readdir(root)).toEqual(['paper.pdf'])
  })

  it('refuses relative paths and folders, and explains a missing location without leftovers', async () => {
    const root = await folder()
    await expect(writePdfCopy('relative.pdf', pdf)).rejects.toThrow('保存位置无效')
    await mkdir(join(root, 'folder.pdf'))
    await expect(writePdfCopy(join(root, 'folder.pdf'), pdf)).rejects.toThrow('所选位置是文件夹')
    await expect(writePdfCopy(join(root, 'missing', 'paper.pdf'), pdf)).rejects.toThrow('保存位置不存在或已被移动')
    expect(await readdir(root)).toEqual(['folder.pdf'])
  })

  it.each([
    ['EPERM', '没有写入该位置的权限，或文件正被其他程序占用'],
    ['EBUSY', '目标文件正被其他程序占用'],
    ['ENOSPC', '磁盘空间不足'],
    ['EIO', 'PDF 未能保存（EIO）']
  ])('turns %s while replacing into a readable message and removes the temporary file', async (code, message) => {
    const root = await folder(), target = join(root, 'paper.pdf')
    await writeFile(target, 'kept')
    failures.rename = Object.assign(new Error(`${code}: raw system text`), { code })
    await expect(writePdfCopy(target, pdf)).rejects.toThrow(message)
    expect(await readdir(root)).toEqual(['paper.pdf'])
    expect(await readFile(target, 'utf8')).toBe('kept')
  })
})

describe('the last successful compile as the only source', () => {
  function exporter(overrides: Partial<PdfExportHost> = {}): { save: CompiledPdfExport; host: PdfExportHost & { choose: ReturnType<typeof vi.fn> } } {
    const host = { choose: vi.fn(async () => null), downloads: () => '/downloads', sources: vi.fn(async () => 'same'), unsaved: () => false, ...overrides }
    return { save: new CompiledPdfExport(host), host: host as PdfExportHost & { choose: ReturnType<typeof vi.fn> } }
  }

  it('needs a recorded compile, says nothing was saved on cancel, and forgets the record when cleared', async () => {
    const { save, host } = exporter()
    await expect(save.save()).rejects.toThrow('还没有编译成功的 PDF')
    save.record('main.tex', pdf, 'same')
    expect(save.available).toBe(true)
    expect(await save.save()).toEqual({ saved: false })
    expect(host.choose).toHaveBeenCalledWith(join('/downloads', 'main.pdf'))
    save.clear()
    await expect(save.save()).rejects.toThrow('还没有编译成功的 PDF')
  })

  it('remembers the folder of the last save and reports when sources may differ from the PDF', async () => {
    const root = await folder(), target = join(root, 'out.pdf')
    let unsaved = false, sources = 'same'
    const { save, host } = exporter({ unsaved: () => unsaved, sources: async () => sources })
    host.choose.mockResolvedValue(target)
    save.record('chapters/thesis.tex', pdf, 'same')
    expect(await save.save()).toEqual({ saved: true, path: target, stale: false })
    expect(host.choose).toHaveBeenLastCalledWith(join('/downloads', 'thesis.pdf'))
    unsaved = true
    expect(await save.save()).toMatchObject({ stale: true })
    expect(host.choose).toHaveBeenLastCalledWith(join(root, 'thesis.pdf'))
    unsaved = false; sources = 'changed'
    expect(await save.save()).toMatchObject({ stale: true })
    save.record('chapters/thesis.tex', pdf, null)
    sources = 'changed'
    expect(await save.save()).toMatchObject({ stale: true })
    expect([...await readFile(target)]).toEqual([...pdf])
  })
})
