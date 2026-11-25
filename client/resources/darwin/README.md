# macOS 编译助手

状态（2026-11-25）：**已在一台 Mac 上实测（macOS 27.2.1，Apple 芯片），自 0.4.15 起随 Mac 版发布。**
`client/src/main/tex/darwin-runtime.ts` 里的两个校验值（`DARWIN_INSTALL_TREE_SHA256`、`MAC_HELPER_SHA256`）已经填上。
方案、实测结果和发布准备记在开发文档 `docs/MACOS-COMPILE-PLAN.md` 第十一、十二节（不随公开源码发布）。

## 这里有什么

| 文件 | 作用 |
| --- | --- |
| `compiler/latexstudio-compiler.c` | 助手源码（C，只依赖系统库）。协议写在文件开头的注释里。 |
| `compiler/Info.plist` | 助手应用包的身份：`org.paperstudio.desktop.compiler.v1`，不显示窗口和 Dock 图标。 |
| `compiler/compiler.entitlements.plist` | 只有 App Sandbox 一项权限。 |
| `compiler/build.sh` | 维护者在 Mac 上用：编译助手，把暂存好的 TeX 和宏包拷进应用包，再做 ad-hoc 签名。 |
| `compiler/export-signed.sh` | 维护者在 Mac 上用：把签好的文件导出到 `signed/`，写 `PROVENANCE.json`，打印新的校验值。 |
| `compiler/assemble.sh` | 每次构建用：用 `signed/` 里的文件和暂存的 TeX、宏包拼出应用包，**不编译、不签名**，然后核对签名。 |
| `compiler/check-logic-linux.sh` | 在 Linux（WSL）上用假的 TeX 程序检查协议逻辑。**不是沙箱测试**，只打印结果，由人来看。 |
| `signed/latexstudio-compiler` | 签好的助手可执行文件。它的 SHA-256 就是 `MAC_HELPER_SHA256`。 |
| `signed/CodeResources.gz` | 签名清单：助手包 `Resources` 下每个文件（TeX 和宏包）的 SHA-256。 |
| `signed/PROVENANCE.json` | 构建记录：机器、工具链、三个源文件的 SHA-256、cdhash。 |

`LatexStudioCompiler.app` 本身不进 git（约 550M）。构建 Mac 版时 `scripts/build-macos-test.cjs` 会自动下载并暂存 TinyTeX，
再运行 `assemble.sh` 把它拼出来。

## 为什么签好的文件要入库

应用在运行时核对助手可执行文件的 SHA-256。正式的安装包是发布构建机打的，所以每台构建机都必须得到完全相同的
助手。做法是只签一次，把签好的可执行文件和签名清单入库，构建时原样拼装。签名清单的哈希记在可执行文件的签名里，
清单又记着每个 TeX 文件和宏包文件的哈希，所以拼出来的应用包只要通过 `codesign --verify --strict`，就和签名时
逐字节相同。

## 改了助手、宏包或 TinyTeX 之后

改了助手源码、`Info.plist`、权限文件或宏包之后，`tests/mac-helper-seal.test.ts` 会在任何系统上失败；换了 TinyTeX 的版本
则要到 Mac 上拼装时（`assemble.sh`）才会失败。两种情况都要在 Mac 上重做下面几步：

1. `node scripts/prepare-bundled-tex-darwin.cjs`（TinyTeX 变了才需要；记下它打印的 `treeSha256`）。
2. 删掉旧的 `resources/darwin/LatexStudioCompiler.app`，运行 `sh resources/darwin/compiler/build.sh`。
3. 运行 `sh scripts/mac-phase0.sh`，验收必须全部通过。
4. 运行 `sh resources/darwin/compiler/export-signed.sh`，把它打印的值填进 `darwin-runtime.ts`。
5. 把 `signed/` 里的三个文件和 `darwin-runtime.ts` 一起提交。

## 评审 `signed/` 的改动时要查什么

入库的可执行文件没法在代码评审里直接读。有人提交对 `signed/` 的改动时：

- 在一台 Mac 上从同一份源码重做上面第 1、2 步，比较得到的 cdhash 和可执行文件的 SHA-256。同一台机器、同样的内容，
  ad-hoc 签名的结果是相同的；不同版本的编译器可能给出不同的字节，这时至少比较 `PROVENANCE.json` 里的工具链。
- `codesign -d --entitlements -` 的结果只能有 `com.apple.security.app-sandbox`。
- 解开 `CodeResources.gz`，看文件列表里有没有多出来的条目。
- `PROVENANCE.json` 里三个源文件的 SHA-256 和仓库里的一致（测试会查）。
- 改动里应当附上 `mac-phase0.sh` 的验收结果。

## 应用包里为什么带着 TeX

助手的沙箱读不到用户主目录，也读不到 `/private/tmp`，但读得到它自己的应用包（实测）。所以 TeX 目录和宏包目录
放在 `LatexStudioCompiler.app/Contents/Resources/tex-darwin` 和 `tex-packages`，签名把里面的每个文件都封进清单。
打包 LatexStudio 时不能重签这个应用包，否则它的 App Sandbox 权限会被换掉。

## 它做什么

- 主程序（不在沙箱里）启动它。它带 App Sandbox 权限，所以在自己的沙箱容器里运行。
- 主程序通过标准输入把论文快照逐个文件发过来；它写进容器里的临时目录，在那里启动固定的 TeX 程序
  （`pdftex`、`xetex`、`xdvipdfmx`、`bibtex`），再把结果通过标准输出传回去。
- 它发现自己不在沙箱里时，除了“关闭”以外什么都不做，更不会运行 TeX 程序。
- 标准输入断开（主程序崩溃或被强杀）时，它立即结束正在运行的 TeX 进程组并删除临时目录。
- 同一时间只有一个助手占用容器（文件锁，后来的最多等 30 秒）。启动时先删掉以前异常退出留下的临时目录，
  所以后一篇文档读不到前一篇论文的快照。
- TeX 运行期间每半秒统计一次临时目录：超过 512 MiB 或 40000 个条目就结束 TeX。
- BibTeX 在输出目录（`.paperstudio-output`）里运行，因为 TeX 的严格模式不允许输出文件名里带以点开头的目录。
- 临时目录里有两个短链接 `t` 和 `p`，分别指向 TeX 目录和宏包目录，环境变量用的是它们。原因是 XeTeX 记录字体
  路径时长度只有一个字节，安装路径一长就被截断。每次启动工具前检查这两个链接没有被换掉。
- 任何协议错误或越界路径都会结束整个会话。

## 已经检查过的和没有检查过的

- Linux 上：gcc 编译通过；`check-logic-linux.sh` 的 13 组场景输出符合协议。
- Mac 上（一台，macOS 27.2.1）：`scripts/mac-phase0.sh` 完整通过，包括 13 项验收测试、主程序被强杀后的清理、
  换签名的助手；从干净目录用 `assemble.sh` 拼出的助手和校验值一致，打包后验收通过；用户在图形界面里编译成功过一次。
- 下载安装的流程走通过一次：从带隔离标记的 DMG 装进“应用程序”，用户在系统设置里放行后，应用在系统给的
  随机路径（App Translocation）下运行并编译成功。放行之前助手不会启动，这是预期的。
- 没检查：发布构建机上的实际构建；Intel 芯片的 Mac；其他 macOS 版本；内存上限。
