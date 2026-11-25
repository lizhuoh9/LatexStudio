#!/bin/bash
# Logic check of the macOS compile helper on Linux (WSL): NOT a sandbox test. A stub stands in for sandbox_check and a
# shell script stands in for pdfTeX, so only framing, file transfer, run/cancel, cleanup and the lifeline are exercised.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)/latexstudio-compiler.c"
W=$(mktemp -d /tmp/lshelper.XXXXXX)
cat > "$W/shim.c" <<'EOF'
#include <stdlib.h>
#include <sys/types.h>
int sandbox_check(pid_t pid, const char *operation, int type, ...) { (void)pid; (void)operation; (void)type; return getenv("FAKE_SANDBOX") != NULL; }
EOF
gcc -std=c11 -D_GNU_SOURCE -O1 -Wall -Wextra -Wno-attributes -Wno-address -o "$W/helper" "$SRC" "$W/shim.c" || { echo BUILD-FAILED; exit 1; }
echo "build ok"
TEX="$W/tex"; mkdir -p "$TEX/bin/universal-darwin"
cat > "$TEX/bin/universal-darwin/pdftex" <<'EOF'
#!/bin/sh
echo "fake pdftex args: $*"
echo "cwd: $(pwd | sed 's|.*/paperstudio-[^/]*/||')"
echo "HOME-in-work: $(case "$HOME" in */home) echo yes;; *) echo no;; esac) TEXINPUTS=$TEXINPUTS shell_escape=$shell_escape PATHHEAD=$(echo "$PATH" | sed 's|.*/tex/||')"
cat main.tex sub/a.txt >&2
printf '%%PDF-fake' > .paperstudio-output/paperstudio.pdf
[ "$1" = "--loop" ] && { sleep 600 & wait; }
[ "$1" = "--flood" ] && { yes 0123456789abcdef | head -c 3000000; }
exit 7
EOF
chmod +x "$TEX/bin/universal-darwin/pdftex"
show() { tr '\0' '~' | cat -v; echo; }

echo "--- 1 full session (sandbox stub on)"
{ printf 'MKDIR 3\nsubPUT 8 4\nmain.texMAINPUT 9 3\nsub/a.txtFIGRUN pdflatex 6\n-x\0-y\0'; sleep 2;
  printf 'GET 15\npaperstudio.pdfGET 7\nmissingPROBE read 11\n/etc/passwdPROBE write 20\n/proc/nope/forbiddenPROBE exec-read 11\n/etc/passwdPROBE connect 1\n9CLOSE\n'; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 5000 | show
echo "exit=$? leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 2 refuses to run a tool when not sandboxed"
printf 'RUN pdflatex 0\n' | "$W/helper" --tex-root "$TEX" --timeout-ms 5000 | show
echo "exit=${PIPESTATUS[1]} leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 3 path escapes and late uploads are fatal"
printf 'PUT 11 1\n../escape.x!' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" | show
printf 'MKDIR 4\n/abs' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" | show
printf 'RUN pdflatex 0\nPUT 5 1\na.texZ' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" | show
printf 'RUN latexmk 0\n' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" | show
printf 'BOGUS\n' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" | show
echo "leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 4 CANCEL and CLOSE while a tool runs"
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 7\n--loop\0'; sleep 1; printf 'CANCEL\n'; sleep 1; printf 'CLOSE\n'; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 20000 | show
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 7\n--loop\0'; sleep 1; printf 'CLOSE\n'; sleep 1; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 20000 | show
echo "sleepers left=$(pgrep -f 'sleep 600' | wc -l) leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 5 time limit and output limit"
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 7\n--loop\0'; sleep 3; printf 'CLOSE\n'; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 1000 | show
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 8\n--flood\0'; sleep 2; printf 'CLOSE\n'; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 20000 | tr '\0' '~' | cat -v | grep -o 'EXIT [0-9]*\|CLOSED [0-9]\|STARTED' | tr '\n' ' '; echo
echo "sleepers left=$(pgrep -f 'sleep 600' | wc -l) leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 6 lifeline: the app dies (stdin closes) while a tool runs"
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 7\n--loop\0'; sleep 1; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 20000 > "$W/life.out"; CODE=$?
tr '\0' '~' < "$W/life.out" | cat -v | grep -o 'EXIT [0-9]*\|CLOSED [0-9]\|STARTED' | tr '\n' ' '; echo
sleep 1
echo "helper exit=$CODE sleepers left=$(pgrep -f 'sleep 600' | wc -l) leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 7 residue of an earlier session is removed before a new one starts"
mkdir -p /tmp/paperstudio-stale1/source && echo secret > /tmp/paperstudio-stale1/source/old-project.tex
printf 'CLOSE\n' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" | show
echo "stale folder still there=$(ls -d /tmp/paperstudio-stale1 2>/dev/null | wc -l) leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"
mkdir -p /tmp/paperstudio-stale2 && printf 'CLOSE\n' | "$W/helper" --tex-root "$TEX" > /dev/null
echo "outside the sandbox nothing is swept: stale folder still there=$(ls -d /tmp/paperstudio-stale2 2>/dev/null | wc -l)"
rm -rf /tmp/paperstudio-stale2

echo "--- 8 one helper at a time: a second session waits for the first to finish"
{ sleep 2; printf 'CLOSE\n'; } | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" > "$W/first.out" &
sleep 0.5
START=$(date +%s%N)
printf 'CLOSE\n' | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" > "$W/second.out"
WAITED=$(( ($(date +%s%N) - START) / 1000000 ))
wait
echo "second session waited ${WAITED} ms (expected about 1500) first=$(grep -c 'CLOSED 1' "$W/first.out") second=$(grep -c 'CLOSED 1' "$W/second.out")"

echo "--- 9 total size of the work folder is limited while a tool runs"
gcc -std=c11 -D_GNU_SOURCE -O1 -Wno-attributes -Wno-address -DMAX_WORK_BYTES=1000000 -o "$W/helper-small" "$SRC" "$W/shim.c" || echo BUILD-FAILED
cat > "$TEX/bin/universal-darwin/bibtex" <<'EOF'
#!/bin/sh
i=0; while [ $i -lt 40 ]; do head -c 200000 /dev/zero > "fill-$i.bin"; i=$((i+1)); sleep 0.1; done
sleep 600
EOF
chmod +x "$TEX/bin/universal-darwin/bibtex"
{ printf 'RUN bibtex 0\n'; sleep 6; printf 'CLOSE\n'; } | FAKE_SANDBOX=1 "$W/helper-small" --tex-root "$TEX" --timeout-ms 30000 \
  | tr '\0' '~' | cat -v | grep -o 'EXIT [0-9]*\|CLOSED [0-9]\|STARTED' | tr '\n' ' '; echo
echo "sleepers left=$(pgrep -f 'sleep 600' | wc -l) leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"

echo "--- 10 a control word cut in half by the tool's exit is completed, not rejected"
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 3\n-x\0CLO'; sleep 2; printf 'SE\n'; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 20000 | tr '\0' '~' | cat -v | grep -o 'EXIT [0-9]*\|CLOSED [0-9]\|ERR [a-z-]*' | tr '\n' ' '; echo

echo "--- 11 SIGTERM takes the running tool along"
{ printf 'PUT 8 1\nmain.texMMKDIR 3\nsubPUT 9 1\nsub/a.txtFRUN pdflatex 7\n--loop\0'; sleep 5; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 20000 > /dev/null &
sleep 1.5
pkill -TERM -f "$W/helper --tex-root" ; sleep 1
echo "sleepers left=$(pgrep -f 'sleep 600' | wc -l)"
wait 2>/dev/null

echo "--- 12 BibTeX runs inside the output folder and finds project files through BIBINPUTS"
cat > "$TEX/bin/universal-darwin/bibtex" <<'EOF'
#!/bin/sh
echo "bibtex cwd: $(pwd | sed 's|.*/paperstudio-[^/]*/||') args: $*"
echo "project is the first BIBINPUTS entry: $(case "${BIBINPUTS%%:*}" in */source) echo yes;; *) echo no;; esac)"
echo "TEXMFROOT is the short stand-in and resolves to the tree: $(case "$TEXMFROOT" in */paperstudio-??????/t) [ -x "$TEXMFROOT/bin/universal-darwin/pdftex" ] && echo yes || echo dangling;; *) echo no;; esac)"
if [ "${1:-}" = "--swap" ]; then rm "$TEXMFROOT" && ln -s /tmp "$TEXMFROOT"; echo "swapped the stand-in"; fi
EOF
{ printf 'RUN bibtex 19\n-terse\0paperstudio\0'; sleep 1; printf 'CLOSE\n'; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 5000 | show

echo "--- 13 a run that swapped the TeX stand-in ends the session before the next tool starts"
{ printf 'RUN bibtex 7\n--swap\0'; sleep 1; printf 'RUN bibtex 0\n'; sleep 1; } \
  | FAKE_SANDBOX=1 "$W/helper" --tex-root "$TEX" --timeout-ms 5000 | tr '\0' '~' | cat -v | grep -o 'swapped the stand-in\|EXIT [0-9]*\|ERR [a-z-]*\|STARTED' | tr '\n' ' '; echo
echo "leftovers=$(ls -d /tmp/paperstudio-* 2>/dev/null | wc -l)"
rm -rf "$W" /tmp/paperstudio-*
