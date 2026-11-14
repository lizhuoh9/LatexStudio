declare const __PAPERSTUDIO_GITHUB_CLIENT_ID__: string | undefined
declare const __PAPERSTUDIO_GITHUB_APP_SLUG__: string | undefined

/** Publisher-provided public app identifier; never a client secret or an end-user PAT. */
export function validGitHubClientId(value: unknown): string | null {
  return typeof value === 'string' && /^Iv[1-9][A-Za-z0-9._-]{7,125}$/.test(value) ? value : null
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

/** Fixed official origin; no renderer-provided URL or credential can enter the browser launcher. */
export function githubInstallationUrl(): string {
  const slug = typeof __PAPERSTUDIO_GITHUB_APP_SLUG__ === 'undefined' ? '' : buildGitHubAppSlug(__PAPERSTUDIO_GITHUB_APP_SLUG__)
  return slug ? `https://github.com/apps/${slug}/installations/new` : 'https://github.com/settings/installations'
}

export function githubClientId(): string | null {
  return validGitHubClientId(typeof __PAPERSTUDIO_GITHUB_CLIENT_ID__ === 'undefined'
    ? null : __PAPERSTUDIO_GITHUB_CLIENT_ID__)
}
