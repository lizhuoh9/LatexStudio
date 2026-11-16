# LatexStudio 0.3.9 客户端

普通用户双击上一级[启动器](<../打开LatexStudio.cmd>)，或使用当前 Windows 安装／便携包。无需运行下面的开发命令。首次启动在后台用内置资源自动离线配置、校验；期间可编辑保存，不弹出下载或组件选择。

## 开发与构建

```sh
npm ci
npm run audit:source
npm run typecheck
npm test
npm run build
npm start
```

当前启动器依赖本目录的 `node_modules`、`out` 和 `resources`。内置固定 TeX ZIP、受管引擎／宏包、helper 和图标不是可删缓存。

- `npm run prepare:tex-runtime`：构建者获取／校验固定 Windows 组件；不是普通用户步骤。脚本与固定资源映射见[当前 package](<package.json>)。
- `npm run dist:win`：先校验内置组件，再构建 NSIS 与 portable；当前未配置受信签名。
- `npm run dist:mac:test`：仅在真实 Mac 上检查并生成当前原生架构的 ad-hoc 编辑测试 ZIP，输出 `release/macos-test`；不发布、不配置 TeX、不等于正式签名／公证。
- `npm run test:mac-contracts`：可在 Windows 运行的 Mac 菜单、编译禁用、打包配置和编辑契约测试，不冒充真实 Mac 验收。Mac 交接见[操作说明](<../Mac测试说明.md>)与[双击构建入口](<../在Mac上构建测试版.command>)。
- `npm run test:offline-native`：显式原生验收，需要 `PAPERSTUDIO_OFFLINE_NATIVE=1`；使用独立空配置、禁网、真实 Main／AppContainer／PDF／BibTeX／中文，不在默认测试或构建中偷偷启用。
- `npm run test:versions-ui`：真实构建的保存／差异／单文件回退验证。
- `npm run test:cloud-ui`：源码 Main＋built UI＋严格合成 HTTP；不是实际 GitHub 账号验收。
- `node tests/paper-theme-visual.cjs`：三尺寸静态布局／选项浮层验证，不代替实际编译。
- `node scripts/smoke-navigation.cjs --run`：独立临时配置中的真实构建导航验收；合作式取消组件初始化，不启动 TeX 或真实 GitHub，验证两级目录、空文件夹、用户折叠及保存后切换。
- `node scripts/verify-package.cjs`：只读核对 ASAR 与内置组件；不启动、修改或强杀产品。
- `npm run verify:release`：严格签名／安装证据门禁；当前开发包应保持 not-ready，不自动签名／安装。

过时的手动准备／旧缓存安装 smoke 已退休，不再用其强杀控制作为自动初始化验收。打包和 opt-in 验收会生成新过程产物；结束后只清理自有临时目录。

## 当前能力与验证

按用户提供的 Overleaf 参考图改为“独立项目首页 → 单篇论文编辑页”。首页提供搜索、新建、打开和真实源文件修改时间；编辑页左侧是当前文件树与章节大纲，中间源码，右侧 PDF 与编译，修改历史是独立的只读对比模式：左侧文件、中间带行号的颜色差异、右侧时间线，可返回编辑而不替换草稿。同步和项目设置在当前文件栏内，账号设置在右上角。返回首页保留未保存草稿，点当前项目继续编辑；换另一项目仍先保存。入口跨重启保留，移出不删文件，文件树展开按项目隔离，不改变编译／历史的默认文件快照。

参考布局的深色框架、项目内同步与 PDF 编译选项浮层、自有 Windows 图标、持久项目入口及逐项目独立 GitHub 关联均已接入。真实空目录离线初始化、含 PDF 图片的全文、BibTeX、中文与实际 PDF 绘制通过；真实两阶段 GUI 验证保存后切换、不串项目／关联、移出不删论文以及重启持久化。默认测试／构建和精确字节记录见[当前交接](<../docs/HANDOFF.md>)。

固定 pdfTeX 字节为 `502ec6c709cd2f1edc97a18a3256fa2f8812b2d968127bfb61611b7fc85491f0`，包含 XPDF 状态路径未初始化指针修复；没有通过开放 APPDATA、放宽隔离或跳过 PDF 图片绕过崩溃。[补丁和重建说明](<resources/win32/tex-patches/README.md>)保留固定源提交和许可义务。

## 不变边界

GitHub App 的公共标识已接入；已真实验证 Windows 同账号的私有建库／关联／两目录交替同步，不冒充第二个人邀请或同时冲突验收。0.3.8 自动轮换设备流程的 access／refresh 配对，仅 Main 使用、OS 加密保留、恢复与续期后重新验证身份；安全存储不可用只留内存。退出清除本机登录，撤销／续期授权失效仍须重新登录；旧记录升级后显式登录一次。定时跨期／断网恢复／Logout 与关闭轮换以隔离测试验证，不冒充已等待真实八小时的 GitHub 续期验收。每项目关联独立，创建固定私有且必须明确同步；链接不授权，本地日志不自动上传，不强推。

Windows 使用固定资源与 AppContainer，不执行系统 TeX、项目脚本或 shell escape；清理未确认锁死本进程编译。macOS、Biber、LuaLaTeX、受信签名／公证和原样新版安装验收未开放或未完成。已有沙箱残留禁令仍以[开发约束](<../CLAUDE.md>)及[helper 说明](<resources/win32/README.md>)为准。

[使用](<../docs/GITHUB-WORKFLOW.md>) · [配置 App](<../docs/GITHUB-APP-SETUP.md>) · [恢复](<../docs/PROJECT-HISTORY.md>) · [发布](<../docs/RELEASE-ACCEPTANCE.md>) · [第三方](<THIRD_PARTY_NOTICES.md>)
