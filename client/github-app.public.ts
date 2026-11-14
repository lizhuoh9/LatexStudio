import { buildGitHubAppSlug, buildGitHubClientId } from './src/main/collaboration/configuration'

// Publisher-confirmed PUBLIC identifier, never a secret, token or numeric App ID.
// Supplied with the publisher's settings/apps/latexfactory page; ownership/device flow still require real-account testing.
export const publicGitHubApp = Object.freeze({ clientId: 'Iv23ctZVs9suln7YQPrX', appSlug: 'latexfactory' })

/** Explicit empty overrides still produce an unconfigured build; malformed overrides fail closed. */
export function resolvePublicGitHubApp(environment: NodeJS.ProcessEnv = process.env): { clientId: string; appSlug: string } {
  return {
    clientId: buildGitHubClientId(environment.PAPERSTUDIO_GITHUB_CLIENT_ID ?? publicGitHubApp.clientId),
    appSlug: buildGitHubAppSlug(environment.PAPERSTUDIO_GITHUB_APP_SLUG ?? publicGitHubApp.appSlug)
  }
}
