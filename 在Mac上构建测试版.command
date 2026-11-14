#!/bin/bash
# Local developer/test handoff. No upload, sudo, installation, Gatekeeper change or TeX preparation.
set -euo pipefail
finish() {
  result=$?
  trap - EXIT
  if [ "$result" -eq 0 ]; then
    printf '\n构建完成。请查看 client/release/macos-test 中的应用 ZIP 和 TEST-BUILD.json。\n'
  else
    printf '\n未完成构建（退出码 %s）。请保留上方错误，不要把源码 ZIP 当成可运行应用。\n' "$result"
  fi
  if [ -t 0 ]; then read -r -p '按回车关闭此窗口…' answer || true; fi
  exit "$result"
}
trap finish EXIT
if [ "$(uname -s)" != "Darwin" ]; then printf '此入口只能在真实 macOS 上运行。\n'; exit 1; fi
cd -- "$(dirname -- "$0")/client"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
unset NODE_OPTIONS ELECTRON_RUN_AS_NODE ELECTRON_RENDERER_URL
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  printf '请先安装适合本机芯片的 Node.js 24 LTS，再重新双击本文件。\n'; exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0]) < 24) { console.error("需要 Node.js 24 LTS 或更新的兼容版本。"); process.exit(1) }'
printf '即将按锁文件安装开发依赖和 Electron（需要网络），并仅构建当前架构的本地测试版。\n不会上传源码、访问论文、配置账号或安装 TeX；Mac GUI 尚待你实测。\n'
npm ci --no-audit --no-fund
npm run dist:mac:test
