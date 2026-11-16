/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountAvatar } from '../src/renderer/account-avatar'

function image() {
  return { src: '', alt: '', width: 0, height: 0, hidden: false, draggable: true, decoding: '',
    crossOrigin: '', referrerPolicy: '', onload: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null, removed: false,
    removeAttribute(name: string) { if (name === 'src') this.src = '' }, remove() { this.removed = true } }
}
let images: ReturnType<typeof image>[], classes: Set<string>, avatar: AccountAvatar
beforeEach(() => {
  images = []; classes = new Set()
  vi.stubGlobal('document', { createElement: vi.fn((tag: string) => { expect(tag).toBe('img'); return image() }) })
  const host = { append(value: ReturnType<typeof image>) { images.push(value) },
    classList: { toggle(name: string, enabled: boolean) { if (enabled) classes.add(name); else classes.delete(name) } } }
  avatar = new AccountAvatar(host as unknown as HTMLElement)
})
afterEach(() => { avatar.dispose(); vi.unstubAllGlobals() })

describe('current GitHub account avatar', () => {
  it('does not request an image while offline or without a valid account', () => {
    for (const id of [null, 0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) avatar.update(id)
    expect(images).toHaveLength(0)
  })
  it('constructs only the numeric GitHub CDN URL and sends no credentials or referrer', () => {
    avatar.update(157104877)
    const img = images[0]!
    expect(img.src).toBe('https://avatars.githubusercontent.com/u/157104877?s=64&v=4')
    expect(img.crossOrigin).toBe('anonymous'); expect(img.referrerPolicy).toBe('no-referrer')
    expect(img.alt).toBe(''); expect(img.hidden).toBe(true); expect(img.draggable).toBe(false)
    img.onload!(new Event('load'))
    expect(img.hidden).toBe(false); expect(classes.has('has-image')).toBe(true)
    avatar.update(157104877); expect(images).toHaveLength(1)
  })
  it('keeps the initial on network failure and never retries during repeated state updates', () => {
    avatar.update(7); images[0]!.onerror!(new Event('error'))
    expect(images[0]!.removed).toBe(true); expect(images[0]!.src).toBe('')
    expect(classes.has('has-image')).toBe(false)
    avatar.update(7); avatar.update(7); expect(images).toHaveLength(1)
  })
  it('rejects a URL-shaped id instead of accepting an arbitrary image URL', () => {
    avatar.update('https://example.invalid/avatar' as unknown as number)
    expect(images).toHaveLength(0)
  })
  it('clears the old image on account switch and ignores its late load event', () => {
    avatar.update(7); const first = images[0]!, late = first.onload!
    avatar.update(8); late(new Event('load'))
    expect(first.removed).toBe(true); expect(classes.has('has-image')).toBe(false)
    expect(images[1]!.hidden).toBe(true)
    images[1]!.onload!(new Event('load')); expect(classes.has('has-image')).toBe(true)
  })
  it('removes a loaded avatar on logout and cannot revive it with a late response', () => {
    avatar.update(7); const img = images[0]!, late = img.onload!
    img.onload!(new Event('load')); avatar.update(null); late(new Event('load'))
    expect(classes.has('has-image')).toBe(false); expect(img.removed).toBe(true)
    expect(img.onload).toBeNull(); expect(img.onerror).toBeNull()
  })
  it('cancels on closing and can load again only after the close is canceled', () => {
    avatar.update(7); const late = images[0]!.onload!
    avatar.setClosing(true); late(new Event('load')); avatar.update(8)
    expect(images).toHaveLength(1); expect(classes.has('has-image')).toBe(false)
    avatar.setClosing(false); avatar.update(8); expect(images).toHaveLength(2)
  })
  it('releases the image on disposal and ignores all later updates/events', () => {
    avatar.update(7); const late = images[0]!.onload!
    avatar.dispose(); late(new Event('load')); avatar.update(8)
    expect(images).toHaveLength(1); expect(images[0]!.removed).toBe(true)
    expect(classes.has('has-image')).toBe(false)
  })
})
