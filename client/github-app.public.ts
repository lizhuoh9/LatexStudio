import { buildGitHubAppSlug, buildGitHubClientId } from './src/main/collaboration/configuration'

// Publisher-confirmed PUBLIC OAuth App identifier (Device Flow with repo scope), never a secret or token.
export const publicGitHubApp = Object.freeze({ clientId: 'Ov23limlAorsJo0xsOgA', appSlug: '' })

/** Explicit empty overrides still produce an unconfigured build; malformed overrides fail closed. */
export function resolvePublicGitHubApp(environment: NodeJS.ProcessEnv = process.env): { clientId: string; appSlug: string } {
  return {
    clientId: buildGitHubClientId(environment.PAPERSTUDIO_GITHUB_CLIENT_ID ?? publicGitHubApp.clientId),
    appSlug: buildGitHubAppSlug(environment.PAPERSTUDIO_GITHUB_APP_SLUG ?? publicGitHubApp.appSlug)
  }
}
