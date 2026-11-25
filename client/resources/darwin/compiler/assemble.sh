#!/bin/sh
# Puts LatexStudioCompiler.app together from the pieces that were signed once on a Mac and committed
# (../signed/latexstudio-compiler, ../signed/CodeResources.gz, ./Info.plist) plus the staged TinyTeX tree
# (client/resources/tex-darwin, from scripts/prepare-bundled-tex-darwin.cjs) and the package tree
# (client/resources/tex-packages). Nothing is compiled and nothing is signed here: the result has to match the
# committed signature as it is, which is how every build machine ends up with the helper bytes the app pins.
#
#   sh assemble.sh [output-directory]     (default output: ../ , i.e. client/resources/darwin)
#
# It fails, leaving nothing behind, if a single file differs from what was signed. To change the helper, the TeX
# tree or the package tree, rebuild and re-sign with build.sh on a Mac, then run export-signed.sh.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-"$HERE/.."}
APP="$OUT/LatexStudioCompiler.app"
SIGNED="$HERE/../signed"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "assemble.sh: the helper bundle can only be put together and checked on macOS" >&2
  exit 1
fi
if [ -e "$APP" ]; then
  echo "assemble.sh: $APP already exists; remove it first (pinned bytes are never replaced silently)" >&2
  exit 1
fi
for input in "$SIGNED/latexstudio-compiler" "$SIGNED/CodeResources.gz" "$HERE/Info.plist" \
  "$HERE/../../tex-darwin/install" "$HERE/../../tex-packages/manifest.json"; do
  if [ ! -e "$input" ]; then
    echo "assemble.sh: missing $input (stage TeX with: node scripts/prepare-bundled-tex-darwin.cjs)" >&2
    exit 1
  fi
done

# A run that fails part-way leaves nothing behind that a later step could mistake for a finished helper.
DONE=0
trap '[ "$DONE" = 1 ] || rm -rf "$APP"' EXIT
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/_CodeSignature" "$APP/Contents/Resources"
cp "$SIGNED/latexstudio-compiler" "$APP/Contents/MacOS/latexstudio-compiler"
chmod 755 "$APP/Contents/MacOS/latexstudio-compiler"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
gzip -dc "$SIGNED/CodeResources.gz" > "$APP/Contents/_CodeSignature/CodeResources"
# -c clones on APFS (no extra disk space); plain copy elsewhere.
for tree in tex-darwin tex-packages; do
  source="$HERE/../../$tree"; target="$APP/Contents/Resources/$tree"
  cp -cR "$source" "$target" 2>/dev/null || { rm -rf "$target"; cp -R "$source" "$target"; }
done
if [ -n "$(find "$APP/Contents/Resources" -type l -print -quit)" ]; then
  echo "assemble.sh: the staged trees contain symbolic links" >&2
  exit 1
fi

# The committed signature must hold for exactly these files: none changed, none missing, none added.
if ! codesign --verify --strict "$APP"; then
  echo "assemble.sh: the bundle does not match the committed signature: a staged TeX or package file differs from" >&2
  echo "what was signed, or the signed pieces were changed. Re-stage, or re-sign on a Mac (build.sh, export-signed.sh)." >&2
  exit 1
fi
if ! codesign -d --entitlements - "$APP" 2>/dev/null | tr -d '\n\t ' | grep -q -E "com.apple.security.app-sandbox(</key><true/>|\[Value\]\[Bool\]true)"; then
  echo "assemble.sh: the helper does not carry the App Sandbox entitlement" >&2
  exit 1
fi
DONE=1

echo "assembled without signing: $APP"
echo "sealed files: $(codesign -dv "$APP" 2>&1 | sed -n 's/.*files=\([0-9]*\).*/\1/p')"
echo "cdhash: $(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
shasum -a 256 "$APP/Contents/MacOS/latexstudio-compiler"
