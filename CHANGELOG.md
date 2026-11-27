# 更新记录

## 未发布

- 安全：手填的浏览器路径必须是绝对路径、并且指向一个普通文件，否则在启动任何东西之前就带着原因被拒绝。浏览器路径是引擎唯一「照人一句话就启动某个可执行文件」的入口：相对路径会被解析到引擎自己的工作目录，要么因为看不见的原因失败，要么启动的是另一个同名的程序；目录或设备则会在启动里晚一步失败，报的是「浏览器起不来」而不是「路径写错了」。插件在开始登录前就用 `browserPathProblem()` 拒绝（`index.ts` 的 `browserLogin()`），引擎在 `Logins.start()` 里再否决一次——真正启动它的是引擎，判断用同一份实现（`engine/browser.ts`）。粘贴时常带的成对引号与首尾空白先由 `normalizeBrowserPath()` 去掉，不成对的引号保持原样、照旧报错。新增 `test/browser-path.test.ts` 三个测试，`contract.test.ts` 追加相对路径与目录路径的拒绝断言。`SECURITY.md` 不变量增到十七条，设计见 `docs/adr/0009-typed-browser-path.md`。
- 安全：免鉴权的登录进度页从此不做活，引擎整面都有固定的在飞上限。以前 `GET /login/<id>` 不管 ID 真假都会问驱动，而驱动的 `ensure()` 会拉起 Node/浏览器驱动进程，每次请求还注册一个约 100 KB 的驱动事件通道——一个本机请求就能让引擎开进程、占内存。现在（1）登录 ID 在路由匹配器里就按 `login_start` 发出的形状校验（8–32 个 `[A-Za-z0-9_-]`），编出来的路径是普通 404；（2）没有驱动在跑时，页面用 `driver.Running()` 直接回答「找不到这次登录」，完全不碰 `ensure()`；（3）每个非 health 路由都要先取在飞令牌——免鉴权面 4 个、持密钥面 64 个——满了直接 `503 engine_busy` 带 `Retry-After: 1`，不排队、不撑内存。鉴权在取令牌之前，刷错密钥只能花常数时间且拿不到令牌；`/v1/health` 豁免，在飞的引擎不会被答成「引擎不在」。新增 `engine-go/admission_test.go`：把 `MUSE_WEB_NODE` 指到测试二进制本身，页面 GET 之后标记文件不存在、同一运行时下带密钥的 `POST /v1/login` 之后存在，另外各自打满并释放两个预算、错密钥不占令牌、畸形 ID 一律 404。`SECURITY.md` 不变量增到十六条，设计见 `docs/adr/0008-admission-control.md`。
- 安全：`engine.log` 现在一行一条、谁都伪造不了。`logger.Log()` 是写日志的唯一出口，每条记录先过新增的 `oneLine()`：`\r`、`\n`、`\t`、其余控制字符与 U+2028 / U+2029 一律换成空格，单条上限 2048 字节。请求路径写进日志时是百分号解码后的样子，所以一个**不带密钥**的本机请求原本可以用 `%0A` 往日志里接一条看起来像真的记录；现在客户端路径、驱动消息和子进程 stderr 都不可能多写一行。顺带把驱动 stderr 的未成行缓冲限制在 64 KB，只写不换行的子进程不再能无限占内存。新增 `engine-go/log_test.go` 四个测试，`SECURITY.md` 不变量增到十五条，设计见 `docs/adr/0007-log-integrity.md`。
- 安全：connector 版补齐与完整版一致的凭据防线。此前 connector 对任何 `MUSE_WEB_ENGINE` 地址直接发 `engine.key` 和账号句柄，还走环境代理、跟随重定向；现在（1）地址必须是本机回环或 `https`，明文 http 的局域网 / 域名地址在连接前就被拒绝并说明原因；（2）端口先要对 `/v1/health` 的 HMAC 挑战自证（与完整版引擎逐字节一致的实现），证明不了的冒充端口拿不到密钥；（3）回环请求直接走 `node:http(s)`，不经过环境代理；（4）任何 3xx 一律拒绝而不追，防止账号句柄被重定向到未经审查的地址。新增 `connector/security.test.ts` 与完整版 `test/engine-origin.test.ts` 驱动同一张允许 / 拒绝矩阵（10 个 connector 测试全绿），完整版 `anyFetch` 同步加「拒绝重定向」并由 `test/local-fetch.test.ts` 守住。
- 安全：凭据（`engine.key` 与账号句柄）只在回环或 `https` 上传输。插件指向外部引擎（`MUSE_WEB_ENGINE` / `engine` 选项）时，新增的 `credentialSafeUrl()` 只在目标是本机回环或 `https:` 时才允许发送；明文 http 的局域网 / 域名地址（无论是手输还是某个 Agent 的环境带入）在探测前就被拒绝，插件报「引擎连不上」并说明要用 https 或 `127.0.0.1`，连接不会建立。新增 `test/engine-origin.test.ts` 钉住允许 / 拒绝集合与被拒地址「一字节密钥都收不到」。设计见 `docs/adr/0006-credentials-over-the-wire.md`，`SECURITY.md` 不变量增到十四条。
- 安全：免鉴权的 `/v1/health` 不再返回账号数——任何本机用户都能问它，现在只说「引擎在、哪个版本」，账号数留在密钥之后的 `/v1/accounts`。新增 Go 测试 `TestHealthDoesNotCountAccounts` 守住这条，`test/go-engine.test.ts` 相应断言 health 不再带 `accounts`。
- 变更：引擎监听器的超时与上限收敛到一处构造（`main.go` 的 `newHTTPServer()`），新增 `ReadTimeout`（30 秒，头与体一起计时）——一个只滴字节、迟迟不结束的请求再也无法长期占住进程；仍不设 `WriteTimeout` 以免截断 SSE 流。新增 `TestHTTPServerSetsItsLimits` 钉住各超时与头部上限。
- 安全：引擎的 HTTP 层重构为显式路由表（`engine-go/server.go` 的 `routes()`）：每个端点一行，
  写明方法、路径、是否需要密钥和处理函数；`route()` 在进入任何 handler 前统一鉴权，「每个
  `/v1/*` 都要密钥」从「每个作者记得写」变成表里声明的一行，新增 `engine-go/server_test.go`
  遍历路由表核对鉴权与免鉴权集合（免鉴权的只有 health 和登录进度页）。外部行为不变：方法
  不匹配仍是 404。
- 安全：`ServeHTTP` 在路由之前检查 `Host` 头，只接受 `127.0.0.1`、`localhost`、`[::1]` 和
  `0.0.0.0`（可带端口），其它一律 403 `host_not_allowed`。DNS rebinding 的页面到达端口时仍
  带着自己的域名，从此连免鉴权的 health 答案和登录进度页也读不到。设计见
  `docs/adr/0005-route-table-and-host-guard.md`，`SECURITY.md` 的不变量相应从十一条变十二条。
- 安全：插件现在先让端口证明自己持有 `engine.key`，再把密钥发过去。`/v1/health` 仍然免鉴权，但带 `x-muse-challenge: <nonce>` 时引擎会回 `proof = hex(HMAC-SHA256(engine.key, "muse-web-health:" + nonce))`，插件只在常量时间比较通过后才发密钥或账号句柄；证明不了的端口一律不发。端口被抢注、或升级后仍在运行的旧版引擎，从此拿不到 `engine.key`，插件改为直接报「端口被占用」并提示重启 Magpie。Go 与 TypeScript 两侧的 HMAC 实现由同一组固定向量钉住（`engine-go/health_test.go`），新增 Chrome-free 的 `test/engine-identity.test.ts` 覆盖「冒充者拿不到密钥」与「能证明的旧引擎带密钥退役」，真实浏览器测试里的旧引擎假件也改为按真实方式自证。设计见 `docs/adr/0004-health-challenge.md`，`SECURITY.md` 的不变量相应从十条变十一条。
- 文档：`README` 补充「端口先证明身份才拿得到密钥」的安全边界与「升级后提示端口被占用」的排查条目；`docs/adr/0003` 里延期实现的 health challenge 改为指向 ADR 0004。
- 安全：引擎浏览器不再带 `--remote-allow-origins=*`。DevTools 仍然只绑 `127.0.0.1` 的随机端口，但浏览器会拒绝带 `Origin` 头的握手，所以账号资料目录里加载的网页再也连不上 CDP——控制不了浏览器，也读不到 muse.ai 会话。引擎自己的客户端不发 `Origin`，照常连接；单测守住这条参数，真实浏览器测试跑通整条链路，Wayfern 内核上的冒烟验证里裸握手能连、带 `Origin: http://evil.test` 的握手回 403。
- 安全：所有响应统一带 `x-content-type-options: nosniff`，没有自己指定缓存策略的响应默认 `cache-control: no-store`（SSE 流保留 `no-cache`）；登录进度页 `/login/<id>` 另加 `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; …`、`x-frame-options: DENY` 和 `referrer-policy: no-referrer`。
- 新增：`SECURITY.md` 写清信任边界、十条必须保持的不变量（只监听回环、Bearer 常量时间比较、目录 0700 / 文件 0600 与原子写、日志脱敏、DevTools 不对网页开放、8 MB 请求体上限、`nosniff` / `no-store`、登录页最小权限、下载校验与防解压穿越、不复用日常浏览器资料）以及已知残留风险；`docs/adr/0003` 记录这次取舍，README 的安全边界一节链接过去。
- 变更：文档与资源里的项目名统一为 `MuseWeb2Magpie`（仓库名）——README 标题、概述、方案对比、架构图、SVG 图里的文字以及 docker 测试镜像名原来写的是旧名 `magpie-muse-web`。安装命令收敛为 `magpie plugin add github:CYoJkoY/MuseWeb2Magpie`，并注明 npm 上的 `magpie-muse-web` 是旧版本、不再随仓库更新。包名仍是 `magpie-muse-web` / `magpie-muse-web-connector`，Magpie 的安装、升级和已装插件的 id 都不受影响。
- 新增：登录前选择浏览器的列表末尾多了「手动填写浏览器路径…」。选了它并填上浏览器可执行文件的完整路径，就能用便携版、绿色版或装在别的盘、自动扫描扫不到的浏览器登录；从列表里选中的浏览器优先于残留的手填路径，只选不填或路径不存在都会在开始登录前直接报错。
- 新增：优先使用本机 Donut Browser 自带的 Wayfern 内核。引擎自动查找 `%LOCALAPPDATA%\DonutBrowser`、`DONUTBROWSER_DATA_DIR` / `DONUTBROWSER_DATA_ROOT` 指到的目录，以及 Scoop 安装的 `apps\donutbrowser\current\data`，取 `binaries\wayfern` 下版本最高的内核。Wayfern 在命令行上就是普通 Chromium，按 Chromium 启动，不加 `--fingerprint` 参数，也不读写 Donut 自己的账号数据。`MUSE_WEB_DONUT_BROWSER` 可以指向 Donut 的 data 目录或内核文件，设为 `0` 时跳过 Donut、只用 Apostate。
- 新增：`engine/fingerprint.ts` 的浏览器准备顺序改为：`MUSE_WEB_FINGERPRINT_BROWSER` → Donut 的 Wayfern 内核 → 本机已有的 Apostate → 下载固定版本的 Apostate。登录时的浏览器列表里，Donut Browser（Wayfern 内核）排在第一位，其次是 Apostate 指纹浏览器。
- 修复：Wayfern 内核按各系统的真实命名识别——Windows 是 `chrome.exe`，macOS 是 `Chromium.app/Contents/MacOS/Chromium`（或同结构的 `Wayfern.app`），Linux 是 `chrome` / `chromium` / `wayfern`——避免在 macOS、Linux 上找不到 Donut 的内核。
- 测试：覆盖 Wayfern 内核优先复用且不触网、多版本取最高、`MUSE_WEB_DONUT_BROWSER` 指向目录 / 内核 / `off`、各系统内核命名，以及登录列表把 Donut 排在第一项（Windows / macOS / Linux 都按本机内核形状构造）。

## 0.11.0 · 2026-11-27

- 性能：冷启动的额度读取从串行改为有界并发（同时 3 个账号）。Go 引擎的预热门与 TypeScript 驱动采用同一上限，账号多时总耗时明显下降，又不会一次开出过多标签页。
- 性能：写入浏览器上下文的 cookie 合并成一次 `Storage.setCookies`；浏览器拒绝整批时才逐条回退，建上下文和续期各少一次每 cookie 的往返。
- 性能：发送消息前的聚焦、滚动与输入框定位合并成一次页面求值，少一次 CDP 往返。
- 修复：回答结束 1.5 秒后的额度刷新先检查账号是否已被新对话占用，避免读数排在对话之后白等一轮。
- 新增：Go 驱动协议的基准测试（流式事件解码、请求编码、账号查询）与 `npm run bench`；`docs/perf.md` 记录测量方法、实测数字与热路径；`docs/adr/0002` 说明这些取舍。
- 版本：0.11.0。

## 0.10.0 · 2026-11-27

- 变更：HTTP 接口、账号存储、密钥、登录进度页和进程守护迁移到静态 Go 引擎；浏览器页面操作由 TypeScript 驱动通过 NDJSON 协议负责。
- 变更：插件启动随包提供的当前平台 / 架构 Go 二进制，并把插件宿主的 TypeScript 运行时交给浏览器驱动；删除旧的 TypeScript HTTP server、store 和 main 入口。
- 新增：Go 引擎的 loopback HTTP 集成测试覆盖健康检查、鉴权、流式 / 非流式回答、工具调用、忙碌、额度、过期会话、续期、登录进度页和优雅退出。
- 新增：`npm run build:engine`、`npm run test:go` 和 `npm run no-javascript`；发布包为六个平台 / 架构构建原生引擎，并检查源码不含 `.js` / `.mjs`。
- 修复：构建工具链要求 Go `>=1.27.4`，避免旧版链接器生成的测试程序在当前 macOS 上因缺少 `LC_UUID` 无法启动；Linux 测试镜像同步提供 Go。
- 版本：0.10.0。

## 0.9.0 · 2026-11-27

- 变更：源码从 JavaScript 全量迁移到 TypeScript。插件、引擎、connector 与测试都改为 `.ts`，仓库里不再有 `.js` / `.mjs` 源文件，`npm run no-javascript` 会在 CI 里把住这道门。
- 变更：直接由 Node 运行 `.ts`（原生类型擦除），不再需要构建步骤；`engines.node` 提高到 `>=22.18`。
- 新增：`npm run typecheck`（`tsc --noEmit`），源码与测试都在类型检查内；CI 三平台先跑类型检查和 no-JavaScript 守卫，再跑测试。
- 新增：`engine/types.ts` 收拢共享类型，引擎、插件与 connector 共用同一套账号、额度与对话结构。
- 版本：0.9.0。

## 0.8.0 · 2026-11-26

- 新增：默认浏览器改为开源指纹浏览器 [Apostate](https://github.com/heretic-tech/apostate)。本机已有就复用；没有时引擎启动时自动下载一次固定版本（带 sha256 校验）到数据目录，失败或设 `MUSE_WEB_FINGERPRINT=0` 时改用本机 Chrome、Edge、Chromium 或 Brave。`MUSE_WEB_FINGERPRINT_BROWSER`、`MUSE_WEB_FINGERPRINT_VERSION` 和 `MUSE_WEB_FINGERPRINT_PLATFORM` 可控制复用路径、版本和指纹平台。
- 修复：跟进 muse.ai 当前网页结构。聊天输入框除 `<textarea>` 外也支持 contenteditable 编辑器；回复气泡兼容新的类名和 `data-testid` 标记；等待中的 Stop 按钮兼容新的控件名；`/api/session` 支持新的就绪状态、嵌套会话对象和 VM 字段；登录页的 `hatch.login` 门控也提前识别。
- 新增：`assets/` 里保留 `icon.svg` 源文件，并提供 512×512 `icon.png` 和多尺寸 `icon.ico`。
- 测试：新增图标资源、指纹浏览器查找/下载/校验，以及当前网页结构的真实浏览器回归测试。
- 版本：0.8.0。

## 0.7.0 · 2026-11-22

- 新增：本机装了多个 Chromium 系浏览器时，登录前先让你选一个；候选是本机已安装的 Chrome、Edge、Chromium、Brave，`MUSE_WEB_CHROME` 指定的仍排第一。选择只影响这一次登录窗口，日常浏览器的登录态照旧不会被使用（[#13](https://github.com/JohnWangggg/magpie-muse-web/pull/13)）。
- 修复：Linux 上的 `microsoft-edge`、`microsoft-edge-stable` 会被标成 Google Chrome；同一个浏览器的多个可执行文件（如 `google-chrome`、`google-chrome-stable`、`/opt/google/chrome/chrome`）不再重复列出。
- 测试：新增 Linux / Windows 路径下的浏览器选择列表用例，三平台 CI 通过。

## 0.6.1 · 2026-11-18

- 新增：引擎的 `GET /v1/accounts`，返回账号 handle、名称和过期时间，不返回 cookie；供 connector 版选择账号和诊断使用。
- 新增：`connector/` 独立包 `magpie-muse-web-connector@0.1.0`。它不启动浏览器、不读 cookie、不 spawn 进程，只连接已运行的 `MUSE_WEB_ENGINE`；使用同一个 provider id `muse-web`。
- 修复：`dataDir()` 在 Windows 上模拟 darwin/linux 时用 `path.join` 产生反斜杠；改用 `path.posix.join`，真实平台行为不变。
- 测试：connector 的 6 个契约测试加入根 `npm test` 与三平台 CI。

## 0.6.0 · 2026-11-18

- 修复：muse.ai 在 `/api/session` 返回 200、但没有分配 workspace 时可能同时轮换 cookie；旧实现先抛错、后解析 `Set-Cookie`，导致账号继续使用已被撤销的 cookie（移植 muse2api v1.6.11 的修复）。现在先合并并持久化 `Set-Cookie`，再把错误交给调用方。
- 修复：发送按钮不再全页搜索 `send`，而是先限定在 textarea 所在的 composer 容器内，并排除 Stop/取消，避免点到侧栏按钮（移植 muse2api v1.6.10 的修复）。
- 修复：流式回答中途失败时补 `data: [DONE]`，客户端不会一直等到超时；错误事件带 `stream_interrupted`。
- 新增：错误响应带机器可读的 `error.code`（`session_expired`、`account_busy`、`quota_spent`、`prompt_too_long`、`vm_warming`、`page_unavailable`、`send_failed` 等），429/503 带 `Retry-After`。
- 新增：历史预算约 40 万字符 / 80 轮，超出时保留 system 与最近若干轮并注明省略条数；页面明确拒收过长消息时返回 413 `prompt_too_long`。
- 新增：`tool_choice` 为 `required` 或指定工具时，模型只回文本会追加一次 repair 提示；仍不调用返回 422 `tool_call_not_parsed`。
- 新增：登录后的测试消息在 VM 预热类失败时重试最多 3 次（Auth/Quota 不重试），降低首次登录偶发失败。
- 其他可靠性：`engine.key` 用 `wx` 排他创建，两个引擎同时启动不会各自装一把钥匙；refresh 拿不到 expiry 时回退到旧值/一天后；额度窗口逐条过滤，坏掉一项不再丢掉全部；错误体和日志里的 Bearer/token/hatch cookie 会脱敏。
- 文档：补 `MUSE_WEB_ENGINE_KEY`、`MUSE_WEB_SITE`、安全边界、错误码表，以及与 `magpie-muse-auth`（Meta API）的对比；安装优先写 npm 包名。
- 版本：0.6.0。

## 0.5.10 · 2026-11-11

- 说明：登录会开两个窗口。系统默认浏览器里的是本机进度页，真正登录在引擎另开的 Chrome、Edge、Chromium 或 Brave 窗口里；不会用日常浏览器的登录态，Firefox 不能当登录窗口（[#12](https://github.com/JohnWangggg/magpie-muse-web/issues/12)）。进度页正文也写明了这一点。

## 0.5.9 · 2026-11-09

- 修复：muse.ai 已经在聊天里生成了图片，引擎只读气泡里的文字，图片和写在 `.prose` 外面的说明都不会返回（[#11](https://github.com/JohnWangggg/magpie-muse-web/issues/11)）。现在把最新回复气泡里的图片、视频附在文字后面；`blob:` 地址会转成 data URL。仍不提供单独的生图、生视频接口。

## 0.5.8 · 2026-11-05

- 修复：muse.ai 先输出一句进度、停止按钮消失后才写工具调用时，引擎会把回复提前判定为结束，客户端只收到进度文字（[#10](https://github.com/JohnWangggg/magpie-muse-web/pull/10)）。工具请求现在在文字静止后等待 4 秒；停止按钮消失时会重新开始计时。
- 普通聊天不启用这段等待（0.5 秒），避免每条回复都多等 4 秒；停止按钮一直存在时的上限从约 4.8 秒调整为 15 秒。
- 回归测试覆盖“暂停后写工具调用”和“停止按钮长时间存在后才写工具调用”。

## 0.5.7 · 2026-11-05

- 修复：工具调用解析过宽，模型解释或引用 `{"name":"shell",...}` 时会被当成真实调用执行，引用内容还会从回复里消失（[#8](https://github.com/JohnWangggg/magpie-muse-web/issues/8)）。现在只执行明确的 `<tool_call>`、`tool_call` 代码块，或整段回复就是该 JSON / 带 `tool_call` 标签的 JSON；正文里引用的 JSON 保持文本。
- 修复：引擎以 detached 方式启动后不会随 Magpie 退出，关掉 Magpie 后仍在后台每 30 分钟续期、唤醒账号虚拟机（[#9](https://github.com/JohnWangggg/magpie-muse-web/issues/9)）。插件现在把 Magpie 的 pid 传给引擎，父进程消失后引擎自行退出；手动运行 `node engine/main.ts` 不受影响。

## 0.5.6 · 2026-11-03

- 修复：多轮工具调用时，空输出的工具结果（例如 `mkdir`、`mv` 这类没有 stdout 的命令）会被丢掉，引擎误以为没有新消息，把整段历史重新发进已有对话，模型于是复读上一轮内容或说“正在等待执行结果”后提前结束（[#7](https://github.com/JohnWangggg/magpie-muse-web/issues/7)）。空结果现在写成「（无输出）」照常发送。
- 修复：同一轮并行调用多个工具时，只有最后一个结果会发给页面。现在最后一个 assistant 回复之后的所有结果按顺序一起发送。

## 0.5.5 · 2026-11-02

- 修复：代理环境变量末尾带斜杠（如 `https_proxy=http://127.0.0.1:7897/`）时，`--proxy-server` 里的斜杠让 Chrome 丢弃代理，登录窗口打不开 muse.ai 并报 `ERR_NO_SUPPORTED_PROXIES`（[#4](https://github.com/JohnWangggg/magpie-muse-web/issues/4)）。代理 URL 现在统一去掉尾部斜杠，环境变量、`MUSE_WEB_PROXY` 和系统代理都一样。
- 修复：Windows 上 Chrome 在启动阶段退出时只报 `browser exited during start`，看不到真正原因（[#5](https://github.com/JohnWangggg/magpie-muse-web/issues/5)）。现在错误里带上退出码（或信号）和 Chrome 自己写到 stderr 的最后几行；窗口模式还加了 `--disable-background-mode` 和 `--new-window`，避免后台常驻的 Chrome 接手新实例后立即退出。
- 登录资料目录里的临时 Chrome 进程不再留在后台：引擎关掉窗口时一并退出。

## 0.5.4 · 2026-10-27

- 修复：muse.ai 不再下发 `hatch_gw` 和 `hatch_vml`，登录会停在「正在打开聊天页领取会话」直到超时（[#2](https://github.com/JohnWangggg/magpie-muse-web/issues/2)、[#3](https://github.com/JohnWangggg/magpie-muse-web/issues/3)）。现在有 `hatch_sess` 和 `hatch_native_auth_device` 就确认会话。这两个 cookie 以后如果又出现，仍然会保存。

## 0.5.3 · 2026-10-26

- 额度卡片认繁体界面：每星期、每週、額外、永不過期，以及设置菜单里的「設定」。用量仍从进度条读取。
- 登录不再等待 `hatch_gw`。它只是网关缓存，有就保存；会话是否完成看 `hatch_sess`、`hatch_vml` 和 `hatch_native_auth_device`。

## 0.5.2 · 2026-10-15

- 修复：0.5.1 起每次启动浏览器都换一个新的资料目录，Chrome 会往里重新下载组件和本地模型，每次约 100 MB。现在关掉了这些下载，新目录保持在几 MB。

## 0.5.1 · 2026-10-15

- 修复：上一个 Chrome 没退干净、还占着浏览器资料目录时，新的浏览器起不来，请求一直返回 503（Windows 上是 `browser exited during start`）。
  引擎的浏览器现在每次用一个新的临时资料目录，关闭时删除；不再强删 Chrome 的锁文件。账号登录信息照旧从账号存储写入，不受影响。感谢 [@lesnolie](https://github.com/lesnolie)（[#1](https://github.com/JohnWangggg/magpie-muse-web/pull/1)）。
- 引擎被强制结束或断电时留下的临时资料目录，下次启动浏览器时自动清理；仍有浏览器在用的不动。

## 0.5.0 · 2026-10-14

- 大幅提速：每个账号只开一个页面并保持和虚拟机的连接，会话之间用页面自己的路由切换对话，不再开新标签或重新加载。
  新会话和切回旧会话，准备页面从 10～37 秒降到约 0.5 秒，首字 2～5 秒。
- 修复：中文界面显示「正在连接…」「仍在发送中」时，引擎当成已就绪就发送，消息卡住直到首字超时。
- 调用方中途断开、上一条回答还在生成时，先点停止按钮，不再重新加载页面。
- 读回答不再扫描整页 DOM；续期 cookie 不再挡住已经打开的页面；页面还在连接时，加载时限延长一次。

## 0.4.1 · 2026-10-13

- 修复：电脑睡眠或闲置很久后，引擎和浏览器的连接断开，之后每个请求都立刻失败（`503 Target.createTarget: connection closed`），只能重启引擎。
  现在连接一断就放下这个浏览器，下一个请求自动开一个新的；引擎日志会记一行 `browser lost`。

## 0.4.0 · 2026-10-13

首个公开版本。

- 工具调用：请求带 `tools` 时，工具写进提示词，模型以 `tool_call` 代码块回答，解析成标准的 `tool_calls`，流式和非流式都支持。
  提示词讲明用户的电脑不是模型自己的云端虚拟机，否则它会在自己的虚拟机里执行命令。
- 登录后发一条测试消息，账号能回答才算登录成功；额度已用完的账号也算成功。
- 消息里的图片、文件换成「[图片]」「[文件]」字样，不再让整条请求失败。
- 修复：页面把列表符号等渲染掉时，回答的开头会重复几遍。
- 修复：回答下方的“建议回复”按钮文字混进回答。
- 修复：读额度失败后没有等 2 分钟就重试。
- 引擎日志记录带工具的请求调用了哪些工具。

## 0.3.0

- 在浏览器窗口里登录 muse.ai；同一个账号再登录会更新原账号，不会多出一个。
- 每个账号一个浏览器上下文，每个 Magpie 会话一个标签页；同一会话继续聊时只发最新一条消息。
- 引擎启动和登录后预热账号；闲置 60 分钟关浏览器；每 6 小时续期并唤醒一次闲置账号的虚拟机。
- 额度卡片读取 muse.ai 设置页的「每周」和「额外额度」，带重置时间。
- 额度用完立刻返回 429，登录失效返回 401，账号忙时返回 429，由 Magpie 换号。
- 插件图标；支持 macOS、Windows、Linux（Linux 无桌面时会说明无法打开登录窗口）。
