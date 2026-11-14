# Bundled Windows TeX release resource

This directory is **required build/distribution input**, not an old experimental cache.
`npm run prepare:tex-runtime` stages exactly the Windows ZIP named by its SHA-256 from
`src/main/tex/resource-policy.ts` (`TEX_ASSETS.win32`). That source is the sole authority for
release URL, byte length and digest. Existing files are checked again before reuse; corrupt,
linked, duplicate or unexpected archive files fail the build and are not silently overwritten.

`pack:win` / `dist:win` explicitly run this publisher-only preparation step. The ZIP and this
notice are packaged at `process.resourcesPath/tex-runtime/`; first-use application preparation
must use those fixed local bytes without downloading them. Ordinary `npm run build` does not
silently fetch resources. The preparation script never extracts or executes downloaded files,
launches TeX, changes an OS profile/ACL, or touches an application user profile.

## Upstream and redistribution

- Fixed archive source: <https://github.com/rstudio/tinytex-releases/releases> (TinyTeX, by
  Yihui Xie and contributors); source/recipe: <https://github.com/rstudio/tinytex> and
  <https://github.com/rstudio/tinytex-releases>.
- The enclosed TeX Live tree retains its own `LICENSE.TL` and `LICENSE.CTAN` and package-specific
  notices. Preserve these files; TinyTeX is not a blanket replacement license for the many TeX
  Live components. TeX Live licensing: <https://tug.org/texlive/copying.html>.
- PaperStudio's patched Windows executables and Chinese package overlays are separate resources
  with their own provenance, licenses and corresponding-source obligations. See
  `../../THIRD_PARTY_NOTICES.md` and `../win32/tex-patches/README.md` in the source distribution.
- Shipping this pinned ZIP does not prove all redistribution obligations, original installer
  acceptance, Authenticode signing, or macOS production compilation have been completed.

Large ZIP bytes are intentionally Git-ignored but explicitly included by Windows packaging.
Do not delete this directory as part of historical `release/` experiment-cache cleanup.
