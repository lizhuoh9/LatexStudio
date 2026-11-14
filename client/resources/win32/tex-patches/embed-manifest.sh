#!/usr/bin/env bash
# Embeds utf8.manifest (UTF-8 active code page + long paths) into the given engine executables with mt.exe
# (Windows SDK). Without it, non-ASCII runtime/project paths (e.g. a Chinese user name) break kpathsea/XeTeX.
#   embed-manifest.sh <exe>...      (MT=/path/to/mt.exe to override)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MT="${MT:-/c/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/mt.exe}"
[[ -x "$MT" ]] || { echo "mt.exe not found: $MT" >&2; exit 2; }
for exe in "$@"; do
  "$MT" -nologo -manifest "$(cygpath -w "$HERE/utf8.manifest")" "-outputresource:$(cygpath -w "$exe");#1"
done
