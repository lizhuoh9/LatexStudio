import { describe, expect, it } from 'vitest'
import { EditorBuffer, readableError } from '../src/renderer/editor-model'

const original = { path: 'main.tex', content: 'original', revision: 'revision-1' }

describe('local editor draft and external modification protection', () => {
  it('loads a saved file without marking it dirty', () => {
    const buffer = new EditorBuffer(); buffer.load(original)
    expect(buffer.dirty).toBe(false); expect(buffer.revision).toBe('revision-1')
  })
  it('compares content, not a one-way dirty flag', () => {
    const buffer = new EditorBuffer(); buffer.load(original)
    buffer.edit('draft'); expect(buffer.dirty).toBe(true)
    buffer.edit('original'); expect(buffer.dirty).toBe(false)
  })
  it('retains a draft when a matching external change arrives', () => {
    const buffer = new EditorBuffer(); buffer.load(original); buffer.edit('unsaved AI notes')
    expect(buffer.externalChange(['main.tex'])).toBe('conflict')
    expect(buffer.content).toBe('unsaved AI notes'); expect(buffer.conflict).toBe(true)
    expect(buffer.revision).toBe('revision-1')
  })
  it('refreshes only clean matching files', () => {
    const buffer = new EditorBuffer(); buffer.load(original)
    expect(buffer.externalChange(['other.tex'])).toBe('unrelated')
    expect(buffer.externalChange(['main.tex'])).toBe('reload')
  })
  it('does not mark edits typed during an asynchronous save as saved', () => {
    const buffer = new EditorBuffer(); buffer.load(original); buffer.edit('sent to disk')
    buffer.edit('newer typing')
    buffer.saved({ ...original, content: 'sent to disk', revision: 'revision-2' })
    expect(buffer.content).toBe('newer typing'); expect(buffer.dirty).toBe(true)
    expect(buffer.savedContent).toBe('sent to disk'); expect(buffer.revision).toBe('revision-2')
  })
  it('rejects save results for an old file', () => {
    const buffer = new EditorBuffer(); buffer.load({ ...original, path: 'chapter.tex' })
    expect(buffer.saved(original)).toBe(false)
    expect(buffer.path).toBe('chapter.tex')
  })
})

describe('asynchronous external reads and lifecycle', () => {
  it('rejects an external read result when typing happened during the read', () => {
    const buffer = new EditorBuffer(); buffer.load(original)
    const version = buffer.editVersion
    buffer.edit('draft')
    expect(buffer.acceptReload({ ...original, content: 'external' }, version)).toBe(false)
    expect(buffer.content).toBe('draft')
  })
  it('rejects stale reads even after typing and undo return to original text', () => {
    const buffer = new EditorBuffer(); buffer.load(original)
    const version = buffer.editVersion
    buffer.edit('draft'); buffer.edit('original')
    expect(buffer.acceptReload({ ...original, content: 'external' }, version)).toBe(false)
  })
  it('loads an external clean update and advances revision', () => {
    const buffer = new EditorBuffer(); buffer.load(original)
    expect(buffer.acceptReload({ ...original, content: 'external', revision: '2' }, buffer.editVersion)).toBe(true)
    expect(buffer.content).toBe('external'); expect(buffer.dirty).toBe(false)
  })
  it('clears draft, revision and conflict at project boundaries', () => {
    const buffer = new EditorBuffer(); buffer.load(original); buffer.edit('draft'); buffer.conflict = true
    buffer.reset()
    expect(buffer.path).toBe(''); expect(buffer.dirty).toBe(false); expect(buffer.conflict).toBe(false)
  })
  it('redacts accidental credential-shaped errors and does not expose implementation vocabulary', () => {
    const message = readableError(new Error('push failed ghp_example123 github_pat_example456'))
    expect(message).not.toContain('ghp_'); expect(message).not.toContain('github_pat_'); expect(message).toContain('上传')
  })
})
