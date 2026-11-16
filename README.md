# LatexStudio

Local-first LaTeX desktop workbench for Windows and macOS, with real project files, PDF preview, file history and GitHub-based paper collaboration.

## Download and updates

Get versioned packages from [GitHub Releases](https://github.com/lizhuoh9/LatexStudio/releases). **Do not run raw repository code as an installed-app update.**

- Windows x64: choose the `setup.exe` installer, or `portable.exe` for a portable copy.
- macOS: the available native-architecture ZIP is an **editing test build**, ad-hoc signed, not Apple-notarized. Mac local TeX compilation is not enabled.
- Current packages are **unsigned development releases**, not trusted signed production installers. The app checks public release metadata but never silently downloads, quits or installs. Use the account menu → 检查更新 → 打开版本下载页, save drafts, close normally, then install manually.
- Signed automatic installation remains disabled until publisher identity/signing and the original installer upgrade path have been accepted. No signature-check bypass or client-side publisher secret is used.

The display name is LatexStudio. The historical package/application identifiers and resource filenames are retained internally for compatibility; existing data must not be deleted to upgrade.

## Workbench

An independent project homepage opens a single-paper editor: files and chapter outline on the left, source in the middle, PDF/compile on the right, an independent read-only History mode with recorded files, central colored source comparison and a right-side timeline. Sync is scoped to the current paper. Logs can be opened/closed without covering the file outline.

Local editing requires no account. GitHub login opens the official device-authorization page; the short code is still required. Version 0.3.8 automatically rotates device-flow access/refresh credentials in Main, stores them only under OS encryption, and revalidates identity before restored authority. Short access-token expiry no longer requires repeated manual login; temporary offline startup retries automatically. Logout removes local login. Revoked/expired refresh authorization or unavailable secure storage remain exceptions. Upgrading an old access-only record requires one explicit login to obtain a renewable pair. No App secret, credentials in Renderer/source, or globally disabled GitHub expiry. Paper repositories, documents and credentials are separate from this software repository.

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

On a real Mac, `npm run dist:mac:test` creates a native-architecture editing ZIP with an explicit development entitlement profile. It does not prove real Mac GUI/permissions or formal signing acceptance.

## Release workflow

Commits to `main` run source checks. A `vX.Y.Z` tag matching `client/package.json` runs Windows and macOS builds and publishes immutable release assets, corresponding application source and checksums. Existing tags/assets are not force-replaced. See [release notes](docs/RELEASE-NOTES.md).

## License

GNU AGPL v3 only for the combined application. Preserve [LICENSE](LICENSE) and [third-party notices](client/THIRD_PARTY_NOTICES.md). This includes two pinned AyakaLeaf/Overleaf source modules; no upstream branding or remote application runtime is bundled. TeX engines/packages and other dependencies retain their respective licenses and corresponding-source obligations. Releases must keep exact application source/build scripts/lockfile available alongside binaries.
