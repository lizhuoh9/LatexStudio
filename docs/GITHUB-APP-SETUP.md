# 发布者一次性配置 GitHub App（普通用户无需注册 App）

> **0.4.7 起改用 OAuth App**：发布构建现在使用发布者注册的 GitHub **OAuth App**（公共 Client ID 以 `Ov` 开头，见 `client/github-app.public.ts`），仍然只走设备登录（Device Flow），不使用也不打包 client secret。设备码请求固定申请 `repo` 权限，项目发现改用 `GET /user/repos`。OAuth App 的用户令牌没有到期时间也没有刷新令牌：软件把它只保存在主进程和操作系统加密的会话存储里，每个 8 小时本地窗口结束前以及每次启动恢复时重新向 GitHub 核对账号，核对失败（401 或账号不一致）立即结束登录并清除本机凭据，超过 186 天未使用需重新登录。客户端无法代用户撤销 OAuth 授权（撤销需要 client secret），退出登录只清除本机凭据；用户可在 GitHub 的 Settings → Applications → Authorized OAuth Apps 中撤销。发布者需要在 OAuth App 设置中勾选 **Enable Device Flow**。下文各节记录的是 0.4.6 及之前的 GitHub App 配置，保留作历史参考；其中“只接受 `Iv` 开头的 Client ID”“不改用 OAuth App”“按安装范围授权仓库”等说法已不适用于新版。

## 状态与边界

截至 2026-11-16：GitHub 是唯一产品协作路线；本地离线编辑、历史与已准备好的 Windows TeX 编译不要求 GitHub 账号。Windows 实际 App 登录、私有建库、指定项目关联、首次上传、独立第二目录下载、两副本交替同步和取消恢复已完成真实账号验证；不冒充第二个人邀请接受或 Mac GUI 验收。0.3.8 增加官方设备流程的自动续期，覆盖模拟跨过访问期限、加密恢复、退出与断网重试；尚未等待真实账号跨过八小时来证明现场续期。

当前 0.3.x Windows 与 Apple Silicon Mac 编辑测试版由 GitHub 构建并发布，但仍未签名、未完成原始安装升级及真实 Mac GUI 验收；正式发布继续受[发布验收门禁](<RELEASE-ACCEPTANCE.md>)约束。NAS 是已取消的产品路线，不是此流程的替代后端或待完成验收项。

本说明面向**发布者／维护者**。普通用户只需安装最终软件，点击登录，按 GitHub 官方设备授权页面确认自己的账号；不需要 Git、命令行、PAT、注册自己的 App、自己构建或设置环境变量。普通操作不得静默退回旧开发用 URL／PAT 流程。

## 1. 发布者注册一次 GitHub App

在 GitHub 的 Settings → Developer settings → GitHub Apps → New GitHub App 注册产品自己的 App；由发布者本人在可信浏览器操作。官方[注册说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)与[公开／私有 App 的区别](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)：

1. 填产品名称、真实产品 Homepage URL／说明，不冒充 GitHub 官方服务。保存后记录 **Client ID** 与 App 公共页面 URL 中的 **slug**。Client ID 不是数字 App ID、client secret、private key 或 user token。
2. 勾选 **Enable Device Flow**。本客户端使用 Device Flow，不依赖桌面 localhost 回调／发布者后台代换 secret。不要把 Web callback OAuth 流程当成本客户端已实现的能力；本产品没有为它配置回调接收器。
3. 不需要接收 webhook 的当前纯客户端方案可关闭 Webhooks 的 **Active**；不要为凑配置部署假服务或收集 webhook secret。
4. 如需实验室其他 GitHub 账号／组织安装，选择 **Any account**，而不是 Only on this account。这里的“public GitHub App”指允许其他账户安装，**不代表论文仓库公开**，也不要求上架 Marketplace。
5. 申请下表所需最少权限并保存。改变 App 权限后，既有安装可能需要所有者批准更新；不能把注册页面勾选成功当成所有用户已授权。
6. 保留 GitHub 默认的 user token 到期策略。0.3.8 用操作系统加密保存有界的 access／refresh 凭据，在主进程按官方设备流程自动轮换，再重新验证当前身份；不关闭到期、不生成／分发 private key 或 client secret。官方[续期说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)明确：若用户令牌由 device flow 生成，续期不要求 `client_secret`；不要套用 Web 回调流程的 secret 要求。

官方[Device Flow 说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)：先用公共 `client_id` 请求 device code，再由用户在 `https://github.com/login/device` 输入本次 user code，客户端按服务器 interval 轮询 access token；不传 client secret。App 权限在 App 注册／安装环节申请，不用 OAuth App 的 `repo` scope 或 PAT 替代；该文档明确 GitHub App 不支持传统任意 OAuth scope（本客户端使用设备流程返回的有界续期凭据，不额外索要传统 `repo` scope）。验证码、device code、access／refresh token 都不是公开 ID，不得贴进文档、截图、日志或仓库。

## 2. 权限清单及官方 API 依据

本产品用 **GitHub App user access token（UAT）代表当前用户**，不是把 App private key 包进桌面后生成 installation token。用户权限、App 授权权限及安装仓库范围三者取交集；App 不能借用户登录越过用户自己的权限。见[代表用户认证的访问限制](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)及[选择 App 权限](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)。

| 用途 | 注册时所需权限 | 官方依据／注意事项 |
|---|---|---|
| 私有项目元数据与发现 | Repository **Metadata: Read-only**（GitHub 的基础仓库权限） | 只发现当前用户可见且当前 App 安装允许的仓库，不扫描／继承用户全部私库 |
| 拉取／推送论文与 Git 共享历史 | Repository **Contents: Read & write** | 官方[GitHub App 的 Git 访问](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-a-user-access-token)；无需申请 Actions／Workflows 写权限来同步论文，不执行项目 hooks |
| 创建当前用户个人账号下私库 `POST /user/repos` | Repository **Administration: Write** **或** **Repository creation: Write** 至少一种 | 官方[Create a repository for the authenticated user](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)的 Fine-grained access tokens 栏明确列出 App UAT 及这两组选一权限；不能仅开 Contents 就保证建库可用 |
| 邀请合作者 `PUT /repos/{owner}/{repo}/collaborators/{username}` | Repository **Administration: Write** | 官方[Add a repository collaborator](https://docs.github.com/en/rest/collaborators/collaborators#add-a-repository-collaborator)明确支持 App UAT；操作者本身还须有足够仓库管理权限。201 表示发出邀请，204 可表示已有访问，不等于对方已首次接受 |
| 列当前用户收到的邀请 `GET /user/repository_invitations` | Repository **Administration: Read** | 官方[List repository invitations for the authenticated user](https://docs.github.com/en/rest/collaborators/invitations#list-repository-invitations-for-the-authenticated-user)明确支持 App UAT |
| 接受自己收到的邀请 `PATCH /user/repository_invitations/{invitation_id}` | Repository **Administration: Write** | 官方[Accept a repository invitation](https://docs.github.com/en/rest/collaborators/invitations#accept-a-repository-invitation)明确列 **GitHub App user access tokens**，成功为 204；不能拿 installation token 代替邀请接收者身份 |

要完整提供“建库＋邀请＋接受”的当前界面，**Contents RW＋Metadata R＋Administration Write** 是此端点组合的配置基线。仅用更窄的 Repository creation Write 可覆盖建库权限选项，但**不能替代邀请／接受所需的 Administration Write**。Administration Write 权限范围较宽，发布者必须向用户透明说明并认真审查，不要将它描述成只读或只允许创建一个论文文件。

以上是核对官方网页得到的权限要求，不是当前真实账号运行证明。2026-11-13 核对时，官方 REST 网页 Fine-grained access tokens 栏明确支持上述邀请 App UAT；文档 Markdown 提取接口会漏掉该栏，而 OpenAPI `enabledForGitHubApps:false` 也不能据此否定 UAT 支持。应以具体端点网页明确列出的 token 类型／权限为据，后续仍须实测。

注册页面权限可用性、特定 GitHub API 版本（当前源码发送 `2022-11-28`，官方网页可能展示更新版本）、组织／企业策略、SAML SSO、外部合作者限制、首次空安装／selected-repositories 的建库行为，**均需真实账号验收**。当前只为当前登录用户的个人账户建库，不承诺组织建库。收到 403／404／409 等错误时保留错误、刷新身份／权限，不改 OAuth 身份、不索要 PAT、不强行自动重试写操作，也不通过设为公开来绕过权限。

## 3. 构建时只注入两个公开标识

2026-11-14 发布者提供公共 Client ID `Iv23ctZVs9suln7YQPrX` 与设置页 `https://github.com/settings/apps/latexfactory`，据此将公开默认值保存在[发布配置](<../client/github-app.public.ts>)，App 公共安装页为 `https://github.com/apps/latexfactory/installations/new`。个人主页 `https://github.com/lizhuoh9` 不是 App slug，未当作安装入口。公开标识允许随源码与 Mac 源码测试包分发，**不证明 App 所有权、Device Flow 开关或真实账号授权已经验收**。

普通构建现在默认使用该公开配置；以下两个环境变量可显式覆盖，空字符串仍可禁用相应配置，非法覆盖值必须阻止构建而不是回退默认值。Mac 本地测试构建仍清除环境中的发布／账号秘密，但会通过同一公开源码配置取得 App 标识。只将这两个公开字段送入 Main define，其他环境值不会随对象复制进去。

[配置校验实现](<../client/src/main/collaboration/configuration.ts>)与[Main 构建注入点](<../client/electron.vite.config.ts>)：

- `PAPERSTUDIO_GITHUB_CLIENT_ID`：产品 App 的公共 Client ID；当前只接受 `/^Iv[1-9][A-Za-z0-9._-]{7,125}$/`。这是当前产品刻意限定 **GitHub App** 的策略，不是通用 OAuth Client ID 验证器。数字 App ID、OAuth App Client ID、secret、PAT、换行／空白等不能作为兼容输入；不应静默放宽成另一种 OAuth 策略。
- `PAPERSTUDIO_GITHUB_APP_SLUG`：同一个 App 公共 URL `https://github.com/apps/<slug>` 中的 slug，不是完整 URL；只接受小写字母／数字／内部连字符、字母或数字开头结尾，最长 100 字符。公共 ID 与 slug 都可随源码／二进制公开，但须由发布者核对确实属于同一个产品 App；语法校验不能证明 App 存在／所有权。
- Client ID 为空时云端登录明确显示发布者未配置；本地功能保持可用。非法非空值应阻止构建，不应带着可疑输入继续打包。
- Main 的“管理项目授权”仅打开固定 GitHub 官方 URL：有 slug 为 `https://github.com/apps/<slug>/installations/new`；无 slug 回退 `https://github.com/settings/installations`。这只是打开 GitHub 页面，**不自动安装、自动扩权或自动勾选新库**。

以下给发布者复制，先把大写占位内容替换为自己 App 的**公开**标识（占位 Client ID 故意不能通过校验）。不读取、打印或枚举本机任何密钥；不要把 `.env`、secret 文件或整份环境导出到日志。

PowerShell，从项目根目录运行：

```powershell
Set-Location .\client
$env:PAPERSTUDIO_GITHUB_CLIENT_ID = 'REPLACE_WITH_PUBLIC_GITHUB_APP_CLIENT_ID'
$env:PAPERSTUDIO_GITHUB_APP_SLUG = 'replace-with-your-app-slug'
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
```

Bash，从项目根目录运行：

```bash
cd client
export PAPERSTUDIO_GITHUB_CLIENT_ID='REPLACE_WITH_PUBLIC_GITHUB_APP_CLIENT_ID'
export PAPERSTUDIO_GITHUB_APP_SLUG='replace-with-your-app-slug'
npm run typecheck && npm test && npm run build
```

变量必须在**构建 Main bundle 之前**设定；安装后在用户电脑改环境不会为已经打包的客户端补配置。此处命令只生成构建产物，不进行账号操作或签名。以后有明确打包授权时，保持这两个公开变量再运行既有 `npm run dist:win`；它内部重建 Main。目前 Windows 打包配置禁用签名执行，这条命令仍只会产生开发包，不会凭空得到可信签名。保留现有产物，另行安排签名／新版原样安装验收与哈希审计，不把旧包覆盖后当作旧证据继续使用。

**不准作为发布配置嵌入、收集或上传**：client secret、GitHub App private key、PAT、device code、user access token、refresh token。构建只需公共 Client ID。运行时由官方设备授权取得的 access／refresh 凭据仅在本机 Main 使用并按下节 OS 加密保存；不要求用户发给发布者，也不经环境变量、Renderer、日志、URL 或源码传递。

## 4. 用户安装、selected repositories 与新库恢复

“登录授权 App 代表我操作”与“把 App 安装到仓库所属账户并授予指定仓库”是两件事。官方[安装 GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)说明了安装账户与仓库范围选择；优先使用 **Only select repositories**，只选本论文相关仓库，不为省一步要求 All repositories。

1. 用户明确点击应用内登录后，Main 取得新鲜有效短码并自动打开固定官方 GitHub 设备授权页；无需额外原生“继续”弹窗。核对 App 与本人账号，输入应用显示的验证码（可明确点击复制）。取消、过期、后台刷新不再次打开浏览器；失败保留当前短码与显式重试入口。不要替别人输入验证码或向发布者发送 token。

   当前仍采用设备授权：GitHub 官方流程要求输入 `user_code`，没有据此承诺 `verification_uri_complete` 或拼接 `?user_code=` 自动填码。现行 GitHub App 网页 OAuth 即使使用 PKCE，交换代码仍要求 `client_secret`，不能塞进 Electron；用户本轮选择先自动打开并保留短码，而不是新增密钥服务端。依据：[官方设备流程](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)及[官方代码交换参数](https://github.com/github/docs/blob/main/data/reusables/apps/web-app-flow-exchange-code.md)。
2. 仓库所有者／有权管理员通过应用内“管理项目授权”进入固定官方页面，安装正确 App 到**仓库所属账户**，选择相应私库并保存。组织可能要管理员批准；没有权限时请所有者处理，不用安装到无关个人账户假装已授权。
3. 回应用刷新项目。可用项目必须同时满足用户访问权和 App 对该仓库的安装权限；刷新列表／进入操作时仍复核，缓存链接不是永久授权。
4. App 内新建请求固定 `private:true, auto_init:false`，并再次检查 GitHub 响应确认为私有；**没有 public 切换、没有事后 PATCH 可见性的“补救”**。不要照抄 GitHub 文档默认 `private:false` 的示例；我们的产品不创建公开论文库。
5. 若新库已创建，但响应是 `accessible:false`／界面显示尚未授予 App 访问：**仓库存在，不是创建失败；不要重复点创建**。这在 selected-repositories 安装未包含新库时需要恢复。点“管理项目授权”，由有权的仓库所有者／管理员把**已创建的那个私库**加入 App 安装范围；回应用刷新，选择已有项目关联。关联／创建本身不等于上传，后续明确同步才交换文件。
6. 即使 API 请求超时／取消，也可能已经在 GitHub 创建成功或邀请已发出。先查官方页面并刷新，不能因本地未确认就自动重发写操作。App 安装范围不允许静默扩大；“管理授权”按钮不保证当前账号有权做这一改变。

[新库／邀请动作实现](<../client/src/main/collaboration/project-actions.ts>)与[普通工作流](<../client/src/main/workspace/cloud-workflows.ts>)保留上述 `accessible:false`，不自动关联／上传未确认授权的仓库。

## 5. 邀请与分享不是公开链接访问

- A 在私有项目中确认邀请 B 的 GitHub 用户名，申请编辑访问；A 本身须有权邀请。App 申请了 Administration Write 也不能替没有管理权的普通合作者越权邀请别人。
- B 在自己的账号登录，可以刷新应用内待接受邀请并明确确认；若 API 权限／组织策略阻止列出或接受，通过 GitHub 官方通知页／邮件接受是人工恢复方案，不能把失败隐藏成成功。当前界面接线以最终构建为准，官方通知页为 `https://github.com/notifications`。
- **仓库所属账户**的 App 安装也必须已覆盖该库；B 登录授权并接受个人协作邀请，不会自动扩展 A／组织的 App 仓库范围。若缺授权由仓库所有者／管理员更新安装。B 不需要为了读取 A 已授权的仓库再向自己无关账户安装一个副本，更不需注册自己的 App。
- B 接受并获得足够权限、且 App 安装覆盖后，回应用刷新已授权项目，选择下载到空文件夹或粘贴分享链接加入。App 用户授权、邀请接受、安装仓库选择、下载是不同步骤，不能合并宣称“一次点击自动通过”。
- 分享的是普通 `https://github.com/owner/repository` 项目定位链接，**不是 bearer token、公开访问许可或邀请接受凭证**。未被邀请／未授权的人得到链接仍不能读私库；不能靠分享链接自动邀请或改为 public。

## 6. 会话与正式验收清单

访问与续期凭据仅在 Main 持有，IPC 不回传；0.3.8 按用户的持久登录请求，在独立 App-session 文件中以操作系统加密保存同一有界授权的 access／refresh 配对，旧 PAT Vault 不参与。安全存储不可用／basic_text／加密被拒绝时不以明文落盘，只能本次运行有效。主进程在短期 access 到期前自动轮换，并先保存新配对、再重新 GET /user 验证身份；旋转前等待已有仓库授权请求退出，不沿用过期访问权限。暂时网络失败保留加密授权，有限间隔自动恢复，不开启浏览器或自动操作项目。新配对的 refresh 期限仍由 GitHub 限定（默认约六个月，安全校验最多186天），并非永不过期；到期、撤销或主动退出须重新授权。正常关闭等已派发的轮换收束再退出；Logout 则取消、收束并清除迟到凭据，不能被后台结果复活。旧记录无 refresh，升级后需显式登录一次。退出仍只清本机登录，**不撤销 GitHub 已授予的 App 权限／安装，不影响其他设备，也不删除私库或论文**；要全局撤销须在 GitHub 官方设置操作。

以后获得发布者真实 App 与测试账号的明确授权，至少验收以下项目；本次文档工作未执行这些账号操作：

- 正确 Client ID／slug 与 Device Flow 开关；未配置、错误配置、拒绝、超时、到期与退出／重启。
- 个人账户首次安装：selected repositories 为空／已有项目两种状态下能否建库；建库始终私有，未覆盖新库返回 `accessible:false` 时可恢复且不重复创建。
- A/B 两个真实用户：邀请、B 的 App UAT 列出／接受、所有者安装范围、只读账号拒绝写、分享链接无权访问、显式下载和同步／历史。
- App 取消安装／移除选中库／权限更新未批准／用户协作权撤销后 fail-closed；不自动换 PAT／OAuth App／公开库。
- 请求取消／网络中断时已发生的远端写入如何重新核对，不依赖“本地报错＝远端没发生”。
- 组织／SSO／外部合作者若纳入发布承诺须单独测，不拿个人账号结果外推；Mac 与可信签名后的新版原样安装另行验收。

Mock／配置单测／类型检查／本地构建只能证明各自覆盖的代码路径，不能证明 GitHub 注册、权限组合、真实账号互通或可信发布完成。
