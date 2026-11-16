# Interface languages / 界面语言 / 인터페이스 언어

LatexStudio provides three application interface languages: 简体中文, English and 한국어. Chinese remains the default for an existing installation without a saved preference.

## 中文

点击右上角账号／头像菜单 → **语言**，选择 **简体中文、English、한국어**。软件即时更新自身界面，并保存选择供下次启动使用。无需退出账号或重新打开论文。

语言覆盖项目首页、文件树操作、编辑器工具和搜索、PDF 控件、修改历史、账号、项目关联与同步、组件配置、更新，以及软件自己的确认、状态与固定错误提示。时间和日期按所选界面语言显示。

不会翻译或改写论文正文、LaTeX 代码、文件和目录名称、章节标题、账户名称、仓库标识、历史中真实保存的写作说明、技术错误里的原始数据和编译器原始日志。第三方完整许可证保留原文。切换不触发登录、同步、编译或项目写入，不重置草稿、选择和撤销历史。

Windows/macOS 自身提供的文件选择器等通用控件仍遵循操作系统语言；软件提供的标题和操作说明随界面语言变化。GitHub 等外部网页使用其自身的语言设置。

## English

Open the account/avatar menu at the top right → **Language**, then choose **简体中文, English or 한국어**. The application updates immediately and remembers the choice after restart. Changing language does not require signing out or reopening the paper.

This covers the project home, file controls, editing tools and search, PDF controls, history, account, repository setup and synchronization, component setup, updates, and application-owned confirmations, statuses and fixed error messages.

Your paper, source code, filenames, section titles, account/repository identifiers, original revision notes, diagnostic data, compiler logs and full third-party license texts are not translated or rewritten. Language changes do not initiate authentication, synchronization, compilation or project writes, and do not reset the draft, selection or undo history. Operating-system controls and external websites retain their own language settings.

## 한국어

오른쪽 위 계정/아바타 메뉴 → **언어**에서 **简体中文, English 또는 한국어**를 선택하세요. 앱 인터페이스가 즉시 바뀌고 다음 실행에도 선택한 언어가 유지됩니다. 로그아웃하거나 논문을 다시 열 필요가 없습니다.

프로젝트 홈, 파일 작업, 편집 도구와 검색, PDF 도구, 수정 이력, 계정, 저장소 연결 및 동기화, 구성 요소 설정, 업데이트, 앱 자체의 확인 창·상태·고정 오류 메시지에 적용됩니다.

논문, 소스 코드, 파일명, 절 제목, 계정/저장소 식별자, 실제 저장된 수정 설명, 원본 진단 데이터, 컴파일러 로그 및 타사 라이선스 전문은 번역하거나 변경하지 않습니다. 언어 변경은 로그인·동기화·컴파일·프로젝트 쓰기를 실행하지 않으며 초안·선택 영역·실행 취소 이력을 초기화하지 않습니다. 운영체제 공통 컨트롤과 외부 웹사이트는 자체 언어 설정을 따릅니다.

## Implementation boundaries

- Renderer: canonical application-message bindings, static trusted templates, literal data exclusions, and a CodeMirror phrase compartment. No page-wide mutation observer, HTML injection, remote translation service or language-triggered account/project access.
- Main: a narrow enum-only preference API accepts only `zh-CN`, `en` or `ko` from the existing trusted application main frame. It does not accept paths, credentials, arbitrary setting keys or repository authority.
- The preference is a versioned `ui-language.json` record in the application data directory, not inside a paper or repository. Reads are bounded; private atomic writes are serialized and acknowledged after durable save/readback. Existing draft, cancellation, HTTP cleanup and close handshakes remain in place.
- A failed preference write keeps the current interface choice and displays a fixed safe error. If a legacy optional bridge is absent, writing remains available and the interface explicitly identifies a session-only language choice rather than claiming persistence.
- Automated verification must include all three languages, literal placeholder preservation, native preference/frame/argument constraints, no change to draft/undo/source, complete owned-UI text coverage, and restart persistence in an isolated profile. Platform-native Mac GUI and installer/signing acceptance remain separate from Windows unit or contract tests.
