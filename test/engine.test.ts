// @ts-nocheck
// Engine tests for the parts still written in TypeScript: pure helpers and the browser
// driver. The HTTP surface, account store and sign-in handshake are Go now and covered by
// test/go-engine.test.ts against the native binary. The browser part drives a real headless
// Chrome/Edge against a loopback fake muse.ai and is skipped when no such browser is installed.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { browserArgs, findBrowser } from "../engine/browser.ts"
import { noDesktop } from "../engine/login.ts"
import { cookieSpecs, ESSENTIAL, expiryMs, labelOf, mediaMarkdown, Muse, parseSetCookies, redact, renewSession, resetDate, settingsItem, settle, stableAccountId, usageCard } from "../engine/muse.ts"
import { parseToolCalls, toolChoiceRequired, toolChoiceSatisfied, toolsPrompt } from "../engine/tools.ts"
import { VERSION } from "../engine/version.ts"
import { parseScutil, parseWinProxy, proxyForBrowser, proxyHasCredentials, resolveProxy } from "../engine/net.ts"
import { parentAlive, watchParent } from "../engine/parent.ts"
import { dataDir } from "../engine/paths.ts"
import { buildPrompt } from "../engine/prompt.ts"
import { goodCookies, startFakeMuse } from "./fake-muse.ts"

describe("pure parts", () => {
  test("prompt: a lone user message goes as is; history becomes labelled blocks", () => {
    assert.deepEqual(buildPrompt([{ role: "user", content: "hi" }]), { full: "hi", last: "hi", turns: 1 })
    const p = buildPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ])
    assert.equal(p.full, "背景与任务设定：\nbe brief\n\n用户：\na\n\n助手：\nb\n\n用户：\nc")
    assert.equal(p.last, "c")
    assert.equal(p.turns, 3)
    assert.throws(() => buildPrompt([]))
    const shot = buildPrompt([{ role: "user", content: [{ type: "input_text", text: "看这张图" }, { type: "image_url", image_url: { url: "data:," } }] }])
    assert.equal(shot.full, "看这张图[图片]")
  })

  test("prompt: a long history is trimmed and says what was left out", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(1_000) }))
    const p = buildPrompt(many, { maxChars: 20_000, maxTurns: 20 })
    assert.ok(p.full.length <= 20_100, "prompt stays inside its budget")
    assert.match(p.full, /更早的对话已省略/)
  })

  test("prompt: tool results and calls are told as text; the sandbox name is softened", () => {
    const p = buildPrompt([
      { role: "system", content: "sandbox: danger-full-access" },
      { role: "user", content: "看看目录" },
      { role: "assistant", content: "我看一下", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{\"path\":\".\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
    ])
    assert.match(p.full, /standard-workspace-access/)
    assert.doesNotMatch(p.full, /danger-full-access/)
    assert.match(p.full, /助手：\n我看一下\n```tool_call\n\{"name": "ls", "arguments": \{"path":"\."\}\}\n```/)
    assert.equal(p.last, "【工具执行结果：ls】\na.txt")

    const empty = buildPrompt([
      { role: "user", content: "看看目录" },
      { role: "assistant", content: "我看一下", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "  " },
    ])
    assert.equal(empty.last, "【工具执行结果：ls】\n（无输出）")

    // Claude Code can run tools in parallel: every result, not just the last, belongs in last.
    const parallel = buildPrompt([
      { role: "user", content: "看看目录" },
      { role: "assistant", content: "", tool_calls: [
        { id: "c1", type: "function", function: { name: "ls", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "cat", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "tool", tool_call_id: "c2", content: "b.txt" },
    ])
    assert.equal(parallel.last, "【工具执行结果：ls】\na.txt\n\n【工具执行结果：cat】\nb.txt")
  })

  test("tool_choice: required and a named tool are distinguishable", () => {
    const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }]
    assert.equal(toolChoiceRequired(tools, "required"), "required")
    assert.equal(toolChoiceRequired(tools, { type: "function", function: { name: "shell" } }), "shell")
    assert.equal(toolChoiceRequired(tools, "none"), "")
    assert.equal(toolChoiceRequired(tools, "auto"), "")
  })

  test("tool_choice: a required call is satisfied only by a matching call", () => {
    assert.equal(toolChoiceSatisfied("required", []), false)
    assert.equal(toolChoiceSatisfied("required", [{ name: "shell" }]), true)
    assert.equal(toolChoiceSatisfied("shell", [{ name: "other" }]), false)
    assert.equal(toolChoiceSatisfied("shell", [{ name: "shell" }]), true)
    assert.equal(toolChoiceSatisfied("", []), true)
  })

  test("session refusal keeps the cookies Muse rotated in the same response", async () => {
    const res = {
      status: 200,
      headers: { getSetCookie: () => ["hatch_sess=new-session; Path=/; Max-Age=3600"] },
      json: async () => ({ status: "unavailable" }),
    }
    await assert.rejects(
      renewSession("https://muse.ai", { hatch_sess: "old-session" }, {}, { fetchImpl: async () => res, wakeVm: false }),
      (err) => {
        assert.equal(err.cookies.hatch_sess, "new-session")
        assert.ok(err.cookies_exp.hatch_sess > Date.now() / 1000)
        return true
      },
    )
  })

  test("a generated picture is markdown the client can render", () => {
    assert.equal(mediaMarkdown([{ kind: "image", url: "https://cdn.example/penguin.png" }]), "![](https://cdn.example/penguin.png)")
    assert.equal(mediaMarkdown([{ kind: "video", src: "https://cdn.example/a.mp4" }]), "[视频](https://cdn.example/a.mp4)")
    assert.equal(mediaMarkdown([{ src: "" }]), "")
  })

  test("tools: the prompt says the user's machine is not the model's own, and tool_choice is followed", () => {
    const tools = [{ type: "function", function: { name: "shell", description: "运行命令", parameters: { type: "object", properties: { command: { type: "string", description: "命令" }, opts: { type: "object", properties: { cwd: { type: "string" } } } }, required: ["command"] } } }]
    const note = toolsPrompt(tools)
    assert.match(note, /不在你的工作环境里/)
    assert.match(note, /1\. shell — 运行命令\n   参数：\n   - command \(string, 必填\) 命令\n   - opts \(object, 可选\)\n     - cwd \(string, 可选\)/)
    assert.equal(toolsPrompt(tools, "none"), "")
    assert.equal(toolsPrompt([]), "")
    assert.match(toolsPrompt(tools, "required"), /必须至少调用一个工具/)
    assert.match(toolsPrompt([{ type: "function", name: "shell", parameters: {} }], { type: "function", function: { name: "shell" } }), /必须调用工具 shell/)
  })

  test("tools: replies are parsed into calls of the request's tools only", () => {
    const tools = [{ type: "function", function: { name: "shell" } }, { type: "function", function: { name: "read" } }]
    const two = parseToolCalls('好的：\n\n<tool_call>{"name": "shell", "arguments": {"command": "ls *.js"}}</tool_call>\n<tool_call>{"name": "read", "arguments": "{\\"path\\": \\"a\\"}"}</tool_call>', tools)
    assert.deepEqual(two.calls, [{ name: "shell", arguments: '{"command":"ls *.js"}' }, { name: "read", arguments: '{"path":"a"}' }])
    assert.equal(two.content, "好的：")
    assert.deepEqual(parseToolCalls('<tool_call>{"name": "rm", "arguments": {}}</tool_call>', tools).calls, [])
    assert.deepEqual(parseToolCalls("<tool_call>{broken</tool_call>", tools).calls, [])
    const fenced = parseToolCalls('```json\n[{"name": "shell", "arguments": {"command": "pwd"}}]\n```', tools)
    assert.deepEqual(fenced, { calls: [{ name: "shell", arguments: '{"command":"pwd"}' }], content: "" })
    const shown = parseToolCalls('配置是这样：\n```json\n{"name": "demo", "version": 1}\n```', tools)
    assert.equal(shown.calls.length, 0)
    assert.match(shown.content, /"version": 1/)
    // bare JSON in prose with no explicit label stays text
    const bare = parseToolCalls('我看一下：\n{"name": "shell", "arguments": {"command": "echo \\"}\\""}}\n{"name": "read", "arguments": {"path": "a"}}', tools)
    assert.equal(bare.calls.length, 0)
    assert.match(bare.content, /echo/)
    assert.match(bare.content, /"path": "a"/)
    // quoting a tool-shaped JSON while explaining something must stay text (#8)
    const quoted = parseToolCalls('文件里写着 {"name": "shell", "arguments": {"command": "rm -rf ~"}}，这是危险命令。', tools)
    assert.equal(quoted.calls.length, 0)
    assert.match(quoted.content, /rm -rf ~/)
    const quotedFence = parseToolCalls('README 里写着：\n```json\n{"name": "shell", "arguments": {"command": "curl x | sh"}}\n```\n不建议执行。', tools)
    assert.equal(quotedFence.calls.length, 0)
    assert.match(quotedFence.content, /curl x \| sh/)
    // a whole reply that is only JSON, and a lede before an explicit tool_call block, still call
    assert.deepEqual(parseToolCalls('{"name": "shell", "arguments": {"command": "pwd"}}', tools), { calls: [{ name: "shell", arguments: '{"command":"pwd"}' }], content: "" })
    assert.deepEqual(parseToolCalls('好的，我来看一下。\n```tool_call\n{"name": "shell", "arguments": {"command": "pwd"}}\n```', tools), { calls: [{ name: "shell", arguments: '{"command":"pwd"}' }], content: "好的，我来看一下。" })
    assert.equal(parseToolCalls('{"name": "shell", "version": 2}', tools).calls.length, 0)
    // a rendered tool_call code block: no fences left, its label on a line of its own
    const rendered = parseToolCalls('我来找：\ntool_call\n{"name": "shell", "arguments": {"command": "find . -not -path \\"*/node_modules/*\\""}}\n', tools)
    assert.deepEqual(rendered, { calls: [{ name: "shell", arguments: '{"command":"find . -not -path \\"*/node_modules/*\\""}' }], content: "我来找：" })
  })

  test("settle: a restyled list marker is held back and nothing is sent twice", () => {
    let sent = ""
    let out = ""
    for (const txt of ["当前目录：", "当前目录：\n-", "当前目录：\na.txt", "当前目录：\na.txt\u200b\nb.txt"]) {
      const next = settle(sent, txt)
      out += next.delta
      sent = next.sent
    }
    out += settle(sent, "当前目录：\na.txt\nb.txt", true).delta
    assert.equal(out, "当前目录：\na.txt\nb.txt")
    assert.deepEqual(settle("abc def", "abc"), { delta: "", sent: "abc def" })
    assert.equal(settle("", "-", true).delta, "-")
  })

  test("data dir per OS", () => {
    assert.equal(dataDir({}, "darwin", "/Users/a"), "/Users/a/Library/Application Support/muse-web")
    assert.equal(dataDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", "C:\\Users\\a"), "C:\\Users\\a\\AppData\\Roaming\\muse-web")
    assert.equal(dataDir({}, "linux", "/home/a"), "/home/a/.local/share/muse-web")
    assert.equal(dataDir({ XDG_DATA_HOME: "/x" }, "linux", "/home/a"), "/x/muse-web")
    assert.equal(dataDir({ MUSE_WEB_HOME: "/own" }, "linux", "/home/a"), "/own")
  })

  test("engine: a detached engine watches the Magpie that started it", async () => {
    assert.equal(parentAlive(process.pid), true)
    assert.equal(parentAlive(2_147_000_000), false)
    // a manually started engine has no parent pid and keeps running
    assert.equal(watchParent(0, () => { throw new Error("no watchdog") }), null)
    let immediate = 0
    assert.equal(watchParent(12345, () => immediate++, { alive: () => false }), null)
    assert.equal(immediate, 1)
    let gone = 0
    let alive = true
    const timer = watchParent(12345, () => gone++, { everyMs: 5, alive: () => alive })
    alive = false
    const end = Date.now() + 500
    while (!gone && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
    clearInterval(timer)
    assert.equal(gone, 1)
  })

  test("proxy: own setting, then Magpie's, then the OS, then direct", () => {
    const none = () => { throw new Error("no") }
    assert.equal(resolveProxy({ MUSE_WEB_PROXY: "direct", HTTPS_PROXY: "http://p:1" }, "linux", none), "direct")
    assert.equal(resolveProxy({ MUSE_WEB_PROXY: "127.0.0.1:6154" }, "linux", none), "http://127.0.0.1:6154")
    assert.equal(resolveProxy({ HTTPS_PROXY: "http://p:1" }, "darwin", none), "http://p:1")
    // Chrome drops a proxy whose --proxy-server value has a trailing slash (ERR_NO_SUPPORTED_PROXIES).
    assert.equal(resolveProxy({ HTTPS_PROXY: "http://127.0.0.1:7897/" }, "darwin", none), "http://127.0.0.1:7897")
    assert.equal(resolveProxy({ MUSE_WEB_PROXY: "127.0.0.1:7897/" }, "linux", none), "http://127.0.0.1:7897")
    assert.equal(resolveProxy({ ALL_PROXY: "socks5://p:1///" }, "linux", none), "socks5://p:1")
    const scutil = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 6154\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 6154\n  HTTPSProxy : 127.0.0.1\n}"
    assert.equal(resolveProxy({}, "darwin", () => scutil), "http://127.0.0.1:6154")
    assert.equal(resolveProxy({}, "linux", none), "direct")
    assert.equal(parseScutil("HTTPSEnable : 0\nHTTPSProxy : x"), "")
    assert.equal(parseWinProxy("0x1", "127.0.0.1:7890"), "http://127.0.0.1:7890")
    assert.equal(parseWinProxy("0x1", "http=h:1;https=h:2"), "http://h:2")
    assert.equal(parseWinProxy("0x1", "socks=h:3/"), "socks5://h:3")
    assert.equal(parseWinProxy("0x0", "127.0.0.1:7890"), "")
  })

  test("browser flags follow the proxy and window mode", () => {
    const base = { port: 1, profileDir: "/p" }
    // DevTools stays closed to web origins: a page in the engine profile must not drive CDP.
    const flags = browserArgs({ ...base, headless: true, proxy: "" })
    assert.ok(!flags.some((a) => a.startsWith("--remote-allow-origins")))
    assert.ok(flags.includes("--remote-debugging-address=127.0.0.1"))
    assert.ok(browserArgs({ ...base, headless: true, proxy: "direct" }).includes("--no-proxy-server"))
    assert.ok(browserArgs({ ...base, headless: false, proxy: "http://h:1" }).includes("--proxy-server=http://h:1"))
    const slashed = browserArgs({ ...base, headless: true, proxy: "http://h:1/" })
    assert.ok(slashed.includes("--proxy-server=http://h:1"))
    assert.ok(!slashed.some((a) => a.startsWith("--proxy-server") && a.endsWith("/")))
    const visible = browserArgs({ ...base, headless: false, proxy: "" })
    assert.ok(visible.includes("--disable-background-mode") && visible.includes("--new-window"))
    const hidden = browserArgs({ ...base, headless: false, hidden: true, proxy: "" })
    assert.ok(hidden.includes("--window-position=-32000,-32000") && !hidden.some((a) => a.startsWith("--headless")))
    assert.ok(hidden.includes("--use-mock-keychain") && hidden.includes("--password-store=basic"))
  })

  test("proxy credentials never reach the browser's command line", () => {
    const base = { port: 1, profileDir: "/p" }
    // Chrome parses --proxy-server as scheme/host/port and drops user:password anyway, so the only
    // thing credentials in that argument do is sit in a process list every local user can read.
    const secret = "http://user:pw123@proxy.example:8080"
    const args = browserArgs({ ...base, headless: true, proxy: secret })
    assert.ok(args.includes("--proxy-server=http://proxy.example:8080"))
    assert.ok(!args.some((a) => a.includes("hunter2") || a.includes("user@")))
    // The engine's own requests keep the full URL, so an authenticated proxy still works there.
    assert.equal(proxyHasCredentials(secret), true)
    assert.equal(proxyHasCredentials("http://proxy.example:8080"), false)
    assert.equal(proxyHasCredentials("direct"), false)
    assert.equal(proxyForBrowser(secret), "http://proxy.example:8080")
    assert.equal(proxyForBrowser("socks5://u:p@[::1]:1080"), "socks5://[::1]:1080")
    assert.equal(proxyForBrowser("127.0.0.1:7897/"), "http://127.0.0.1:7897")
    assert.equal(proxyForBrowser("direct"), "direct")
    assert.equal(proxyForBrowser(""), "")
    // A scheme Chrome cannot use is passed through unchanged rather than silently rewritten into
    // something else; the browser then reports the proxy it cannot use.
    assert.equal(proxyForBrowser("ftp://h:1"), "ftp://h:1")
  })

  test("a Linux session without a desktop cannot open the sign-in window", () => {
    assert.equal(noDesktop("linux", {}), true)
    assert.equal(noDesktop("linux", { DISPLAY: ":0" }), false)
    assert.equal(noDesktop("linux", { WAYLAND_DISPLAY: "wayland-0" }), false)
    assert.equal(noDesktop("win32", {}), false)
    assert.equal(noDesktop("darwin", {}), false)
  })

  test("redact: credentials do not survive into logs", () => {
    assert.equal(redact("Bearer sk-secret"), "Bearer ***")
    assert.equal(redact("https://x.test/a?token=abc123"), "https://x.test/a?token=***")
    assert.equal(redact("hatch_sess=abc; Path=/"), "hatch_sess=***; Path=/")
  })

  test("cookies: Set-Cookie parsing and expiry", () => {
    const { cookies, exp } = parseSetCookies(["hatch_vml=v; Max-Age=100; HttpOnly", "a=b; Expires=Thu, 01 Jan 2099 00:00:00 GMT"], 1_000_000)
    assert.deepEqual(cookies, { hatch_vml: "v", a: "b" })
    assert.equal(exp.hatch_vml, 1100)
    assert.equal(expiryMs(exp), 1_100_000)
  })

  test("cookies: one batch places every cookie under both the host and its dot-domain", () => {
    const now = 1_000_000_000_000
    const soon = Math.floor(now / 1000) + 60
    const later = Math.floor(now / 1000) + 30 * 86400
    const specs = cookieSpecs("muse.ai", true, { hatch_sess: "s", hatch_vml: "v", empty: "" }, { hatch_sess: soon, hatch_vml: later }, now)
    assert.equal(specs.length, 4)
    const placed = (name: string, domain: string) => `${name}@${domain}`
    assert.deepEqual(specs.map((s) => placed(s.name, s.domain)), [
      placed("hatch_sess", ".muse.ai"),
      placed("hatch_sess", "muse.ai"),
      placed("hatch_vml", ".muse.ai"),
      placed("hatch_vml", "muse.ai"),
    ])
    assert.deepEqual(specs[0], { name: "hatch_sess", value: "s", domain: ".muse.ai", path: "/", secure: true, expires: now / 1000 + 7 * 86400 })
    assert.equal(specs[2].expires, later)
    assert.equal(specs[2].secure, true)
    assert.deepEqual(cookieSpecs("muse.ai", false, {}, {}, now), [])
  })

  test("account label: a name muse.ai sends; the version matches the package", () => {
    assert.equal(labelOf({ status: "assigned", user: { email: "a@b.c" } }), "a@b.c")
    assert.equal(labelOf({ status: "assigned", vm_id: "x" }), "")
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    assert.equal(VERSION, pkg.version)
  })

  test("the stable account id is muse.ai's own, read from /api/falco and bounded", async () => {
    const urls: string[] = []
    const answering = async (url: any) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ user: { kind: "user", identifier: "acct-123" } }), { status: 200 })
    }
    assert.equal(await stableAccountId("https://muse.ai", { hatch_sess: "s" }, { fetchImpl: answering }), "acct-123")
    assert.deepEqual(urls, ["https://muse.ai/api/falco"])

    // Anything but a signed-in answer with a sane id is no id at all — never a guess at one.
    const refused = async () => new Response("{}", { status: 401 })
    assert.equal(await stableAccountId("https://muse.ai", { hatch_sess: "s" }, { fetchImpl: refused }), "")
    const huge = async () => new Response(JSON.stringify({ user: { identifier: "x".repeat(200) } }), { status: 200 })
    assert.equal(await stableAccountId("https://muse.ai", {}, { fetchImpl: huge }), "")
    const garbled = async () => new Response("not json", { status: 200 })
    assert.equal(await stableAccountId("https://muse.ai", {}, { fetchImpl: garbled }), "")
    const down = async () => { throw new Error("offline") }
    assert.equal(await stableAccountId("https://muse.ai", {}, { fetchImpl: down }), "")
  })

  test("usage: the settings page's meters become Magpie's windows", () => {
    const now = new Date(2026, 9, 13, 14, 0).getTime()
    assert.equal(resetDate("每周限额将在 10月15日重置", now), new Date(2026, 9, 15).getTime())
    assert.equal(resetDate("Weekly limit resets Oct 15", now), new Date(2026, 9, 15).getTime())
    assert.equal(resetDate("Resets 2 January", now), new Date(2027, 0, 2).getTime())
    assert.equal(resetDate("从不过期", now), null)
    const card = usageCard([
      { name: "免费版", used: 37, texts: ["免费版", "每周限额将在 10月15日重置", "已使用 37%"] },
      { name: "额外的使用额度", used: 0, texts: ["额外的使用额度", "从不过期", "已使用 0%（剩余 10 亿个词元）"] },
    ], now)
    assert.equal(card.plan, "免费版")
    assert.deepEqual(card.windows, [
      { name: "每周", used: 37, resetsAt: new Date(2026, 9, 15).toISOString() },
      { name: "额外额度", used: 0, display: "剩余 10 亿个词元" },
    ])
    // Traditional Chinese, as muse.ai's zh_HK settings page writes it (muse2api 1.6.2).
    const traditional = usageCard([
      { name: "免費計劃", used: 7, texts: ["免費計劃", "每星期上限會於 10月30日重設", "已用 7%"] },
      { name: "額外的符元", used: 0, texts: ["額外的符元", "永不過期", "已使用 0%（剩餘 20 億個憑證）"] },
    ], now)
    assert.equal(traditional.plan, "免費計劃")
    assert.deepEqual(traditional.windows, [
      { name: "每周", used: 7, resetsAt: new Date(2026, 9, 30).toISOString() },
      { name: "额外额度", used: 0, display: "剩餘 20 億個憑證" },
    ])
    assert.equal(usageCard([{ name: "免費方案", used: 1, texts: ["免費方案", "每週上限會於 10月15日重設", "已用 1%"] }], now).windows[0].name, "每周")
  })

  test("the settings menu item is recognized in English and both Chinese scripts", () => {
    const items = []
    const previous = globalThis.document
    globalThis.document = { querySelectorAll: () => items }
    const item = (text) => ({ innerText: text, focused: false, focus() { this.focused = true } })
    try {
      items.push(item("設定"))
      assert.equal(settingsItem(), true)
      assert.equal(items[0].focused, true)
      items[0] = item("Settings")
      assert.equal(settingsItem(), true)
      items[0] = item("键盘快捷键")
      assert.equal(settingsItem(), false)
    } finally {
      if (previous === undefined) delete globalThis.document
      else globalThis.document = previous
    }
  })

  test("a sign-in is complete with the session and device cookies alone", () => {
    assert.deepEqual(ESSENTIAL, ["hatch_sess", "hatch_native_auth_device"])
  })

  test("a settings page with no meters yet backs off like any failed reading", async () => {
    const muse = new Muse({})
    muse.started = Promise.resolve()
    muse.accounts.set("a", { contextId: "c", tabs: new Map() })
    let opened = 0
    muse.openUsage = async () => { opened++; return [] }
    await assert.rejects(muse.readUsage({ id: "a" }), /没有加载出来/)
    assert.equal(await muse.readUsage({ id: "a" }), null)
    assert.equal(opened, 1)
  })
})

const executable = findBrowser()

describe("Muse browser boundary", { skip: executable ? false : "no Chrome/Edge/Chromium installed", timeout: 180_000 }, () => {
  let fake, dir, muse
  const account = { id: "test-account", cookies: goodCookies(), cookies_exp: {} }

  before(async () => {
    fake = await startFakeMuse()
    dir = mkdtempSync(path.join(os.tmpdir(), "mw-muse-"))
    muse = new Muse({ site: fake.site, executable, profileDir: path.join(dir, "browser"), headless: true, proxy: "direct", quietMs: 1500, shortQuietMs: 300, onCookies: () => {} })
  })

  after(async () => {
    await muse?.stop()
    await fake?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("streams text, media, restyled lists, and suggested follow-ups", async () => {
    const cases = [["REPLY:你好世界", "你好世界"], ["IMAGE:企鹅", "生成好了，这次戴上帽子了\n\n![](https://cdn.example/penguin.png)"], ["RESTYLE:清单", "清单：\n苹果\n香蕉"], ["SUGGEST:问题", "这个项目用的是 Vitest。"]]
    for (const [prompt, expected] of cases) {
      let text = ""
      for await (const delta of muse.chat(account, { full: prompt, last: prompt, turns: 1 }, { conversation: prompt })) text += delta
      assert.equal(text, expected)
    }
  })

  test("the same conversation sends only the newest message; a new one sends the whole history", async () => {
    // First turn establishes the thread; the next one continues it and sends just the last message.
    let text = ""
    for await (const delta of muse.chat(account, { full: "REPLY:你好世界", last: "REPLY:你好世界", turns: 1 }, { conversation: "reuse" })) text += delta
    assert.equal(text, "你好世界")
    text = ""
    const continued = { full: "用户：\nREPLY:你好世界\n\n助手：\n你好世界\n\n用户：\nREPLY:第二轮", last: "REPLY:第二轮", turns: 2 }
    for await (const delta of muse.chat(account, continued, { conversation: "reuse", continuing: true })) text += delta
    assert.equal(text, "第二轮")
    assert.equal(fake.state.prompts.at(-1), "REPLY:第二轮")
    // A fresh conversation starts over with the whole history, so its lead is the first turn.
    text = ""
    for await (const delta of muse.chat(account, continued, { conversation: "fresh" })) text += delta
    assert.equal(text, "你好世界")
    assert.match(fake.state.prompts.at(-1), /^用户：\nREPLY:你好世界\n\n助手：/)
  })

  test("warm opens the page the first message then reuses", async () => {
    const warm = { id: "warm-account", cookies: goodCookies(), cookies_exp: {} }
    await muse.warm(warm)
    assert.equal(muse.state(warm.id).ready, true)
    const loads = fake.state.pageLoads
    let text = ""
    for await (const delta of muse.chat(warm, { full: "REPLY:热好了", last: "REPLY:热好了", turns: 1 }, { conversation: "warm" })) text += delta
    assert.equal(text, "热好了")
    assert.equal(fake.state.pageLoads, loads)
  })

  test("verify answers a short message in a thread it forgets afterwards", async () => {
    const verify = { id: "verify-account", cookies: goodCookies(), cookies_exp: {} }
    await muse.verify(verify)
    assert.match(fake.state.prompts.at(-1), /连通测试/)
    assert.ok(!muse.accounts.get(verify.id).threads.has("\u0000verify"))
  })

  test("keep-alive renews the session over HTTP and confirms the VM is running", async () => {
    const kept = { id: "keep-account", cookies: goodCookies(), cookies_exp: {} }
    let saved = null
    const keeper = new Muse({ site: fake.site, executable, profileDir: path.join(dir, "keep"), headless: true, proxy: "direct", quietMs: 1500, shortQuietMs: 300, onCookies: (id, c, e) => { saved = c } })
    try {
      const wakes = fake.state.wakeCalls
      const { vmState } = await keeper.keepAlive(kept)
      assert.equal(vmState, "RUNNING")
      assert.equal(fake.state.wakeCalls, wakes + 1)
      assert.match(saved.hatch_vml, /^renewed/)
    } finally {
      await keeper.stop()
    }
  })

  test("an account muse.ai says is used up throws at once", async () => {
    const spent = { id: "spent-account", cookies: goodCookies(), cookies_exp: {} }
    const t0 = Date.now()
    await assert.rejects(
      (async () => { for await (const _ of muse.chat(spent, { full: "QUOTA: hi", last: "QUOTA: hi", turns: 1 }, { conversation: "quota" })) {} })(),
      /额度用完/,
    )
    assert.ok(Date.now() - t0 < 15_000, "no waiting for the first-token timeout")
  })

  test("a browser whose connection dropped is replaced by the next request", async () => {
    const first = await muse.start()
    first.browser.ws.close()
    await new Promise((resolve) => first.browser.onClose(resolve))
    assert.equal(muse.started, null)
    const after = { id: "after-reconnect", cookies: goodCookies(), cookies_exp: {} }
    let text = ""
    for await (const delta of muse.chat(after, { full: "REPLY:又连上了", last: "REPLY:又连上了", turns: 1 }, { conversation: "reconnect" })) text += delta
    assert.equal(text, "又连上了")
    const second = await muse.start()
    assert.notEqual(second.proc.pid, first.proc.pid)
    const old = first.proc
    if (old.exitCode === null && old.signalCode === null) await new Promise((r) => old.once("exit", r))
  })
})

describe("Muse current page selectors", { skip: executable ? false : "no Chrome/Edge/Chromium installed", timeout: 60_000 }, () => {
  test("supports textarea and contenteditable composers", async () => {
    const fake = await startFakeMuse({ newBuild: true })
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-current-"))
    const muse = new Muse({ site: fake.site, executable, resolveExecutable: async () => ({ executable, extraArgs: [] }), profileDir: path.join(dir, "browser"), headless: true, proxy: "direct", quietMs: 1200, shortQuietMs: 300, onCookies: () => {} })
    try {
      let text = ""
      for await (const delta of muse.chat({ id: "new-build", cookies: goodCookies(), cookies_exp: {} }, { full: "REPLY:新版", last: "REPLY:新版", turns: 1 }, { conversation: "new-build" })) text += delta
      assert.equal(text, "新版")
      assert.equal(fake.state.decoys, 0)
      const editorFake = await startFakeMuse({ newBuild: "editor" })
      const editorDir = mkdtempSync(path.join(os.tmpdir(), "mw-editor-"))
      const editorMuse = new Muse({ site: editorFake.site, executable, resolveExecutable: async () => ({ executable, extraArgs: [] }), profileDir: path.join(editorDir, "browser"), headless: true, proxy: "direct", quietMs: 1200, shortQuietMs: 300, onCookies: () => {} })
      try {
        let editorText = ""
        for await (const delta of editorMuse.chat({ id: "editor", cookies: goodCookies(), cookies_exp: {} }, { full: "REPLY:编辑器", last: "REPLY:编辑器", turns: 1 }, { conversation: "editor" })) editorText += delta
        assert.equal(editorText, "编辑器")
      } finally {
        await editorMuse.stop(); await editorFake.close(); rmSync(editorDir, { recursive: true, force: true })
      }
    } finally {
      await muse.stop(); await fake.close(); rmSync(dir, { recursive: true, force: true })
    }
  })
})
