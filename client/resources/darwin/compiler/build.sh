#!/bin/sh
# Builds LatexStudioCompiler.app (the sandboxed TeX session helper) on a real Mac and ad-hoc signs it with the
# App Sandbox entitlement only. Publisher/developer step: never run by the app, never run on a user's machine.
#
#   sh build.sh [output-directory] [--bare]     (default output: ../ , i.e. client/resources/darwin)
#
# The helper's sandbox can read its own bundle and nothing in the user's home, so the staged TinyTeX tree
# (client/resources/tex-darwin, from scripts/prepare-bundled-tex-darwin.cjs) and the package tree
# (client/resources/tex-packages) are copied INTO the bundle before it is signed; the signature then seals every
# file. --bare builds the helper alone (protocol checks only; it cannot compile anything).
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/.."
BARE=0
for argument in "$@"; do
  if [ "$argument" = "--bare" ]; then BARE=1; else OUT=$argument; fi
done
APP="$OUT/LatexStudioCompiler.app"
TEX="$HERE/../../tex-darwin"
PACKAGES="$HERE/../../tex-packages"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build.sh: this helper can only be built on macOS" >&2
  exit 1
fi
# /usr/bin/clang is a shim that may pop an install dialog; only use a toolchain that is already installed.
DEVELOPER=$(xcode-select -p 2>/dev/null || true)
if [ -z "$DEVELOPER" ] || [ ! -x "$DEVELOPER/usr/bin/clang" ]; then
  echo "build.sh: Xcode Command Line Tools are not installed; refusing to trigger an install prompt" >&2
  exit 1
fi
CLANG="$DEVELOPER/usr/bin/clang"
SDK=$(xcrun --show-sdk-path)

if [ -e "$APP" ]; then
  echo "build.sh: $APP already exists; remove it first (pinned bytes are never replaced silently)" >&2
  exit 1
fi
if [ "$BARE" = 0 ] && { [ ! -d "$TEX/install" ] || [ ! -f "$PACKAGES/manifest.json" ]; }; then
  echo "build.sh: stage TeX first (node scripts/prepare-bundled-tex-darwin.cjs), or pass --bare" >&2
  exit 1
fi
# A build that fails part-way leaves nothing behind that a later step could mistake for a finished helper.
DONE=0
trap '[ "$DONE" = 1 ] || rm -rf "$APP"' EXIT
mkdir -p "$APP/Contents/MacOS"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
if [ -n "${BUNDLE_ID:-}" ]; then
  # Test builds only: another identifier means another sandbox container.
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Contents/Info.plist"
fi

"$CLANG" -isysroot "$SDK" -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -std=c11 -O2 -Wall -Wextra -Werror -Wno-deprecated-declarations ${EXTRA_CFLAGS:-} \
  -o "$APP/Contents/MacOS/latexstudio-compiler" "$HERE/latexstudio-compiler.c"

if [ "$BARE" = 0 ]; then
  mkdir -p "$APP/Contents/Resources"
  # -c clones on APFS (no extra disk space); plain copy elsewhere.
  for tree in tex-darwin tex-packages; do
    source="$HERE/../../$tree"; target="$APP/Contents/Resources/$tree"
    cp -cR "$source" "$target" 2>/dev/null || { rm -rf "$target"; cp -R "$source" "$target"; }
  done
  if [ -n "$(find "$APP/Contents/Resources" -type l -print -quit)" ]; then
    echo "build.sh: the staged trees contain symbolic links" >&2
    exit 1
  fi
fi

# Ad-hoc signature, hardened runtime, App Sandbox entitlement and nothing else. Seals everything under Resources.
codesign --force --sign - --options runtime --timestamp=none \
  --entitlements "$HERE/compiler.entitlements.plist" "$APP"
codesign --verify --strict "$APP"
DONE=1

echo "built: $APP"
lipo -archs "$APP/Contents/MacOS/latexstudio-compiler"
codesign -d --entitlements - "$APP" 2>/dev/null | grep -c "com.apple.security.app-sandbox" >/dev/null
echo "sealed files: $(codesign -dv "$APP" 2>&1 | sed -n 's/.*files=\([0-9]*\).*/\1/p')"
echo "cdhash: $(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
shasum -a 256 "$APP/Contents/MacOS/latexstudio-compiler" "$APP/Contents/Info.plist" "$APP/Contents/_CodeSignature/CodeResources"
