# Patched Windows TeX engines: provenance and corresponding source

User product decision 2026-11-12: fix the AppContainer path-initialization failure by patching kpathsea
instead of granting the sandbox list rights on real ancestor directories.

## Why

Under the production AppContainer session, kpathsea normalizes the engine's own path by calling
`FindFirstFile` on every ancestor prefix. Prefixes whose parent is outside the granted roots return
`ERROR_ACCESS_DENIED` (5), so pdfTeX stopped with
`Can't get long name for D:\TOOL.` The current diagnostic source is
[`sandbox-windows-path.test.ts`](../../../tests/sandbox-windows-path.test.ts); it is opt-in
via `PAPERSTUDIO_SANDBOX_PATH_SMOKE=1` and uses app-owned fixtures only.

## The patch

[`kpathsea-access-denied-literal.patch`](kpathsea-access-denied-literal.patch), against TeX Live source
`TeX-Live/texlive-source` commit `6a300188053b8f2ded89dbd52293732a706b9c0e` (`tags/texlive-2026.1`;
pdfTeX 1.40.29, kpathsea 6.4.2, the versions in the pinned TinyTeX v2026.11 tree):

- `texk/kpathsea/mingw32.c` (`get_long_basename`, used by MinGW builds) and
  `texk/kpathsea/win32lib.c` (`kpathsea_getlongpath`, used by MSVC builds; kept so the source matches both).
- Only when the query fails with `ERROR_ACCESS_DENIED`, the literal path component is kept instead of failing.
  In the MinGW function this also covers the final component; only the engine's own path goes through it.
  Missing paths and any other error still fail; components containing `*` or `?` are never accepted.
- No permission is granted anywhere. The sandbox still cannot list or read those ancestors.

## XPDF state-pointer initialization

[`xpdf-state-paths-init.patch`](xpdf-state-paths-init.patch) initializes `pagesFile`, `tabStateFile` and
`sessionFile` to NULL before platform state-path discovery. In the fixed upstream `GlobalParams.cc`, a failed
Windows `SHGetFolderPathA(CSIDL_APPDATA)` returns before assigning these members, while the destructor still
deletes them. Initializing them makes that error path safe without granting AppData access or faking its path.

Real production-isolation diagnostics reproduced `0xc0000005` with PDF inclusion, but ordinary text, AMS math
and TikZ/hyperref without a PDF figure succeeded. Windows crash RVA and object-layout inspection point to these
uninitialized `GString*` destructor calls. The accepted shipped Windows pdfTeX is now pinned at SHA-256
`502ec6c709cd2f1edc97a18a3256fa2f8812b2d968127bfb61611b7fc85491f0`, from the clean `XETEX=0` build with this fix.
The fresh-profile, network-denied production-isolation acceptance passed the full scientific document with an
included PDF figure, plus the suite's bibliography and Chinese XeLaTeX cases using their respective pinned tools.
This is measured acceptance of those exact Windows bytes, not a claim from source inspection, macOS acceptance,
or signed original-installer installation/uninstallation acceptance. This patch changes no sandbox permissions,
process limits, format source or project execution policy.

## Build

[`build-engines.sh`](build-engines.sh) runs in MSYS2 UCRT64 (gcc 15.2.0 Rev8 and MSYS2 `make`; the patch is
applied with `git apply`). It refuses any other source commit, resets the checkout to the upstream bytes and
removes untracked files, applies only these two reviewed patches,
and builds static `pdftex.exe`, `xetex.exe` (with `XETEX=1`), `xdvipdfmx.exe` and classic `bibtex.exe` (built as the single
web2c target; the other WEB programs stay disabled). All libraries come from the TeX Live
tree except fontconfig, which the tree lacks: XeTeX statically links MSYS2's `libfontconfig.a` (fontconfig 2.17.1-1),
`libexpat.a` (expat 2.7.3-1), `libintl.a` (gettext-runtime 0.26-2) and `libiconv.a` (libiconv 1.18-1), copied into a
private staging directory so no other MSYS2 header can shadow a TL-bundled library; FreeType is TL's own 2.14.1
(same version as MSYS2's). After linking it strips the COFF symbol table and embeds [`utf8.manifest`](utf8.manifest)
with `mt.exe` ([`embed-manifest.sh`](embed-manifest.sh); Windows SDK 10.0.26100): the UTF-8 active code page makes
arguments, environment and file names with non-ASCII characters (e.g. a Chinese user name in the profile path) reach
kpathsea/TeX as UTF-8; without it pdfTeX could not find `article.cls` and XeTeX not even its format under such a path.
It fails if any output is not a readable PE, lacks the manifest, or imports a DLL outside the Windows system set.

```bash
GIT=/path/to/git.exe XETEX=1 MSYSTEM=UCRT64 /c/msys64/usr/bin/bash -lc 'bash build-engines.sh <checkout> <out>'
# The current pdfTeX was rebuilt separately with XETEX=0; keep its output distinct from the XETEX=1 tools.
# Optional diagnostic artifact retention (not included in shipped resources): KEEP_DEBUG=1
```

Build-environment workarounds (they do not change engine code): upstream generated parsers are marked newer
than their grammars, manuals are skipped (`MAKEINFO=true`), and web2c's relative `WEBINPUTS` lists are made
absolute with `cygpath` (the same fix as MSYS2's own texlive-bin package). The sparse checkout must contain
the top-level files plus `build-aux m4 am doc auxdir`, the top-level files of `libs utils texk`,
`libs/{zlib,libpng,freetype2,harfbuzz,icu,graphite2,teckit,pplib,xpdf,libpaper,zziplib}`,
`texk/{kpathsea,web2c,dvipdfm-x,ptexenc}` and `texk/texlive/windows_wrapper`.

The current shipped overlay has mixed, explicit provenance: pdfTeX comes from the clean `XETEX=0` rebuild with
the XPDF null-state fix; XeTeX, xdvipdfmx and BibTeX retain the previously accepted clean `XETEX=1` build bytes.
The earlier build ran the `git clean` step, then strip + manifest + checks were re-run on its own objects
(`REUSE=1`, no source change at that stage). Do not describe all current binaries as one identical build.
Both reviewed patches and the exact source commit remain corresponding-source inputs; the app's hashes identify
which accepted output is actually distributed.
XeTeX reads `fonts.conf` from the overlay (pinned; the sandbox helper sets `FONTCONFIG_FILE`): TeX's OpenType/TrueType
directories, the Windows font folder, and a font cache under the per-compile work directory (cold scan each compile).

The builds are not byte-reproducible (PE timestamps), so the app pins the exact bytes it ships in
`client/src/main/tex/patched-engines.ts`; the binaries are in `client/resources/win32/tex-engines/`.

## Not covered

- Biber (biblatex's default backend), LuaLaTeX, macOS.
- No persistent fontconfig cache: each XeLaTeX compile rescans fonts (about 3 s on the development machine).

## Licenses

pdfTeX, XeTeX and dvipdfmx/xdvipdfmx are GPL (XeTeX: X11-style for its own parts); kpathsea is LGPL; the bundled
libraries keep their own licenses (TeX Live tree). Statically linked MSYS2 libraries: fontconfig and expat (MIT-style),
libintl and libiconv (LGPL-2.1-or-later); their corresponding sources are the MSYS2 MINGW-packages releases named above.
Redistribution must include both patches, the build script and the exact upstream source commit,
alongside the license texts listed in `client/THIRD_PARTY_NOTICES.md`.
