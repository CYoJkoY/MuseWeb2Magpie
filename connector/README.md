<p align="center"><img src="icon.svg" width="72" height="72" alt=""></p>

<h1 align="center">MuseWeb2Magpie Connector</h1>

<p align="center">
  把 <a href="https://muse.ai">muse.ai</a> 接进 <a href="https://github.com/yetone/magpie">Magpie</a> 的
  <b>connector 版</b>：它不启动浏览器、不读 cookie、不 spawn 进程，只连接你自己运行的
  <code>muse-web</code> 引擎。
</p>

<p align="center">
  包名：<code>magpie-muse-web-connector</code> · Provider id：<code>muse-web</code> · 模型：<code>muse-web/muse-spark</code> · 引擎需另行运行 · MIT
</p>

---

## 和完整版怎么选

| | 本 connector | [MuseWeb2Magpie](https://github.com/CYoJkoY/MuseWeb2Magpie) 完整版 |
|---|---|---|
| 引擎 | 你另行运行 | 插件自带，随 Magpie 启停 |
| 浏览器 | 引擎打开 | 引擎打开 |
| 读 cookie | 不读；cookie 在引擎自己的数据目录 | 引擎通过 CDP 读取并保存 |
| 启动进程 | 不启动 | 启动引擎和 Chrome |
| 安装 | npm 包 + 一个运行中的引擎 | 一个 npm 包，开箱即用 |
| 适合 | 想在服务器/多 Magpie 实例间共享一个引擎；社区市场收录 | 只想在 Magpie 里点一下就用 |

两者使用同一个 provider id `muse-web`，**不要同时安装**。

## 先运行引擎

引擎在完整版的仓库里，和完整版是同一份代码：

```sh
git clone https://github.com/CYoJkoY/MuseWeb2Magpie.git
cd MuseWeb2Magpie
npm install
node engine/main.ts
```

引擎是 TypeScript，用 Node.js（`>=22.18`，默认能从 `.ts` 里剥掉类型标注）直接运行 `engine/main.ts`，不需要构建或另装二进制；引擎用同一个运行时加载 `engine/driver.ts` 操作浏览器。启动后它会打印监听地址和数据目录。默认：

```text
http://127.0.0.1:18611
```

`engine.key` 在数据目录里：

| 系统 | 文件 |
|---|---|
| macOS | `~/Library/Application Support/muse-web/engine.key` |
| Windows | `%APPDATA%\muse-web\engine.key` |
| Linux | `$XDG_DATA_HOME/muse-web/engine.key`，默认 `~/.local/share/muse-web/engine.key` |

## 安装和配置

```sh
magpie plugin add magpie-muse-web-connector

export MUSE_WEB_ENGINE=http://127.0.0.1:18611
export MUSE_WEB_ENGINE_KEY="$(cat "$HOME/Library/Application Support/muse-web/engine.key")"   # macOS
# Linux:   "$(cat "$HOME/.local/share/muse-web/engine.key")"
# Windows: 从 %APPDATA%\muse-web\engine.key 读取

magpie plugin login muse-web
```

也可以在 Magpie 的插件选项里设置 `engine` 和 `key`，它们的优先级高于环境变量。

`MUSE_WEB_ENGINE` 指向别的机器时必须是 `https` 地址：`engine.key` 和账号句柄是凭据，明文 http
的局域网 / 域名地址会被直接拒绝，连接都不会建立。`127.0.0.1` 的回环地址不受影响。引擎还要能对
`/v1/health` 的挑战作出自证（旧版引擎升级后才能通过），证明不了的端口拿不到密钥。

## 两种登录方式

1. **在已运行的引擎里登录 muse.ai**：connector 调用引擎的 `POST /v1/login`，引擎打开一个浏览器窗口；
   你在窗口里登录，引擎验证账号能回答后把账号 ID 返回给 Magpie。connector 自己不打开浏览器、不读 cookie。
2. **引擎账号 ID**：引擎里已经有账号时，先列出来：

   ```sh
   curl -s -H "Authorization: Bearer $MUSE_WEB_ENGINE_KEY" \
     http://127.0.0.1:18611/v1/accounts
   ```

   把返回的 `id`（`muse-...`）粘贴到登录提示里。

## 它会做什么

- 每个账号在 Magpie 里是一个独立的 auth；Magpie 负责选号、换号、并发和额度卡片。
- 请求走 `POST /v1/chat/completions`，流式/非流式、工具调用、历史预算、`tool_choice` repair
  都由引擎负责，connector 只做转发。
- 会话 ID 通过 `x-muse-session` 传给引擎，`x-muse-account` 指定账号，`Authorization` 带 `engine.key`。
- 引擎返回 401/429/503 时，connector 把响应的 `x-magpie-sign-in` 和 `error.code` / `Retry-After` 原样交给 Magpie。

## 它不会做什么

- 不启动引擎，也不启动 Chrome/Edge/Chromium/Brave。
- 不读取 `accounts.json`、不读取 cookie，也不把 cookie 写进 Magpie。
- 引擎没运行时不会自动拉起；请求会返回“引擎没有响应”，先去启动引擎。
- 不提供图片输入、生图/生视频接口；这些能力仍由引擎和 muse.ai 网页决定。

## 排查

| 现象 | 处理 |
|---|---|
| `muse-web 引擎没有响应` | 先 `node engine/main.ts`（在完整版仓库里），确认 `MUSE_WEB_ENGINE` 地址和端口 |
| `引擎不可以用`（提到 https / 回环） | `MUSE_WEB_ENGINE` 必须是本机回环地址或 `https`，明文 http 的外部地址不再接受 |
| 反复提示引擎不响应、旧版引擎 | 连接的引擎须支持 `/v1/health` 的 HMAC 自证（完整版 0.11 起的引擎都支持），旧引擎请升级后重启 |
| `engine_key_invalid` / 401 | `MUSE_WEB_ENGINE_KEY` 与数据目录里的 `engine.key` 不一致 |
| `account_unknown` / `session_expired` | 账号 ID 过期或引擎里已移除，重新登录 |
| `account_busy` / `quota_spent` | 引擎返回的 429；Magpie 会换号或等重置 |
| 所有账号都不可用 | 在引擎里重新登录；引擎日志在数据目录的 `engine.log` |

## English

A connector edition of [MuseWeb2Magpie](https://github.com/CYoJkoY/MuseWeb2Magpie): it talks to a
`muse-web` engine you run yourself over loopback HTTP. It never starts a browser, never reads cookie files
and never spawns a process. Run the engine with `node engine/main.ts` from the full-edition repo
(Node.js `>=22.18` strips the types, and the same runtime loads `engine/driver.ts`), set `MUSE_WEB_ENGINE` and
`MUSE_WEB_ENGINE_KEY`, then `magpie plugin add magpie-muse-web-connector` and `magpie plugin login muse-web`.
Use the full edition if you want the bundled engine. Same provider id (`muse-web`), so install one, not both.
Credentials (`engine.key` and account handles) only travel to loopback or over `https:` — a
plain-http remote address is refused before a connection is opened — and the connector sends them
only to a port that proves it holds the key via the `/v1/health` HMAC challenge, so a squatter or a
pre-upgrade engine never receives them. Redirects are refused rather than followed.

## 致谢

页面操作、会话续期和额度解析来自 [muse2api](https://github.com/czg86389-hub/muse2api)（MIT）；
完整版和 connector 共享同一套引擎协议。许可证见 `LICENSE`。
