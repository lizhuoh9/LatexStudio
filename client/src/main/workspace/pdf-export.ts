import { randomUUID } from 'node:crypto'
import { lstat, open, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix } from 'node:path'
import type { PdfSaveResult } from '../../shared/workspace-contracts'

interface CompiledPdf { bytes: Uint8Array; mainFile: string; sources: string | null }
export interface PdfExportHost {
  /** Native "Save as" dialog; resolves the chosen path, or null when the user cancels. */
  choose(defaultPath: string): Promise<string | null>
  /** The system Downloads folder (default location until a PDF has been saved in this run). */
  downloads(): string
  /** Fingerprint of the project's source files now, or null when it cannot be read. */
  sources(): Promise<string | null>
  /** Whether the editor holds edits that are not saved to the project yet. */
  unsaved(): boolean
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code

/** "chapters/main.tex" → "main.pdf"; anything unusable falls back to "paper.pdf". */
export function defaultPdfName(mainFile: string): string {
  const stem = posix.basename(mainFile.replace(/\\/g, '/')).replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim()
  return `${stem || 'paper'}.pdf`
}

function readableFailure(error: unknown): Error {
  const reason = code(error)
  if (reason === 'EACCES' || reason === 'EPERM') return new Error('没有写入该位置的权限，或文件正被其他程序占用；PDF 未保存，请换个位置或关闭占用它的程序后重试。')
  if (reason === 'EBUSY') return new Error('目标文件正被其他程序占用（例如正在阅读器中打开）；PDF 未保存，请关闭后重试或换个文件名。')
  if (reason === 'ENOSPC') return new Error('磁盘空间不足，PDF 未保存。')
  if (reason === 'ENOENT') return new Error('保存位置不存在或已被移动，PDF 未保存。')
  if (reason === 'EROFS') return new Error('该位置是只读的，PDF 未保存。')
  return error instanceof Error && !reason ? error : new Error(`PDF 未能保存（${reason ?? 'unknown'}），请换个位置重试。`)
}

/** Writes `bytes` to `target` (a path the user just chose): new temporary file beside it, exact size checked,
 * then renamed over the target, and the final size checked again. A failed attempt leaves no temporary file.
 */
export async function writePdfCopy(target: string, bytes: Uint8Array): Promise<void> {
  if (typeof target !== 'string' || !isAbsolute(target) || target.includes('\0')) throw new Error('保存位置无效，PDF 未保存。')
  const existing = await lstat(target).catch((error: unknown) => { if (code(error) === 'ENOENT') return null; throw readableFailure(error) })
  if (existing?.isDirectory()) throw new Error('所选位置是文件夹，请输入文件名后保存。')
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.part`)
  let created = false
  try {
    const handle = await open(temporary, 'wx', 0o644)
    created = true
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    if ((await stat(temporary)).size !== bytes.length) throw new Error('写入的 PDF 大小不一致，未保存，请重试。')
    await rename(temporary, target)
    created = false
    const saved = await stat(target)
    if (!saved.isFile() || saved.size !== bytes.length) throw new Error('保存后的文件大小不一致，请检查目标位置后重试。')
  } catch (error) {
    throw readableFailure(error)
  } finally {
    if (created) await unlink(temporary).catch(() => undefined)
  }
}

/** The last successful compile's PDF of the active project, kept in Main (compile folders are removed afterwards).
 * Saving takes no path from the renderer: the source is this record, the target only the native dialog's answer.
 * `stale` is true when the sources may differ from what was compiled (changed files, unsaved edits, or unknown).
 */
export class CompiledPdfExport {
  private last: CompiledPdf | null = null
  private directory: string | null = null

  constructor(private readonly host: PdfExportHost) {}

  /** `sources` is the source fingerprint taken just before that compile started (null if it could not be read). */
  record(mainFile: string, bytes: Uint8Array, sources: string | null): void { this.last = { bytes, mainFile, sources } }
  clear(): void { this.last = null }
  get available(): boolean { return this.last !== null }

  async save(): Promise<PdfSaveResult> {
    const pdf = this.last
    if (!pdf) throw new Error('还没有编译成功的 PDF，请先编译。')
    const current = await this.host.sources().catch(() => null)
    const stale = this.host.unsaved() || pdf.sources === null || current !== pdf.sources
    const target = await this.host.choose(join(this.directory ?? this.host.downloads(), defaultPdfName(pdf.mainFile)))
    if (!target) return { saved: false }
    await writePdfCopy(target, pdf.bytes)
    this.directory = dirname(target)
    return { saved: true, path: target, stale }
  }
}
