# 安全模型与漏洞报告

这个插件在本机跑一个只监听回环地址的引擎，用你自己的 muse.ai 网页登录态替 Magpie 发消息。
下面写清楚它保护什么、不保护什么。设计取舍的来龙去脉见
[`docs/adr/0003-local-engine-security.md`](docs/adr/0003-local-engine-security.md)。

## 报告问题

请用 [GitHub Issues](https://github.com/CYoJkoY/MuseWeb2Magpie/issues) 报告，或在不公开细节的前提下先开
一个 issue 说明联系方式。**不要**贴 cookie、`engine.key` 或未脱敏的日志；`engine.log` 里的上游报错
可能仍带有普通文本，分享前请自己过一遍。

## 信任边界

| 对象 | 是否可信 | 说明 |
| :--- | :--- | :--- |
| 当前登录的操作用户 | 可信 | 引擎、数据目录和浏览器都跑在这个用户名下；同用户权限内的其他进程在操作系统眼里一样可信 |
| 其它用户 / 其它账户 | 不可信 | 跨用户保护完全由操作系统的文件和端口权限提供 |
| 引擎浏览器里打开的网页 | 不可信 | 包括 muse.ai 自己返回的内容和第三方资源 |
| 本机网络与代理 | 不可信 | 引擎只连回环，不监听对外地址 |

## 不变量

以下每条都是设计约束，改动时请连同测试一起改，不要单向放松。

1. **只监听回环。** `engine/main.ts` 用 `createServer(...).listen(port, "127.0.0.1")`，端口来自
   `MUSE_WEB_ENGINE_PORT`，默认固定为 `18611`；不存在对外监听的路径。
2. **每个 `/v1/*` 都要密钥。** 路由以显式表声明（`engine/server.ts` 的 `ROUTES`）：每行
   写明方法、路径、是否 `auth` 和处理函数；`route()` 在进入任何 handler 前统一调用
   `authorize()`（解析 `Authorization: Bearer` 并与 `engine.key` 做 `timingSafeEqual`，失败回
   401 `engine_key_invalid`）。新增端点 = 加一行，是否免鉴权是表里的一个显式决定，
   `test/engine-http.test.ts` 会核对「免鉴权的只有 health 和登录进度页」。
3. **账号数据只有当前用户能读。** 数据目录 `0700`，`engine.key`、`accounts.json`、`engine.log`
   都是 `0600`（Windows 用当前用户目录的 ACL）；写入走临时文件 + 重命名的原子替换。
4. **日志和错误体脱敏。** `redact()` 覆盖 `Bearer …`、URL 里的 `key=` / `token=` /
   `access_token=` / `refresh_token=` / `api_key=` 查询参数以及 `hatch_*` cookie；对话正文和
   cookie 不写日志。
5. **DevTools 端口不对网页开放。** 引擎浏览器只带 `--remote-debugging-address=127.0.0.1` 与随机
   `--remote-debugging-port`，**不带** `--remote-allow-origins=*`。浏览器默认拒绝带 `Origin` 头的
   DevTools WebSocket 握手，所以账号资料目录里加载的任何网页都连不上 CDP；引擎自己的客户端是不发
   `Origin` 的 WebSocket，仍然能连。`test/engine.test.ts` 守着这条参数，`test/bundled.test.ts`
   在真实浏览器上跑通整条链路。
6. **请求体有上限，读请求有时间上限。** `readBody()` 在 `MAX_REQUEST_BODY`（8 MB）处停下并把超限
   映射成 413 `request_too_large`；`createServer()` 由 `newHTTPServer()` 一处构造，设了
   `headersTimeout` / `requestTimeout`（30 秒，头与体一起计时）和 `maxHeaderSize`（32 KB），没有
   响应超时（会截断 SSE 流）。读超时让一个只慢慢滴字节、迟迟不结束的请求无法长期占住进程——
   本机任何用户都能连上端口，未带密钥的请求在读到正文之前就被拒，但连接本身仍可能被拖住，
   这条给它一个截止时间。`test/engine-http.test.ts` 的
   `the listener bounds a request but never a streaming answer` 守住这些上限。
7. **响应不可被猜测和缓存。** 所有响应都带 `x-content-type-options: nosniff`，没有自己指定
   `cache-control` 的响应默认 `no-store`（SSE 流保留 `no-cache`）。
8. **登录进度页是最小权限的静态页。** `/login/<id>` 用 `engine/login-page.ts` 的 `escapeHTML()`
   转义，只带随机登录 ID，
   不显示 cookie；响应头带 `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; …`、
   `x-frame-options: DENY`、`referrer-policy: no-referrer`、`cache-control: no-store`。
9. **下载与解压都不信输入。** 指纹浏览器下载固定版本并校验 sha256，失败就回退或报错，不会安装
   未校验的文件；`engine/fingerprint.ts` 的内置 zip 读取器拒绝 `..` 和绝对路径条目。
10. **不复用日常浏览器资料。** 登录窗口用临时资料目录，登录完成后删除；引擎浏览器各自独立，
    也不读写 Donut Browser 自己的账号数据。
11. **端口先证明身份，才拿得到密钥。** `/v1/health` 仍然免鉴权（插件必须先问“在不在、哪个版本”），
    但调用方可以带 `x-muse-challenge: <nonce>`，引擎回 `proof = hex(HMAC-SHA256(engine.key,
    "muse-web-health:" + nonce))`。插件只有在 `proof` 与本地算出的值常量时间相等时，才会把
    `engine.key` 或账号句柄发给该端口；证明不了的端口一律不发。于是端口被抢先占用、或升级后仍在
    运行的旧引擎，都拿不到 `engine.key`。引擎（`engine/server.ts`）、插件与 connector 三处共用
    `engine/health.ts` 的 `healthProof`，`test/engine-store.test.ts` 与 `test/engine-identity.test.ts`
    用同一组固定向量守住这条；设计见
    [`docs/adr/0004-health-challenge.md`](docs/adr/0004-health-challenge.md)。
12. **Host 头只接受回环名。** `engine/server.ts` 的 `handle()` 在路由之前检查 `Host`：只有 `127.0.0.1`、`localhost`、
    `[::1]` / `::1` 和 `0.0.0.0`（可带端口）被接受，其它一律 403 `host_not_allowed`。DNS
    rebinding 的页面到达端口时仍带着自己的域名，这条检查让未来任何免鉴权 GET（health、登录
    进度页）都不会变成网页可读的答案。`test/engine-http.test.ts` 的
    `the Host header must name this machine` 守住这条。
13. **凭据只在回环或 https 上传输。** `engine.key` 和账号句柄是凭据。插件指向一个外部引擎
    （`MUSE_WEB_ENGINE` / `engine` 选项）时，`engine/local-fetch.ts` 的 `credentialSafeUrl()` 只在
    目标是本机回环地址或 `https:` 时才允许发送它们；一个明文 http 的局域网 / 域名地址——无论是
    有人手输进环境变量，还是某个 Agent 的环境带进来的——都会被直接拒绝，插件在探测前就返回
    「引擎连不上」并说明必须用 https 或 127.0.0.1，连接根本不会建立。`test/engine-origin.test.ts`
    钉住允许与拒绝的集合，以及「被拒的地址一字节密钥都收不到」。
14. **`/v1/health` 只回答最少的信息。** 这是免鉴权端点，任何本机用户都能问，所以它只说「引擎在、
    哪个版本」，不再返回账号数（账号数在密钥之后的 `/v1/accounts`）。`test/engine-http.test.ts`
    的 `health stays thin: it names the engine, not the accounts behind the key` 守住这条。
15. **一行一条日志，谁都伪造不了。** `engine/log.ts` 的 `Logger.log()` 是写 `engine.log`
    的唯一出口，每条记录先过 `oneLine()`：`\r`、`\n`、`\t`、其余 C0 控制字符、DEL 以及
    U+2028 / U+2029 一律换成空格，单条上限 2048 字节。请求路径写进日志时是百分号解码后的样子，
    所以一个**不带密钥**的本机请求原本可以用 `%0A` 往 `engine.log` 里接一条
    「200 GET /v1/accounts account=…」——读日志的人分不出真假。现在客户端给的路径、驱动来的消息、
    子进程 stderr 都不可能多出一行。驱动 stderr 的 `lineWriter` 同时把「还没等到换行」的缓冲限制在
    64 KB，一个只写不换行的子进程不再能把引擎内存拖大。`test/engine-http.test.ts` 的
    `one unauthenticated request writes one log record` 与 `test/engine-log.test.ts` 用免鉴权请求
    钉住这条。设计见
    [`docs/adr/0007-log-integrity.md`](docs/adr/0007-log-integrity.md)。
16. **免鉴权的那一面不做活，整面都有固定的在飞上限。** `GET /login/{id}` 是唯一一个人（不是插件）
    不带密钥就会打开的端点，所以它也是最便宜的攻击面。（1）登录 ID 在路由的匹配器里就按
    `login_start` 发出去的形状校验（8–32 个 `[A-Za-z0-9_-]`），编出来的路径是普通 404，进不了
    处理函数；（2）没有驱动在跑时，页面直接用 `driver.Running()` 回答「找不到这次登录」，不碰
    `ensure()`——原本一个乱填 ID 的 GET 就能让引擎拉起一个浏览器驱动进程，还给每次请求注册一个
    约 100 KB 的驱动事件通道；（3）每个非 health 的路由都要先取一个在飞令牌：免鉴权面 4 个、
    持密钥面 64 个，满了直接 503 `engine_busy`（`Retry-After: 1`）而不是排队。**鉴权在取令牌
    之前**，所以刷错密钥只能花常数时间、拿不到令牌，挤不掉真正持钥的调用；`/v1/health` 豁免，
    因为在飞的引擎不能被答成「引擎不在」。`test/engine-http.test.ts` 把这几条都钉住：页面
    GET 之后标记文件不存在、同一运行时下带密钥的 `POST /v1/login` 之后存在，两个预算各自打满
    与释放，以及错密钥不占令牌。设计见
    [`docs/adr/0008-admission-control.md`](docs/adr/0008-admission-control.md)。
17. **手填的浏览器路径必须是绝对路径的普通文件。** 登录前「手动填写浏览器路径…」是一处
    「照人一句话就启动某个可执行文件」的地方，所以路径的形状要先被校验：`engine/browser.ts`
    的 `browserPathProblem()` 要求绝对路径、`statSync` 能读到、并且 `isFile()` 为真，否则
    带着原因被拒绝。插件（`index.ts` 的 `browserLogin()`）在开始登录前就报清楚，引擎
    （`engine/login.ts` 的 `Logins.start()`）在真正启动前再否决一次——两边用同一份实现，
    因为最终启动的是引擎。相对路径会被解析到引擎自己的工作目录，等于把 `chrome.exe`
    变成「引擎目录下任意同名程序」；目录和设备会在启动里晚一步失败。粘贴带来的成对引号
    与首尾空白先由 `normalizeBrowserPath()` 去掉，不成对的引号保持原样、照旧被拒。测试见
    `test/browser-path.test.ts` 与 `contract.test.ts`。设计见
    [`docs/adr/0009-typed-browser-path.md`](docs/adr/0009-typed-browser-path.md)。
    同一条规则同样适用于 `MUSE_WEB_CHROME`：它点名的就是引擎要启动的程序，所以
    `findBrowser()` 与登录选项 `browserOptions()` 复用 `browserPathProblem()`，相对路径、
    目录、不存在的文件一律按未设置处理（而不是退回自动扫描），驱动在 `engine.log` 里
    说明原因。
18. **配置的站点遵循凭据的传输规则。** `MUSE_WEB_SITE` 决定 muse.ai 会话 cookie 发到哪个源：
    浏览器每次加载页面都带着它，`muse.ts` 的每个 API 调用都把它发给同一个源。会话 cookie 是
    凭据，所以它跟 `engine.key` 走同一条规则（ADR 0006）：明文 http 只能到本机回环，其他地方
    必须 https。`engine/site.ts` 的 `siteProblem()` 是唯一的判断，插件在拉起引擎之前调用
    （`index.ts` 的 `ensureEngine()`），引擎驱动在启动时调用一次（`engine/driver.ts`），
    未修正之前只回答原因、不做任何工作（包括不下载指纹浏览器），只有两个停止操作例外——
    让引擎能被干净地关掉。镜像站照旧可以指向回环（`http://127.0.0.1:3000`），真实站点默认
    不需要配置。测试见 `test/site.test.ts`。设计见
    [`docs/adr/0010-configured-site-transport.md`](docs/adr/0010-configured-site-transport.md)。
19. **发布包的文件名只取最后一段。** 指纹浏览器的下载地址和文件名来自远端（GitHub Release
    API 的 `name` 字段），而这个名字决定 `<data>/browsers/apostate/download` 下真正写盘的
    文件名。`engine/fingerprint.ts` 的 `releaseFileName()` 只保留最后一段路径、去掉前导点、
    把其余字符压成安全集合：绝对路径、盘符和 `..` 段都进不了文件名，后缀保留（`extractArchive()`
    靠它判断压缩格式）。名字里没有可用的一段时退回下载地址自己的文件名，再不行才用 `download`。
    这和 `extractZip()` 对压缩包条目用的 `safeJoin()` 是同一条规则，只是对象换成了下载文件
    本身。名字被改写后不再与固定版本的 sha256 对应，所以这次下载必须自带 `.manifest.json`
    的哈希，否则校验不过、退回系统 Chromium。测试见 `test/fingerprint.test.ts`。设计见
    [`docs/adr/0011-release-file-name.md`](docs/adr/0011-release-file-name.md)。
20. **代理里的凭据不进子进程命令行。** 代理地址可能带 `user:password@`，而
    `--proxy-server=<整条 URL>` 是浏览器进程的参数：在 macOS 和 Linux 上，任何本机用户都能用
    `ps` 读到别人的命令行。Chrome 解析这个参数时只取 scheme、host、port，用户名密码本来就会
    被丢掉——所以它们出现在那里只有坏处。`engine/net.ts` 的 `proxyForBrowser()` 在拼参数前
    去掉 userinfo（保留 scheme://host:port，其他 scheme 原样通过，交给浏览器报错）；引擎自己的
    请求照旧用完整的 URL（`proxiedFetch`），需要认证的代理仍然可用。`proxyHasCredentials()`
    让驱动在启动日志里说明一次，免得有人以为浏览器也在用那组凭据。测试见
    `test/engine.test.ts`。设计见 [`docs/adr/0012-proxy-credentials-off-argv.md`](docs/adr/0012-proxy-credentials-off-argv.md)。
21. **远端响应体有上限，归档边到边写盘。** 安装指纹浏览器时读的三样东西——GitHub 的发布
    文档、发布包的 `.manifest.json`、以及浏览器压缩包本身——大小都由远端决定。原本 JSON 走
    `res.json()`、压缩包走 `Buffer.from(await res.arrayBuffer())`，一个永不结束或坏掉的响应
    因此能把内存（以及写盘后的磁盘）撑爆，而且失败发生在活儿干完之后。现在
    `engine/fingerprint.ts` 的 `readBounded()` 在带流时边读边计数、刚过上限就 `cancel()` 读取器
    （真实 `fetch` 响应都有流），没有流时才整段读回再测量；`MAX_ARCHIVE_BYTES`（512 MiB）与
    `MAX_JSON_BYTES`（1 MiB）是两个唯一的界限，`declaredLength()` 先看 `content-length`，声明的
    大小超限时在分配内存或打开文件之前就被拒。`downloadTo()` 打开 `0600` 的文件、逐块
    `writeSync`，内存不再随压缩包大小增长，一个只滴字节的响应变成带原因的拒绝而不是占满磁盘。
    测试见 `test/fingerprint.test.ts`。设计见
    [`docs/adr/0013-bounded-downloads.md`](docs/adr/0013-bounded-downloads.md)。
22. **解压出来的大小也有上限。** 上一道界限管的是下载到的字节数，不是它解开后的大小：
    `extractZip()` 原本用 `inflateRawSync(comp)` 逐个条目解压，`.tar.zst` 用
    `zstdDecompressSync()`，系统 `tar` 则是没有任何上限的子进程。一个 512 MiB 的全零压缩包
    能解出几百 GB——内置读取器会在写盘之前把每一个字节都拿在内存里，tar 路径则一直写到卷满。
    现在 `engine/fingerprint.ts` 新增 `MAX_EXTRACT_BYTES`（2 GiB，真实 Chromium 远小于此）与
    `MAX_ARCHIVE_ENTRIES`（100,000）两个唯一的界限：`extractZip()` 一边写一边累计，stored
    条目超过剩余预算直接拒绝，deflated 条目把剩余预算作为 `maxOutputLength` 交给
    `inflateRawSync`（zlib 的 `ERR_BUFFER_TOO_LARGE` 转成同一条「超过上限」的原因），中央目录
    声称的条目数超限时在循环开始前就被拒；`zstdDecompressSync` 同样带 `maxOutputLength`，解不
    下时连中间的 `.tar` 都不会写出来。系统 `tar` 没有可传的上限，所以 `treeBytes()` 在解压
    完成后统计实际产物，超预算就报失败，调用方原有的清理会丢掉整个 staging 目录。测试见
    `test/fingerprint.test.ts`。设计见
    [`docs/adr/0014-bounded-extraction.md`](docs/adr/0014-bounded-extraction.md)。
23. **调试端口由浏览器自己选。** 原来 `freePort()` 先绑一个 `127.0.0.1:0`、拿到端口、关掉
    监听，再把这个号码交给浏览器；在这两步之间，本机任何进程都能先绑上同一个端口，回答引擎
    的 `/json/version` 探测，并拿到一条带着账号 cookie 的 CDP 连接——这条连接本身就是凭据，
    没有 `engine.key` 那样的挑战可以自证。现在 `launchBrowser()` 传
    `--remote-debugging-port=0`，由浏览器自己挑端口并在监听就绪后写进
    `<profileDir>/DevToolsActivePort`，引擎只读这个文件：`readActivePort()` 拒绝超过 4096 字节
    的文件、不在 `1..65535` 的首行、以及第二行不以 `/devtools/browser/` 开头的文件；
    启动前先删掉 profile 里遗留的旧文件，避免把上一轮浏览器的端口当成这一轮的答案；
    `debuggerUrl()` 还要求 `/json/version` 回的地址是 `ws:`/`wss:`、端口与文件一致、主机是
    回环（`127.0.0.1`、`::1`、`localhost`）、路径在 `/devtools/browser/` 下，否则继续等。
    登录页要导航的那个标签页走同一条规则：`pageUrl()` 只接受端口一致、主机回环、路径在
    `/devtools/page/` 下的地址，`chatTarget()` 因此只连这个浏览器自己的页面（同站标签页优先）；
    端口在登录期间被别的进程接手时，一个页面都不连，登录只留一条说明，不会把 CDP 会话交出去。
    测试见 `test/browser-recovery.test.ts`、`test/login-target.test.ts`。设计见
    [`docs/adr/0015-browser-chosen-debug-port.md`](docs/adr/0015-browser-chosen-debug-port.md)。

## 已知残留风险

这些是有意的取舍，或是还没做的工作，记录在这里而不是藏着：

- **同用户进程**可以读 `engine.key` 和 `accounts.json`，也可以连上引擎端口。跨用户保护依赖操作系统
  权限，插件不额外加密本地账号文件。
- **无法证明身份的旧引擎要人工处理。** 端口被一个不能证明持有 `engine.key` 的进程占用时（典型是
  升级后仍在运行的旧版引擎），插件既不 spawn、也不发密钥，直接报“端口被占用”，提示重启 Magpie
  或结束占用端口的进程。重启 Magpie 会由 parent-PID watchdog 结束旧引擎；旧引擎也会在 60 分钟
  空闲后自行退出。
- **上游错误文本**可能包含普通字样（不是 cookie），脱敏只覆盖已知的凭据形状。
- **muse.ai 改版**导致的页面选择器失效属于兼容性问题，不是安全漏洞；这类情况按普通 bug 报告。

## 支持范围

只有本仓库默认分支的最新代码和最近一次发布版本会收到安全修复。历史版本请升级后再确认问题是否
仍然存在。

---

## English

A short English summary of the same model. The engine listens on `127.0.0.1` only, requires the
`engine.key` bearer on every `/v1/*` endpoint (constant-time compare), keeps its data directory at
`0700` with `0600` files and atomic writes, redacts credentials from logs and error bodies, caps
request bodies at 8 MB, sends `x-content-type-options: nosniff` plus `no-store` on answers, serves
the sign-in progress page with escaping and a strict CSP, verifies downloaded browsers by sha256,
and launches its browser without `--remote-allow-origins=*`, so a page inside the engine profile
cannot drive CDP. `/v1/health` stays unauthenticated so the plugin can ask "is an engine up, and
which version?", but a caller may send a nonce and the engine answers with an HMAC proof; the plugin
only ever sends `engine.key` to a port that proves it holds the key, so a squatter or a
pre-upgrade engine is never handed the key. Known limits: same-user processes are trusted by
design, and upstream error text may still contain ordinary strings. Please report issues without
cookies, `engine.key`, or unscrubbed logs.
The Host header must address 127.0.0.1 or localhost; anything else gets 403 `host_not_allowed`
before routing, so DNS-rebound pages cannot read even the unauthenticated answers.
Credentials (`engine.key` and account handles) ride the wire only to loopback or over `https:`: a
plugin pointed at a named engine on a plain-http address other than this machine refuses to send
them and reports the transport rule instead. `/v1/health` says only that an engine is up and its
version — not how many accounts live behind the key — and the listener sets a request `ReadTimeout`
so a trickling body cannot pin the process.
`engine.log` holds one record per line: every record passes `oneLine()` (control characters and
newlines become spaces, one record is capped at 2048 bytes) before it is written, so a request path
— which is logged percent-decoded — cannot add a record of its own, and the driver's stderr buffer
is capped at 64 KB so a child that never sends a newline cannot grow it without limit.
The one route a person opens without a key — the sign-in progress page — does no work: the login id
must have the shape `login_start` hands out or the answer is a plain 404, and with no driver running
the page reports an unknown sign-in instead of starting a process. Every other route runs under a
fixed in-flight budget (4 for the unauthenticated surface, 64 for keyed requests) and answers
`503 engine_busy` with `Retry-After: 1` when it is spent; authorization is checked first, so a
caller guessing keys holds no budget, and `/v1/health` is exempt so a busy engine never looks dead.
