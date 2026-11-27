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

1. **只监听回环。** `engine-go/main.go` 用 `net.Listen("tcp4", "127.0.0.1:<port>")`，端口来自
   `MUSE_WEB_ENGINE_PORT`，默认固定为 `18611`；不存在对外监听的路径。
2. **每个 `/v1/*` 都要密钥。** `engine-go/server.go` 的 `authorize()` 解析 `Authorization: Bearer`
   并与 `engine.key` 做 `subtle.ConstantTimeCompare`，失败回 401 `engine_key_invalid`。
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
6. **请求体有上限，头部有时间上限。** `readBody` 用 `http.MaxBytesReader`（8 MB）并把超限映射成
   413 `request_too_large`；`http.Server` 设了 `ReadHeaderTimeout` 与 `MaxHeaderBytes`。
7. **响应不可被猜测和缓存。** 所有响应都带 `x-content-type-options: nosniff`，没有自己指定
   `cache-control` 的响应默认 `no-store`（SSE 流保留 `no-cache`）。
8. **登录进度页是最小权限的静态页。** `/login/<id>` 用 `html/template` 转义，只带随机登录 ID，
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
    运行的旧引擎，都拿不到 `engine.key`。Go 的 `healthProof` 与 `engine/health.ts` 逐字节一致，
    `engine-go/health_test.go` 与 `test/engine-identity.test.ts` 守住这条；设计见
    [`docs/adr/0004-health-challenge.md`](docs/adr/0004-health-challenge.md)。

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
