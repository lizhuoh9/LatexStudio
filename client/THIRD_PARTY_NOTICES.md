# Third-party notices · 第三方来源与许可

## AyakaLeaf Pro / Overleaf source reuse — GNU AGPL v3

This local-first workbench reuses two **actual source modules**, not only the same editor dependency. It is not the full upstream editor, web UI, collaboration system, server, authentication or compiler.

- Repository: https://github.com/ayaka-notes/ayakaleaf-pro
- Pinned release: `pro-v6.3.2` (annotated tag object `6c3522a46c6eab8194821532c7906bdc28be1a57`).
- Pinned commit: `925980d35f22b89931a28873db38de2d72d35cc6`.
- Upstream README attribution: Copyright (c) Overleaf, 2014-2025. Copyright (c) Pro Authors, 2026-now. Pro Authors: https://ayakaleaf-pro.ayaka.space/on-premises/readme/features-and-copyright
- License: GNU AFFERO GENERAL PUBLIC LICENSE, version 3 (AGPL-3.0-only), as declared in that release README. Full, unmodified license is [LICENSE.txt](<src/vendor/ayakaleaf/LICENSE.txt>), bundled into the About dialog for offline reading.

### Vendored modules

1. [latex-indent-service.ts](<src/vendor/ayakaleaf/latex-indent-service.ts>): upstream `services/web/frontend/js/features/source-editor/languages/latex/latex-indent-service.ts`, Git blob `d1e8e84bc4f02f30fdafa8b364c0e109676210c5`. The independent indentation extension is installed in the CodeMirror editor. Body is unchanged; provenance/license header added 2026-11-11.
2. [environments.ts](<src/vendor/ayakaleaf/environments.ts>): upstream `services/web/frontend/js/features/source-editor/languages/latex/completions/data/environments.ts`, Git blob `29414313d9c5cd18f55c8554cf4080602c8a9e95`. Complete environment/snippet map is used by the editor completion source. Body is unchanged; provenance/license header added 2026-11-11.
3. [latex-completions.ts](<src/renderer/latex-completions.ts>): new LatexStudio adapter, 2026-11-11. Converts bare upstream `$1` tabstops to the standard CodeMirror snippet syntax, and provides a standalone completion source without upstream project/document services. This integration is distributed under AGPL v3 as part of the covered combined work.

Source links are immutable:

- https://github.com/ayaka-notes/ayakaleaf-pro/blob/925980d35f22b89931a28873db38de2d72d35cc6/services/web/frontend/js/features/source-editor/languages/latex/latex-indent-service.ts
- https://github.com/ayaka-notes/ayakaleaf-pro/blob/925980d35f22b89931a28873db38de2d72d35cc6/services/web/frontend/js/features/source-editor/languages/latex/completions/data/environments.ts
- https://github.com/ayaka-notes/ayakaleaf-pro/blob/925980d35f22b89931a28873db38de2d72d35cc6/LICENSE

The upstream full LaTeX language depends on generated parser artifacts, tokenizer, tree-query helpers and web-specific metadata. Those are **not** transplanted here. Syntax highlighting uses the separate CodeMirror legacy `stex` mode. No claim of full upstream parser, UI, PDF viewer, server or original online experience is made.

### Redistribution and source availability

The reused code is free software under GNU AGPL v3, without warranty. Recipients may copy, modify and redistribute under that license. A combined derivative must meet the applicable AGPL obligations; attribution or an upstream URL alone does not satisfy Corresponding Source obligations for LatexStudio modifications. Distributors must ship the exact corresponding LatexStudio source, build scripts and dependency lockfile with equivalent access alongside binaries, preserve notices and provide the complete license. Do not publish a binary-only proprietary derivative. If offering a modified covered version for remote network interaction, also satisfy section 13. Packaging/signing and a valid source distribution location are release responsibilities, not something this notice claims has already been completed.

## CodeMirror 6 — MIT

Editor state/view/commands/language/autocomplete/search, legacy modes and Lezer highlighting are separate CodeMirror/Lezer dependencies, **not** AyakaLeaf source reuse. Their exact installed versions are recorded in the package lockfile. Copyright belongs to their package authors, including Marijn Haverbeke and contributors; preserve each distributed package's MIT license. Source: https://github.com/codemirror and https://github.com/lezer-parser .

## PDF.js — Apache License 2.0

`pdfjs-dist` 6.5.438: Mozilla Foundation and contributors. Source: https://github.com/mozilla/pdf.js . License: https://www.apache.org/licenses/LICENSE-2.0 . LatexStudio uses the shipped renderer and local worker, canvas-only, with no PDF action/link UI. Preserve PDF.js notices and license when redistributing its assets. No Mozilla endorsement is implied.

## Patched TeX Live engines (Windows) — GPL / LGPL and bundled library licenses

`resources/win32/tex-engines/pdftex.exe` (pdfTeX 1.40.29, GPL), `xetex.exe` (XeTeX 0.999998, X11-style licence with
GPL/LGPL components) and `xdvipdfmx.exe` (dvipdfm-x, GPL) are static MinGW builds of TeX Live source commit
`6a300188053b8f2ded89dbd52293732a706b9c0e` (`tags/texlive-2026.1`, https://github.com/TeX-Live/texlive-source) with one
LatexStudio patch to kpathsea (LGPL). They also link the TeX Live tree's zlib, libpng, FreeType, HarfBuzz, ICU,
graphite2, TECkit, xpdf, pplib and related libraries under their own licenses. XeTeX additionally links MSYS2 static
libraries: fontconfig 2.17.1 and expat 2.7.3 (MIT-style), libintl from gettext-runtime 0.26 and libiconv 1.18
(LGPL-2.1-or-later); their sources are the matching MSYS2 MINGW-packages releases (including MSYS2's own patches).
`fonts.conf` is LatexStudio's own. Because libintl and libiconv are linked statically, a distribution must also let
recipients relink XeTeX against modified versions of them: ship or offer the complete XeTeX build inputs (the TeX Live
commit, this patch, `build-engines.sh`, the exact MSYS2 package sources) together with the LGPL-2.1 text, and the
fontconfig and expat copyright/licence texts. This is a provenance record, not legal advice. The patch, build script and
sparse-checkout list are in `resources/win32/tex-patches/` (see its README). Any distribution of these binaries must
ship or offer that corresponding source: the upstream commit, the patch, the build script and the license texts.
The fixed TinyTeX archive is fetched and verified at Windows build time, then embedded for offline preparation; its resource tree keeps its own TeX Live licenses (`LICENSE.TL`, `LICENSE.CTAN`).

`resources/win32/tex-engines/bibtex.exe` is classic BibTeX 0.99e from the same TeX Live commit (Knuth-style free
licence). All four engine binaries embed `resources/win32/tex-patches/utf8.manifest` (LatexStudio's own).

## TeX packages for Chinese and GB/T 7714 — LPPL 1.3c

`resources/tex-packages/texmf-paperstudio` holds unmodified runtime files of the TeX Live packages ctex (r79993),
xecjk (r80059), zhnumber (r80458) and gbt7714 (r80402), taken from TeX Live tlnet containers whose SHA-512 matched the
official texlive.tlpdb; the containers' TeX Live metadata is kept in `resources/tex-packages/provenance`. They are
distributed under the LaTeX Project Public License 1.3c (https://www.latex-project.org/lppl/); sources are on CTAN.
No fonts are bundled: Chinese text uses the user's installed Windows fonts (SimSun, SimHei, KaiTi, FangSong).

## Electron and other dependencies

Electron/Chromium/Node and build/runtime dependencies retain their own licenses and notices. Release packaging must preserve Electron's generated LICENSE and third-party Chromium notices and the actual dependency notices. This file is a provenance record, not legal advice or a substitute for a complete release license review.
