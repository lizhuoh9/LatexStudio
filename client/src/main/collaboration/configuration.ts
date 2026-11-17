declare const __PAPERSTUDIO_GITHUB_CLIENT_ID__: string | undefined
declare const __PAPERSTUDIO_GITHUB_APP_SLUG__: string | undefined

/** Publisher-provided public OAuth/GitHub App identifier; never a client secret or an end-user PAT. */
export function validGitHubClientId(value: unknown): string | null {
  return typeof value === 'string' && /^(?:Ov|Iv)[1-9][A-Za-z0-9._-]{7,125}$/.test(value) ? value : null
}

/** Refuse suspicious publisher input before it can be embedded in a generated bundle. */
export function buildGitHubClientId(value: unknown): string {
  if (value === undefined || value === '') return ''
  const publicId = validGitHubClientId(value)
  if (!publicId) throw new Error('发布构建需要本产品的 GitHub App 公共 Client ID；未接受其他配置值。')
  return publicId
}

export function buildGitHubAppSlug(value: unknown): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(value)) {
    throw new Error('发布构建需要合法的 GitHub App 公开名称，不接受完整 URL 或密钥。')
  }
  return value
}

/** Fixed official origin; opens OAuth App connection settings or legacy App installation route when an App slug is set. */
export function githubInstallationUrl(): string {
  const slug = typeof __PAPERSTUDIO_GITHUB_APP_SLUG__ === 'undefined' ? '' : buildGitHubAppSlug(__PAPERSTUDIO_GITHUB_APP_SLUG__)
  if (slug) return `https://github.com/apps/${slug}/installations/new`
  const clientId = githubClientId()
  return clientId ? `https://github.com/settings/connections/applications/${clientId}` : 'https://github.com/settings/applications'
}

export function githubClientId(): string | null {
  return validGitHubClientId(typeof __PAPERSTUDIO_GITHUB_CLIENT_ID__ === 'undefined'
    ? null : __PAPERSTUDIO_GITHUB_CLIENT_ID__)
}
