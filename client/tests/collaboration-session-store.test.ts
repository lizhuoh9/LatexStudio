import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: {} }))
import { EncryptedSessionStore, validStoredSession, type SessionEncryption, type StoredSession } from '../src/main/collaboration/session-store'
const now = 100_000, id = 'e0fb6176-7e22-4ea0-94fa-d8e608b12845', clientId = 'Iv1.fixture-client'
const credential = (extra: Partial<StoredSession> = {}): StoredSession => ({ id, clientId, token: 'ghu_SESSION_CANARY', issuedAt: now, expiresAt: now + 3600000, conservative: true, ...extra })
const roots: string[] = []
async function folder() { const root = await mkdtemp(join(await realpath(tmpdir()), 'paperstudio-session-store-')); roots.push(root); return root }
function encryption(available = true, backend = 'gnome_libsecret'): SessionEncryption {
  return { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: vi.fn(text => Buffer.from('cipher:' + [...text].reverse().join(''))),
    decryptString: vi.fn(bytes => { const text = bytes.toString(); if (!text.startsWith('cipher:')) throw new Error('PRIVATE failure'); return [...text.slice(7)].reverse().join('') }) }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('dedicated encrypted current-access-token session store', () => {
  it('writes only encrypted credential bytes and no account, refresh token or plaintext token fields', async () => {
    const root = await folder(), crypto = encryption(), store = new EncryptedSessionStore(root, crypto)
    expect(await store.load(clientId, now)).toBeNull()
    expect(await store.save(credential())).toBe(true)
    const raw = await readFile(join(root, 'collaboration/account-session.json'), 'utf8'), record = JSON.parse(raw)
    expect(Object.keys(record).sort()).toEqual(['ciphertext', 'id', 'version'])
    for (const value of ['ghu_SESSION_CANARY', clientId, 'refresh_token', 'account', 'client_secret']) expect(raw).not.toContain(value)
    expect(await store.load(clientId, now + 10)).toEqual(credential())
    expect(crypto.encryptString).toHaveBeenCalledOnce()
  })
  it.each([[false, 'gnome_libsecret', 'win32'], [true, 'basic_text', 'win32'], [true, 'unknown', 'linux']] as const)('does not persist through weak/unavailable storage (%s/%s/%s)', async (available, backend, platform) => {
    const root = await folder(), store = new EncryptedSessionStore(root, encryption(available, backend), platform)
    expect(await store.save(credential())).toBe(false); expect(await store.load(clientId, now)).toBeNull()
    await expect(readFile(join(root, 'collaboration/account-session.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('removes expired and other-App sessions without extending their original expiry', async () => {
    const root = await folder(), store = new EncryptedSessionStore(root, encryption())
    await store.save(credential()); expect(await store.load(clientId, now + 3600000)).toBeNull()
    await expect(readFile(join(root, 'collaboration/account-session.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await store.save(credential()); expect(await store.load('Iv1.another-client', now)).toBeNull()
  })
  it('snapshots save input before queued I/O so later caller mutation cannot change the encrypted record', async () => {
    const root = await folder(), store = new EncryptedSessionStore(root, encryption()), value = credential()
    const writing = store.save(value); value.token = 'changed-after-call'; value.expiresAt += 999999999
    await writing; expect(await store.load(clientId, now)).toEqual(credential())
  })
  it('serializes save and clear, and conditional rollback never deletes a newer credential', async () => {
    const root = await folder(), store = new EncryptedSessionStore(root, encryption()), later = credential({ id: '305cae10-3aa6-4983-9a78-c023b3df5abc' })
    await Promise.all([store.save(credential()), store.save(later), store.clear(credential())])
    expect(await store.load(clientId, now)).toEqual(later)
    await store.clear(); expect(await store.load(clientId, now)).toBeNull()
  })
  it('does not create credentials after cancellation and leaves an existing value unchanged', async () => {
    const root = await folder(), store = new EncryptedSessionStore(root, encryption())
    await store.save(credential())
    await expect(store.save(credential({ token: 'other' }), AbortSignal.abort())).rejects.toBeDefined()
    expect(await store.load(clientId, now)).toEqual(credential())
  })
  it('rejects extra fields, unsafe shapes, clock rollback and excessive/conservative lifetimes', () => {
    for (const value of [Object.assign(credential(), { refresh_token: 'PRIVATE' }), credential({ token: 'bad\nvalue' }),
      credential({ conservative: true, expiresAt: now + 3600001 }), credential({ conservative: false, expiresAt: now + 8 * 3600000 + 1 }),
      credential({ issuedAt: now + 1 }), credential({ id: '../redirect' })]) expect(() => validStoredSession(value, now)).toThrow()
  })
  it('fails closed on malformed, oversized and undecryptable files without leaking provider data', async () => {
    const root = await folder(), store = new EncryptedSessionStore(root, encryption()), file = join(root, 'collaboration/account-session.json')
    await store.save(credential()); await writeFile(file, 'not json', { mode: 0o600 })
    await expect(store.load(clientId, now)).rejects.not.toThrow('not json')
    await writeFile(file, 'x'.repeat(65537), { mode: 0o600 }); await expect(store.load(clientId, now)).rejects.toThrow('安全')
    await writeFile(file, JSON.stringify({ version: 1, id, ciphertext: Buffer.from('wrong cipher').toString('base64') }), { mode: 0o600 })
    await expect(store.load(clientId, now)).rejects.not.toThrow('PRIVATE')
    await store.clear(); expect(await store.load(clientId, now)).toBeNull()
  })
  it('refuses linked parent directories and hard-link aliases instead of following or changing them', async () => {
    const root = await folder(), outside = await folder(), redirected = join(root, 'collaboration')
    await symlink(outside, redirected, process.platform === 'win32' ? 'junction' : 'dir')
    const redirectedStore = new EncryptedSessionStore(root, encryption())
    await expect(redirectedStore.save(credential())).rejects.toThrow()
    await expect(readFile(join(outside, 'account-session.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const safe = await folder(), store = new EncryptedSessionStore(safe, encryption()); await store.save(credential())
    await link(join(safe, 'collaboration/account-session.json'), join(safe, 'alias'))
    await expect(store.load(clientId, now)).rejects.toThrow(); await expect(store.clear()).rejects.toThrow()
  })
  it('clear does not require OS decryption availability', async () => {
    const root = await folder(), crypto = encryption(), store = new EncryptedSessionStore(root, crypto)
    await store.save(credential()); crypto.isEncryptionAvailable = () => false
    await store.clear(); await expect(readFile(join(root, 'collaboration/account-session.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
