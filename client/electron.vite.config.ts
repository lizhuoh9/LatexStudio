import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { resolvePublicGitHubApp } from './github-app.public'

const githubApp = resolvePublicGitHubApp()
export default defineConfig({
  // The main bundle is CommonJS: a lazily loaded dependency stays a plain require(), as it was when imported statically.
  main: { build: { externalizeDeps: true, rollupOptions: { output: { dynamicImportInCjs: false } } }, define: {
    __PAPERSTUDIO_GITHUB_CLIENT_ID__: JSON.stringify(githubApp.clientId),
    __PAPERSTUDIO_GITHUB_APP_SLUG__: JSON.stringify(githubApp.appSlug)
  } },
  preload: { build: { rollupOptions: { output: { format: 'cjs' } } } },
  renderer: { resolve: { alias: { '@shared': resolve('src/shared') } } }
})
