# LatexStudio

Local-first LaTeX desktop workbench for Windows and macOS, with real project files, PDF preview, file history and GitHub-based paper collaboration.

## Download and updates

Get versioned packages from [GitHub Releases](https://github.com/lizhuoh9/LatexStudio/releases). **Do not run raw repository code as an installed-app update.**

- Windows x64: choose the `setup.exe` installer, or `portable.exe` for a portable copy.
- macOS: Apple Silicon (M-series) only; Intel Macs are not supported (check Apple menu → About This Mac). Open the `mac-arm64` DMG and drag LatexStudio to Applications. It is an **editing test build**, ad-hoc signed, not Apple-notarized, so the first launch is blocked: click Done, then System Settings → Privacy & Security → Open Anyway. Mac local TeX compilation is not enabled.
- Current packages are **unsigned development releases**, not trusted signed production installers. The app checks public release metadata but never silently downloads, quits or installs. Use the account menu → 检查更新 → 打开版本下载页, save drafts, close normally, then install manually.
- Signed automatic installation remains disabled until publisher identity/signing and the original installer upgrade path have been accepted. No signature-check bypass or client-side publisher secret is used.

The display name is LatexStudio. The historical package/application identifiers and resource filenames are retained internally for compatibility; existing data must not be deleted to upgrade.

## Interface languages

The complete application UI supports **简体中文 / English / 한국어**. Open the account/avatar menu → **Language / 语言 / 언어**; the choice applies immediately and persists across restarts. Paper text, filenames, identities, original revision notes and compiler output are preserved. Language changes do not sign in, synchronize, compile or rewrite a draft. See the [trilingual interface guide](docs/INTERFACE-LANGUAGES.md) for scope and operating-system controls.

## Workbench

An independent project homepage opens a single-paper editor: files and chapter outline on the left, source in the middle, PDF/compile on the right, an independent read-only History mode with recorded files, central colored source comparison and a right-side timeline. Sync is scoped to the current paper. Logs can be opened/closed without covering the file outline.

Local editing requires no account. GitHub login opens the official device-authorization page; the short code is still required. Version 0.3.8 automatically rotates device-flow access/refresh credentials in Main, stores them only under OS encryption, and revalidates identity before restored authority. Short access-token expiry no longer requires repeated manual login; temporary offline startup retries automatically. Logout removes local login. Revoked/expired refresh authorization or unavailable secure storage remain exceptions. Upgrading an old access-only record requires one explicit login to obtain a renewable pair. No App secret, credentials in Renderer/source, or globally disabled GitHub expiry. Paper repositories, documents and credentials are separate from this software repository.

## Share and join a project

Sync the files you intend to share, then click **Share** to copy a `latexstudio://join/owner/repository` link. The recipient can open it with an installed app, or choose **Join project** on the homepage and paste it (a normal GitHub HTTPS repository URL also works). After explicit confirmation, choose an empty local folder and download; editing and Sync keep the original repository, not a newly created remote copy. Opening a link alone never signs in, accepts an invitation, selects a folder or transfers files.

Private repository membership is still required. Since 0.4.7 sign-in uses a GitHub OAuth App device flow with the `repo` scope (one authorization for your repositories instead of per-repository App installation); the app still reads and writes only the private project you explicitly create, link, download or sync, and you can revoke it under GitHub Settings → Applications → Authorized OAuth Apps. A link is not an access credential. Development/portable copies do not claim the OS protocol; paste the link inside the app instead. See the [sharing guide](docs/PROJECT-SHARING.md) for permissions, cancellation and the clearly separated mocked desktop versus real-account verification boundaries.

## Build from source

Use Node.js 24 LTS and the exact lockfile:

```sh
cd client
npm ci
npm run audit:source
npm run typecheck
npm test
npm run build
```

On Windows, `npm run dist:win -- --publish never` stages the fixed SHA-256-verified TinyTeX resource and creates unsigned NSIS/portable artifacts. The 247MB archive is intentionally absent from Git; the pinned upstream URL, length and digest are in `client/src/main/tex/resource-policy.ts`. Native engine/helper binaries, their source/patches and license notices are included. Ordinary app startup uses packaged offline components, not system TeX or a shell fallback.

On a real Mac, `npm run dist:mac:test` creates an editing DMG for that Mac's CPU with an explicit development entitlement profile; the release runner is Apple Silicon, so releases carry the arm64 DMG only. No application ZIP is produced. It does not prove real Mac GUI/permissions or formal signing acceptance.

## Release workflow

Commits to `main` run source checks. A `vX.Y.Z` tag matching `client/package.json` runs Windows and macOS builds and publishes immutable release assets, corresponding application source and checksums. Existing tags/assets are not force-replaced. See [release notes](docs/RELEASE-NOTES.md).

## License

GNU AGPL v3 only for the combined application. Preserve [LICENSE](LICENSE) and [third-party notices](client/THIRD_PARTY_NOTICES.md). This includes two pinned AyakaLeaf/Overleaf source modules; no upstream branding or remote application runtime is bundled. TeX engines/packages and other dependencies retain their respective licenses and corresponding-source obligations. Releases must keep exact application source/build scripts/lockfile available alongside binaries.
