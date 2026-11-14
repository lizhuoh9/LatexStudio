#!/usr/bin/env bash
# Build statically linked pdfTeX, XeTeX and xdvipdfmx for Windows x64 from the pinned
# TeX Live source plus the reviewed PaperStudio kpathsea and XPDF safety patches. Run in an MSYS2 UCRT64 shell:
#   GIT=/path/to/git MSYSTEM=UCRT64 /c/msys64/usr/bin/bash -l build-engines.sh <texlive-source-checkout> <output-dir>
# The checkout must be a git sparse checkout of TeX-Live/texlive-source at $PINNED_COMMIT.
set -euo pipefail

PINNED_COMMIT=6a300188053b8f2ded89dbd52293732a706b9c0e   # tags/texlive-2026.1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$HERE/kpathsea-access-denied-literal.patch"
STATE_PATCH="$HERE/xpdf-state-paths-init.patch"
SRC="$(cd "${1:?source checkout}" && pwd)"
OUT="${2:?output directory}"
JOBS="${JOBS:-8}"
XETEX="${XETEX:-1}"  # XETEX=0 builds pdfTeX + xdvipdfmx only (XeTeX needs fontconfig, not in the TL tree)
if [[ "$XETEX" == 1 ]]; then XETEX_FLAG=--enable-xetex; PROGRAMS="pdftex.exe xetex.exe xdvipdfmx.exe bibtex.exe"; else XETEX_FLAG=--disable-xetex; PROGRAMS="pdftex.exe xdvipdfmx.exe bibtex.exe"; fi
GIT="${GIT:-git}"   # MSYS2 may lack git; pass Git for Windows explicitly

[[ "${MSYSTEM:-}" == UCRT64 ]] || { echo "Run inside MSYS2 UCRT64" >&2; exit 2; }
[[ "$("$GIT" -C "$SRC" rev-parse HEAD)" == "$PINNED_COMMIT" ]] || { echo "Source is not $PINNED_COMMIT" >&2; exit 2; }

# Start from the exact upstream bytes, then apply only the reviewed patches.
"$GIT" -C "$SRC" -c core.autocrlf=false checkout -q -- .
"$GIT" -C "$SRC" clean -xdfq -e /build-paperstudio/   # no untracked sources may enter the build
"$GIT" -C "$SRC" -c core.autocrlf=false apply --whitespace=nowarn "$PATCH"
"$GIT" -C "$SRC" -c core.autocrlf=false apply --whitespace=nowarn "$STATE_PATCH"
# git checkouts lose upstream timestamps: keep the shipped generated parsers/lexers newer than their
# grammars so neither yacc nor lex is needed (and the reviewed upstream outputs are used as-is).
while IFS= read -r grammar; do
  for generated in "${grammar%.*}.c" "${grammar%.*}.h"; do [[ -f "$generated" ]] && touch "$generated"; done
done < <(find "$SRC/texk" -name '*.y' -o -name '*.l')
# Build-environment workaround only (same as MSYS2's texlive-bin 0006 patch, applied to Makefile.in so no
# autotools are needed): MSYS mangles relative WEB path lists passed to native tangle, so make them absolute.
sed -i 's/WEBINPUTS=\.:\$(srcdir)/WEBINPUTS=`cygpath -ua .`:`cygpath -ua $(srcdir)`/g' "$SRC/texk/web2c/Makefile.in"

BUILD="$SRC/build-paperstudio"
# REUSE=1 keeps finished library objects while iterating; release builds must use the default clean build.
if [[ "${REUSE:-0}" != 1 ]]; then rm -rf "$BUILD"; fi
mkdir -p "$BUILD" "$OUT"
cd "$BUILD"

export CFLAGS="-O2 -Wno-incompatible-pointer-types -std=gnu17"
export CXXFLAGS="-O2"
# libtool strips a bare -static; the GCC alias --static reaches the driver, so libwinpthread etc. link statically.
export LDFLAGS="--static -static-libgcc -static-libstdc++"
if [[ "$XETEX" == 1 ]]; then
  # XeTeX needs fontconfig, which the TL tree lacks: use the MSYS2 static libraries (fontconfig, expat, libintl,
  # libiconv) from a private staging dir so no other MSYS2 header can shadow the TL-bundled libraries, and resolve
  # FreeType from TL's own libfreetype.a (same 2.14.1). Pre-seeding the cache skips configure's -lfontconfig-only
  # link probe, which cannot succeed for a static fontconfig.
  FC="$BUILD/fontconfig-stage"
  rm -rf "$FC" && mkdir -p "$FC/include" "$FC/lib"
  cp -r "$MINGW_PREFIX/include/fontconfig" "$FC/include/"
  for archive in libfontconfig.a libexpat.a libintl.a libiconv.a; do cp "$MINGW_PREFIX/lib/$archive" "$FC/lib/"; done
  export kpse_cv_have_fontconfig=yes
  export kpse_cv_fontconfig_includes="-I$FC/include"
  export kpse_cv_fontconfig_libs="-L$FC/lib -lfontconfig $BUILD/libs/freetype2/libfreetype.a -lexpat -lintl -liconv"
fi
../configure -C \
  --disable-all-pkgs --enable-web2c --enable-dvipdfm-x \
  --enable-pdftex "$XETEX_FLAG" \
  --disable-tex --disable-mf --disable-mp --disable-pmp --disable-upmp \
  --disable-luatex --disable-luajittex --disable-luahbtex --disable-luajithbtex \
  --disable-mflua --disable-mfluajit \
  --disable-aleph --disable-euptex --disable-hitex --disable-web-progs \
  --disable-shared --enable-static --disable-multiplatform \
  --disable-native-texlive-build --disable-missing --without-x \
  --without-system-gd --without-system-cairo --without-system-pixman --without-system-potrace \
  --without-system-mpfr --without-system-gmp --without-system-mpfi --without-system-luajit \
  --with-banner-add="/PaperStudio kpathsea patch" > configure.log 2>&1 \
  || { tail -40 configure.log; exit 1; }

# git checkouts lose upstream timestamps, so shipped .info files can look stale; the manuals are not needed.
make -j"$JOBS" MAKEINFO=true > make.log 2>&1 || { tail -60 make.log; exit 1; }
# Classic BibTeX only (the other WEB programs, incl. upTeX tools, stay disabled).
make -C texk/web2c MAKEINFO=true bibtex.exe >> make.log 2>&1 || { tail -60 make.log; exit 1; }

for program in $PROGRAMS; do
  case "$program" in xdvipdfmx.exe) cp "$BUILD/texk/dvipdfm-x/$program" "$OUT/" ;; *) cp "$BUILD/texk/web2c/$program" "$OUT/" ;; esac
done
cd "$OUT"
# Optional owned build evidence; never copied into the shipped engine directory.
if [[ "${KEEP_DEBUG:-0}" == 1 ]]; then
  mkdir -p debug
  for program in $PROGRAMS; do cp "$program" "debug/$program"; done
fi
# Drop the appended COFF symbol table first: mt.exe would otherwise leave a dangling symbol-table pointer.
# shellcheck disable=SC2086
strip --strip-all $PROGRAMS
# UTF-8 active code page manifest (non-ASCII paths such as a Chinese user name); see embed-manifest.sh.
# shellcheck disable=SC2086
bash "$HERE/embed-manifest.sh" $PROGRAMS
# Outputs must import only Windows system DLLs (no MSYS2 runtime beside the engine). An unreadable PE fails the build.
for program in $PROGRAMS; do
  headers="$(objdump -p "$program")" || { echo "$program is not a readable PE after post-processing" >&2; exit 1; }
  # "UTF-8" alone also occurs in library strings, so require the manifest element name itself.
  grep -q 'activeCodePage' <(strings -el "$program"; strings "$program") || { echo "$program lacks the UTF-8 manifest" >&2; exit 1; }
  foreign="$(sed -n 's/^\s*DLL Name: //p' <<< "$headers" \
    | grep -viE '^(api-ms-win-crt-[a-z0-9-]+|kernel32|advapi32|shell32|user32|gdi32|wsock32|ws2_32|ole32|shlwapi|bcrypt|crypt32)\.dll$' || true)"
  [[ -z "$foreign" ]] || { echo "$program imports non-system DLLs: $foreign" >&2; exit 1; }
done
# shellcheck disable=SC2086
sha256sum $PROGRAMS "$PATCH" "$STATE_PATCH" | sed "s#$HERE/##" > SHA256SUMS
cat SHA256SUMS
