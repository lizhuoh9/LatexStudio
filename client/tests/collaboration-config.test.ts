import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGitHubAppSlug, buildGitHubClientId, githubClientId, githubInstallationUrl, validGitHubClientId } from '../src/main/collaboration/configuration'
import { publicProject, publicState } from '../src/main/collaboration/public-state'
import type { CollaborationState } from '../src/shared/collaboration-contracts'
import { publicGitHubApp, resolvePublicGitHubApp } from '../github-app.public'

afterEach(() => vi.unstubAllGlobals())

describe('publisher public app configuration', () => {
  it('defaults to unavailable without a publisher identifier', () => {
    vi.stubGlobal('__PAPERSTUDIO_GITHUB_CLIENT_ID__', undefined)
    expect(githubClientId()).toBeNull()
  })
  it('accepts only a bounded public client identifier', () => {
    expect(validGitHubClientId('Iv1.paperstudio-fixture')).toBe('Iv1.paperstudio-fixture')
    for (const input of [null, 12, '', 'short', 'x'.repeat(129), 'https://github.com', 'abc defghijk', ' abcdefghijk']) {
      expect(validGitHubClientId(input)).toBeNull()
    }
  })
  it('uses the build-time identifier and never runtime account configuration', () => {
    vi.stubGlobal('__PAPERSTUDIO_GITHUB_CLIENT_ID__', 'Iv1.paperstudio-fixture')
    expect(githubClientId()).toBe('Iv1.paperstudio-fixture')
  })
  it('rejects a malformed build-time identifier', () => {
    vi.stubGlobal('__PAPERSTUDIO_GITHUB_CLIENT_ID__', 'fixture\nidentifier')
    expect(githubClientId()).toBeNull()
  })
})

describe('publisher build input is not a credential field', () => {
  it('keeps missing builds unconfigured and allows reviewed public shapes', () => {
    expect(buildGitHubClientId(undefined)).toBe('')
    expect(buildGitHubClientId('')).toBe('')
    expect(buildGitHubClientId('Iv1.paperstudio-fixture')).toBe('Iv1.paperstudio-fixture')
    expect(buildGitHubClientId('Iv23fixture-client')).toBe('Iv23fixture-client')
  })
  it('rejects app numbers, OAuth identifiers and recognizable credential shapes', () => {
    for (const input of ['1234567890', 'a'.repeat(40), 'ghp_' + 'x'.repeat(40), 'github_pat_' + 'x'.repeat(60)]) {
      expect(validGitHubClientId(input)).toBeNull()
      expect(() => buildGitHubClientId(input)).toThrow('公共 Client ID')
    }
  })
  it('does not interpolate rejected values into build errors', () => {
    const rejected = 'CANARY_PRIVATE_REJECTED'
    try { buildGitHubClientId(rejected); expect.unreachable() }
    catch (error) { expect(String(error)).not.toContain(rejected) }
  })
})

describe('publisher-controlled official installation links', () => {
  it('uses only an explicit bounded App slug, never a remote URL or credential', () => {
    expect(buildGitHubAppSlug(undefined)).toBe('')
    expect(buildGitHubAppSlug('paperstudio-lab')).toBe('paperstudio-lab')
    for (const value of ['https://evil.invalid', '../repo', 'repo?token=x', 'ghp_CANARY', 'UpperCase', '-bad', 'bad-', 'a'.repeat(101)]) {
      expect(() => buildGitHubAppSlug(value)).toThrow('公开名称')
    }
  })
  it('opens the exact configured official App installation route', () => {
    vi.stubGlobal('__PAPERSTUDIO_GITHUB_APP_SLUG__', 'paperstudio-lab')
    expect(githubInstallationUrl()).toBe('https://github.com/apps/paperstudio-lab/installations/new')
  })
  it('falls back to official installation settings without a slug', () => {
    vi.stubGlobal('__PAPERSTUDIO_GITHUB_APP_SLUG__', undefined)
    expect(githubInstallationUrl()).toBe('https://github.com/settings/installations')
  })
})

describe('reviewed public publisher defaults', () => {
  it('keeps the supplied Client ID and matching App slug across ordinary and Mac-source builds', () => {
    expect(resolvePublicGitHubApp({})).toEqual({ clientId: 'Iv23ctZVs9suln7YQPrX', appSlug: 'latexfactory' })
    expect(resolvePublicGitHubApp({})).toEqual(publicGitHubApp)
    expect(Object.isFrozen(publicGitHubApp)).toBe(true)
  })
  it('allows explicit reviewed environment overrides without mutating the defaults', () => {
    expect(resolvePublicGitHubApp({ PAPERSTUDIO_GITHUB_CLIENT_ID: 'Iv1.other-fixture', PAPERSTUDIO_GITHUB_APP_SLUG: 'other-fixture' }))
      .toEqual({ clientId: 'Iv1.other-fixture', appSlug: 'other-fixture' })
    expect(resolvePublicGitHubApp({})).toEqual(publicGitHubApp)
  })
  it('keeps explicit empty overrides unconfigured rather than silently restoring defaults', () => {
    expect(resolvePublicGitHubApp({ PAPERSTUDIO_GITHUB_CLIENT_ID: '', PAPERSTUDIO_GITHUB_APP_SLUG: '' }))
      .toEqual({ clientId: '', appSlug: '' })
  })
  it('rejects malformed overrides instead of falling back to a valid publisher identity', () => {
    expect(() => resolvePublicGitHubApp({ PAPERSTUDIO_GITHUB_CLIENT_ID: 'CANARY_PRIVATE_REJECTED' })).toThrow('公共 Client ID')
    expect(() => resolvePublicGitHubApp({ PAPERSTUDIO_GITHUB_APP_SLUG: 'https://github.com/lizhuoh9' })).toThrow('公开名称')
  })
  it('never copies unrelated credential variables into build defines', () => {
    const value = resolvePublicGitHubApp({ GITHUB_TOKEN: 'CANARY_PRIVATE', GITHUB_CLIENT_SECRET: 'CANARY_PRIVATE' })
    expect(Object.keys(value).sort()).toEqual(['appSlug', 'clientId'])
    expect(JSON.stringify(value)).not.toContain('CANARY_PRIVATE')
  })
})

describe('collaboration IPC output whitelist', () => {
  it('never serializes private service additions or mutable nested objects', () => {
    const internal = Object.assign({ phase: 'authorizing', message: 'fixture', sessionOnly: true,
      account: { id: 1, login: 'fixture-user', name: null, privateMarker: 'CANARY_PRIVATE' },
      authorization: { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: 1000,
        deviceCode: 'CANARY_PRIVATE' }, expiresAt: null } as CollaborationState, { privateMarker: 'CANARY_PRIVATE' })
    const result = publicState(internal)
    expect(JSON.stringify(result)).not.toContain('CANARY_PRIVATE')
    expect(result).not.toBe(internal)
    expect(result.account).not.toBe(internal.account)
    expect(result.authorization).not.toBe(internal.authorization)
    expect(result.sessionOnly).toBe(true)
  })
  it('exposes metadata only, not a clone URL, local path or extra capability', () => {
    const project = Object.assign({ id: 2, installationId: 3, owner: 'fixture', name: 'paper', private: true },
      { clone_url: 'https://untrusted.invalid/', localPath: 'CANARY_PRIVATE', accessToken: 'CANARY_PRIVATE' })
    expect(publicProject(project)).toEqual({ id: 2, installationId: 3, owner: 'fixture', name: 'paper', private: true })
    expect(JSON.stringify(publicProject(project))).not.toContain('CANARY_PRIVATE')
  })
})
