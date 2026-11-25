#!/bin/sh
# Real-Mac acceptance run for the App Sandbox compile backend (docs/MACOS-COMPILE-PLAN.md, phase 0).
#
#   cd <unpacked source kit>/client && sh scripts/mac-phase0.sh [--cleanup]
#
# Needs: node_modules installed, Xcode Command Line Tools already present. Uses no sudo, changes no system setting,
# installs nothing and never opens LatexStudio. Downloads the pinned TinyTeX archive (about 210 MB) once.
# Everything it finds goes to release/mac-phase0/report.txt. A step that fails is recorded; later steps still run.
# PAPERSTUDIO_PHASE0_SKIP_VARIANT=1 leaves out step 6, which should be run while someone watches the screen.
set -u

CLIENT=$(cd "$(dirname "$0")/.." && pwd)
cd "$CLIENT" || exit 1
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
OUT="$CLIENT/release/mac-phase0"
REPORT="$OUT/report.txt"
APP="$CLIENT/resources/darwin/LatexStudioCompiler.app"
HELPER="$APP/Contents/MacOS/latexstudio-compiler"
RESOURCES="$APP/Contents/Resources"
BUNDLE_ID=org.paperstudio.desktop.compiler.v1

if [ "$(uname -s)" != "Darwin" ]; then echo "mac-phase0.sh runs on macOS only" >&2; exit 1; fi

if [ "${1:-}" = "--cleanup" ]; then
  rm -rf "$OUT/variant" /private/tmp/latexstudio-phase0
  echo "removed the variant helper"
  echo "sandbox containers (remove by hand if macOS allows it from this shell):"
  ls -d "$HOME/Library/Containers/$BUNDLE_ID"* 2>/dev/null || echo "  none"
  exit 0
fi

mkdir -p "$OUT"
: > "$REPORT"
say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
section() { say ""; say "=== $* ==="; }
run() { "$@" 2>&1 | tee -a "$REPORT"; }
probe() { node scripts/mac-helper-driver.cjs probe "$@" 2>> "$REPORT"; }
all_allowed() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);console.log(r.ready&&r.sandboxed&&r.probes.length>0&&r.probes.every(p=>p.verdict==="allowed")?"yes":"no")}catch{console.log("no")}})'
}

section "0 environment"
say "macOS $(sw_vers -productVersion) build $(sw_vers -buildVersion) $(uname -m)"
say "command line tools: $(xcode-select -p 2>&1)"
say "node: $(node -v 2>&1)"
say "sandbox-exec: $(ls /usr/bin/sandbox-exec 2>&1)"
say "system TeX: $(ls -d /Library/TeX/texbin /usr/local/texlive/* 2>/dev/null | tr '\n' ' ')"
say "app data folders: $(ls "$HOME/Library/Application Support" 2>/dev/null | grep -i -E 'latexstudio|paperstudio' | tr '\n' ' ')"
say "existing containers: $(ls "$HOME/Library/Containers" 2>/dev/null | grep -i paperstudio | tr '\n' ' ')"

section "1 TinyTeX tree (Q2: signatures, formats, both CPU types; Q8: size)"
if [ ! -d resources/tex-darwin/install ]; then
  node scripts/prepare-bundled-tex-darwin.cjs > "$OUT/stage.json" 2>> "$REPORT"
  say "staging exit code: $?"
fi
[ -f "$OUT/stage.json" ] && cat "$OUT/stage.json" >> "$REPORT" && cat "$OUT/stage.json"
if [ ! -d resources/tex-darwin/install ]; then say "FAILED: no staged TeX tree"; exit 1; fi
say "unpacked size: $(du -sh resources/tex-darwin 2>/dev/null | cut -f1)   files: $(find resources/tex-darwin -type f | wc -l | tr -d ' ')"
for tool in pdftex xetex xdvipdfmx bibtex; do
  file="resources/tex-darwin/install/bin/universal-darwin/$tool"
  say "$tool: archs=$(lipo -archs "$file" 2>&1) signature=$(codesign -dv "$file" 2>&1 | grep -E 'Signature|Authority|flags' | tr '\n' ' ')"
  codesign -d --entitlements - "$file" 2>/dev/null | grep -q "<key>" && say "  $tool carries entitlements (see codesign -d --entitlements -)"
done

section "2 compile helper with TeX inside its bundle (build, signature, entitlements)"
if [ ! -x "$HELPER" ]; then
  STARTED=$(date +%s)
  sh resources/darwin/compiler/build.sh > "$OUT/build.log" 2>&1
  BUILD_STATUS=$?
  cat "$OUT/build.log" | tee -a "$REPORT"
  say "build exit code: $BUILD_STATUS; build and signing took $(( $(date +%s) - STARTED )) s"
fi
# A bare, half-built or changed bundle must not be taken for the helper: it has to hold TeX and match its seal.
if [ ! -x "$HELPER" ] || [ ! -d "$RESOURCES/tex-darwin/install" ] || ! codesign --verify --strict "$APP" 2>> "$REPORT"; then
  say "FAILED: no complete, sealed helper bundle with TeX inside; nothing else can run"; exit 1
fi
run codesign -dv --entitlements - "$APP"
say "architectures: $(lipo -archs "$HELPER" 2>&1)"
say "helper sha256: $(shasum -a 256 "$HELPER" | cut -d' ' -f1)"
say "bundle size: $(du -sh "$APP" | cut -f1)   signature list: $(wc -c < "$APP/Contents/_CodeSignature/CodeResources" | tr -d ' ') bytes"

section "3 what the sandboxed helper can read (Q3)"
say "-- inside its own bundle (must be allowed, or nothing can compile)"
line=$(probe "$HELPER" "$RESOURCES/tex-darwin/install" \
  "read:$RESOURCES/tex-darwin/install/bin/universal-darwin/pdftex" \
  "exec-read:$RESOURCES/tex-darwin/install/texmf-dist/web2c/texmf.cnf" \
  "read:$RESOURCES/tex-packages/manifest.json")
say "$line"
USABLE=$(printf '%s' "$line" | all_allowed)
say "   usable for compilation: $USABLE"
say "-- controls (informational): writing into the bundle, the staged copy in the home folder, an installed app"
say "$(probe "$HELPER" "$RESOURCES/tex-darwin/install" \
  "write:$RESOURCES/tex-darwin/install/phase0-write-test.txt" \
  "read:$CLIENT/resources/tex-darwin/install/bin/universal-darwin/pdftex" \
  "read:/Applications/LatexStudio.app/Contents/Info.plist")"
[ -e "$RESOURCES/tex-darwin/install/phase0-write-test.txt" ] && say "FAIL: the sandbox wrote into the helper bundle"

section "4 product acceptance tests (Q1 Q2 Q4 Q5 Q6, cancel, shell escape)"
if [ "$USABLE" = "yes" ]; then
  TREE_SHA=$(sed -n 's/.*"treeSha256": "\([a-f0-9]*\)".*/\1/p' "$OUT/stage.json" 2>/dev/null)
  say "tree digest used as the pin for the app's own verification: ${TREE_SHA:-none (that test is skipped)}"
  PAPERSTUDIO_MAC_APPSANDBOX=1 PAPERSTUDIO_MAC_HELPER="$HELPER" PAPERSTUDIO_MAC_RESOURCES="$RESOURCES" PAPERSTUDIO_MAC_TREE_SHA256="$TREE_SHA" \
    npx vitest run tests/sandbox-macos-appsandbox-smoke.test.ts > "$OUT/acceptance.log" 2>&1
  ACCEPTANCE=$?
  cat "$OUT/acceptance.log" | tee -a "$REPORT"
  if [ "$ACCEPTANCE" = 0 ]; then say "ACCEPTANCE: PASS"; else say "ACCEPTANCE: FAIL (vitest exit code $ACCEPTANCE)"; fi
else
  say "SKIPPED: the sandbox could not read the TeX tree inside the helper bundle"
fi

section "5 app killed while a tool runs (Q9)"
if [ "$USABLE" = "yes" ]; then
  node scripts/mac-helper-driver.cjs hang "$HELPER" "$RESOURCES/tex-darwin/install" > "$OUT/hang.txt" 2>> "$REPORT" &
  DRIVER=$!
  PGID=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    PGID=$(sed -n 's/^PGID \([0-9][0-9]*\)$/\1/p' "$OUT/hang.txt" 2>/dev/null | head -1)
    [ -n "$PGID" ] && break
    sleep 1
  done
  say "driver pid $DRIVER, tool process group ${PGID:-none} ($(cat "$OUT/hang.txt" 2>/dev/null | head -1))"
  if [ -n "$PGID" ]; then
    if kill -0 -- "-$PGID" 2>/dev/null; then
      say "tool group alive before the kill: yes"
      kill -9 "$DRIVER"
      sleep 3
      if kill -0 -- "-$PGID" 2>/dev/null; then say "FAIL: the tool survived its app being killed"; kill -9 -- "-$PGID" 2>/dev/null
      else say "PASS: the tool was gone within 3 seconds"; fi
    else
      say "NOT TESTED: the tool group was already gone before the kill"
      kill -9 "$DRIVER" 2>/dev/null
    fi
    say "helper processes left: $(pgrep -f latexstudio-compiler | tr '\n' ' ')"
    say "work folders left in the container: $(ls "$HOME/Library/Containers/$BUNDLE_ID/Data/tmp" 2>/dev/null | grep -v '^paperstudio.lock$' | tr '\n' ' ')"
  else
    kill -9 "$DRIVER" 2>/dev/null
    say "SKIPPED: the endless run did not start"
  fi
else
  say "SKIPPED: the helper cannot compile here"
fi

section "6 a helper with a different signature (Q7) - WATCH THE MAC SCREEN FOR PROMPTS"
if [ "${PAPERSTUDIO_PHASE0_SKIP_VARIANT:-}" = "1" ]; then
  say "SKIPPED on request (PAPERSTUDIO_PHASE0_SKIP_VARIANT=1): run this step separately while someone watches the screen"
else
  rm -rf "$OUT/variant"; mkdir -p "$OUT/variant"
  EXTRA_CFLAGS=-DPAPERSTUDIO_VARIANT=2 sh resources/darwin/compiler/build.sh "$OUT/variant" >> "$REPORT" 2>&1
  VARIANT="$OUT/variant/LatexStudioCompiler.app/Contents"
  if [ -x "$VARIANT/MacOS/latexstudio-compiler" ] && [ "$USABLE" = "yes" ]; then
    say "variant sha256: $(shasum -a 256 "$VARIANT/MacOS/latexstudio-compiler" | cut -d' ' -f1)"
    say "variant helper:  $(probe "$VARIANT/MacOS/latexstudio-compiler" "$VARIANT/Resources/tex-darwin/install" "read:$VARIANT/Resources/tex-darwin/install/bin/universal-darwin/pdftex")"
    say "original again:  $(probe "$HELPER" "$RESOURCES/tex-darwin/install" "read:$RESOURCES/tex-darwin/install/bin/universal-darwin/pdftex")"
  else
    say "SKIPPED: variant helper not built or the helper cannot compile here"
  fi
fi

section "7 what is left on this Mac"
say "containers: $(ls -d "$HOME/Library/Containers/$BUNDLE_ID"* 2>/dev/null | tr '\n' ' ')"
say "helper bundle: $APP ($(du -sh "$APP" 2>/dev/null | cut -f1); a clone of the staged tree on APFS)"
say "not covered by this script: Q10 (memory limits), the helper inside an installed LatexStudio.app,"
say "and anything that needs eyes on the screen (system prompts). Run with --cleanup when done."
say ""
say "report: $REPORT"
