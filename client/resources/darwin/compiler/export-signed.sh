#!/bin/sh
# Publisher step, on a Mac, after build.sh built and signed a NEW helper (changed helper source, TeX tree or package
# tree): copies the signed pieces into ../signed for committing, writes ../signed/PROVENANCE.json and prints the value
# for MAC_HELPER_SHA256 in src/main/tex/darwin-runtime.ts. Run the real-Mac acceptance (scripts/mac-phase0.sh) on that
# helper first; tests/mac-helper-seal.test.ts then checks the committed pieces against the pins on any platform.
#
#   sh export-signed.sh [directory-holding-LatexStudioCompiler.app]     (default: ../ , i.e. client/resources/darwin)
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
APP="${1:-"$HERE/.."}/LatexStudioCompiler.app"
SIGNED="$HERE/../signed"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "export-signed.sh runs on macOS only" >&2
  exit 1
fi
codesign --verify --strict "$APP"
if ! cmp -s "$APP/Contents/Info.plist" "$HERE/Info.plist"; then
  echo "export-signed.sh: the bundle's Info.plist differs from compiler/Info.plist (a test build with another identifier?)" >&2
  exit 1
fi
mkdir -p "$SIGNED"
cp "$APP/Contents/MacOS/latexstudio-compiler" "$SIGNED/latexstudio-compiler"
# -n: no file name or time in the archive, so the same list always gives the same bytes.
gzip -n -9 -c "$APP/Contents/_CodeSignature/CodeResources" > "$SIGNED/CodeResources.gz"

digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
CDHASH=$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p')
CLANG=$("$(xcode-select -p)/usr/bin/clang" --version | head -1)
cat > "$SIGNED/PROVENANCE.json" <<EOF
{
  "what": "LatexStudioCompiler.app pieces signed once on a Mac; every build re-assembles the bundle from them (compiler/assemble.sh) without compiling or signing.",
  "builtOn": "$(date +%Y-%m-%d), $(uname -m), macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion))",
  "toolchain": "$CLANG, macOS SDK $(xcrun --show-sdk-version)",
  "command": "node scripts/prepare-bundled-tex-darwin.cjs && sh resources/darwin/compiler/build.sh && sh resources/darwin/compiler/export-signed.sh",
  "signature": "ad-hoc, hardened runtime, entitlement com.apple.security.app-sandbox only",
  "cdhash": "$CDHASH",
  "sources": {
    "compiler/latexstudio-compiler.c": "$(digest "$HERE/latexstudio-compiler.c")",
    "compiler/Info.plist": "$(digest "$HERE/Info.plist")",
    "compiler/compiler.entitlements.plist": "$(digest "$HERE/compiler.entitlements.plist")"
  },
  "signed": {
    "latexstudio-compiler": "$(digest "$SIGNED/latexstudio-compiler")",
    "CodeResources.gz": "$(digest "$SIGNED/CodeResources.gz")"
  },
  "acceptance": "fill in: where the scripts/mac-phase0.sh result for this helper is recorded"
}
EOF

echo "exported to $SIGNED"
echo "MAC_HELPER_SHA256 = $(digest "$SIGNED/latexstudio-compiler")"
echo "cdhash: $CDHASH"
echo "DARWIN_INSTALL_TREE_SHA256 is the treeSha256 printed by scripts/prepare-bundled-tex-darwin.cjs (unchanged unless TinyTeX changed)."
