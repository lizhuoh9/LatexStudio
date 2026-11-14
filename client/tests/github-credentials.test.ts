import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(value.split('').reverse().join(''))),
  decryptString: vi.fn((value: Buffer) => value.toString().split('').reverse().join('')) }))
vi.mock('electron', () => ({ safeStorage: storage }))
import { CredentialVault } from '../src/main/github/credentials'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
beforeEach(() => { vi.clearAllMocks(); storage.isEncryptionAvailable.mockReturnValue(true); storage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret') })
async function path(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'paperstudio-vault-'))
  folders.push(folder)
  return join(folder, 'vault.json')
}

describe('GitHub credential vault', () => {
  it('only persists OS-encrypted ciphertext and decrypts in the main-process vault', async () => {
    const file = await path()
    const vault = new CredentialVault(file)
    expect(await vault.load('repository')).toBeNull()
    await vault.save('repository', 'ghp_supersecret')
    const content = await readFile(file, 'utf8')
    expect(content).not.toContain('ghp_supersecret')
    expect(content).not.toContain('repository')
    expect(storage.encryptString).toHaveBeenCalledWith('ghp_supersecret')
    expect(await new CredentialVault(file).load('repository')).toBe('ghp_supersecret')
    await vault.remove('repository')
    expect(await new CredentialVault(file).load('repository')).toBeNull()
  })

  it.each([false, true])('uses only memory if unavailable or basic_text (availability %s)', async (available) => {
    const file = await path()
    storage.isEncryptionAvailable.mockReturnValue(available)
    storage.getSelectedStorageBackend.mockReturnValue('basic_text')
    const vault = new CredentialVault(file)
    await vault.save('repository', 'ghp_memorysecret')
    expect(await vault.load('repository')).toBe('ghp_memorysecret')
    expect(await new CredentialVault(file).load('repository')).toBeNull()
    expect(await readdir(join(file, '..'))).toEqual([])
    expect(storage.encryptString).not.toHaveBeenCalled()
    expect(vault.storageDescription).toContain('仅保留在内存')
    await vault.remove('repository')
    expect(await vault.load('repository')).toBeNull()
    expect(await readdir(join(file, '..'))).toEqual([])
  })

  it('serializes concurrent writes so encrypted credentials are not lost', async () => {
    const file = await path()
    const vault = new CredentialVault(file)
    await Promise.all([vault.save('one', 'secret-one'), vault.save('two', 'secret-two')])
    const restored = new CredentialVault(file)
    expect(await restored.load('one')).toBe('secret-one')
    expect(await restored.load('two')).toBe('secret-two')
  })

  it('sanitizes corrupt-store and OS failures without exposing secrets', async () => {
    const file = await path()
    await writeFile(file, 'ghp_hidden-token')
    await expect(new CredentialVault(file).load('repository')).rejects.toThrow('无法读取加密凭据文件')
    await writeFile(file, '{"version":1,"entries":{}}')
    storage.encryptString.mockImplementationOnce(() => { throw new Error('Authorization: ghp_hidden-token') })
    await expect(new CredentialVault(file).save('repository', 'ghp_hidden-token')).rejects.toThrow('无法安全加密')
    expect(await readFile(file, 'utf8')).not.toContain('hidden-token')
  })
})
