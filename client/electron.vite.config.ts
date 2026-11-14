import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { resolvePublicGitHubApp } from './github-app.public'

const githubApp = resolvePublicGitHubApp()
export default defineConfig({
  main: { build: { externalizeDeps: true }, define: {
    __PAPERSTUDIO_GITHUB_CLIENT_ID__: JSON.stringify(githubApp.clientId),
    __PAPERSTUDIO_GITHUB_APP_SLUG__: JSON.stringify(githubApp.appSlug)
  } },
  preload: { build: { rollupOptions: { output: { format: 'cjs' } } } },
  renderer: { resolve: { alias: { '@shared': resolve('src/shared') } } }
})
