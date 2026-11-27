import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const platform = process.platform === "win32" ? "windows" : process.platform
const arch = ({ x64: "amd64", ia32: "386" } as Record<string, string>)[process.arch] || process.arch
const BINARY = path.join(ROOT, "engine-go", "bin", `${platform}-${arch}`, platform === "windows" ? "muse-web-engine.exe" : "muse-web-engine")

const ACCOUNTS = {
  "good-account": {
    cookies: { hatch_sess: "good-hatch_sess", hatch_native_auth_device: "good-device", hatch_gw: "g", hatch_vml: "v" },
    cookies_exp: { hatch_vml: 1_900_000_000 },
    label: "good@example.test",
    vm: "vm-good",
  },
  expired: { cookies: { hatch_sess: "expired" }, cookies_exp: {}, label: "expired", vm: "vm-expired" },
  empty: { cookies: {}, label: "empty" },
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function sseEvents(raw: string): any[] {
  return raw.split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))
}

describe("Go engine over HTTP", { skip: existsSync(BINARY) ? false : `missing ${BINARY}; run npm run build:engine`, timeout: 120_000 }, () => {
  let child: ChildProcessWithoutNullStreams
  let home = ""
  let key = ""
  let base = ""
  let logs = ""
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  const api = (pathname: string, init: any = {}, account = "", bearer = key) => {
    const headers: Record<string, string> = { ...(init.headers || {}) }
    if (bearer) headers.authorization = `Bearer ${bearer}`
    if (account) headers["x-muse-account"] = account
    return fetch(`${base}${pathname}`, { ...init, headers })
  }

  const jsonOf = async (res: Response) => ({ status: res.status, body: await res.json() as any })

  const chat = (account: string, payload: any, session = "") => {
    const headers: Record<string, string> = {}
    if (session) headers["x-muse-session"] = session
    return api("/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(payload) }, account)
  }

  before(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "mw-go-"))
    writeFileSync(path.join(home, "accounts.json"), JSON.stringify(ACCOUNTS))
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const name of ["MUSE_WEB_PARENT_PID", "MUSE_WEB_HOME", "MUSE_WEB_ENGINE_PORT", "MUSE_WEB_DRIVER", "MUSE_WEB_NODE", "MUSE_WEB_PREWARM", "MUSE_WEB_VERIFY_LOGIN", "MUSE_WEB_SITE", "MUSE_WEB_ENGINE", "MUSE_WEB_ENGINE_KEY"]) delete env[name]
    Object.assign(env, {
      MUSE_WEB_HOME: home,
      MUSE_WEB_ENGINE_PORT: String(port),
      MUSE_WEB_DRIVER: path.join(HERE, "fake-driver.ts"),
      MUSE_WEB_NODE: process.execPath,
      MUSE_WEB_PREWARM: "0",
      MUSE_WEB_VERIFY_LOGIN: "0",
      MUSE_WEB_SITE: "http://127.0.0.1:9",
    })
    child = spawn(BINARY, [], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    child.stdout.on("data", (data) => { logs += data.toString() })
    child.stderr.on("data", (data) => { logs += data.toString() })
    exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      if (child.exitCode !== null) break
      try {
        const res = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(500) })
        if (res.ok) break
      } catch {}
      await sleep(100)
    }
    const res = await fetch(`${base}/v1/health`)
    assert.equal(res.status, 200, logs)
    key = readFileSync(path.join(home, "engine.key"), "utf8").trim()
  })

  after(async () => {
    if (child && child.exitCode === null) {
      await fetch(`${base}/v1/shutdown`, { method: "POST", headers: { authorization: `Bearer ${key}` } }).catch(() => {})
      await Promise.race([exit, sleep(4000)])
    }
    if (child && child.exitCode === null) child.kill()
    if (home) rmSync(home, { recursive: true, force: true })
  })

  test("serves health, models, accounts, and rejects a bad key", async () => {
    const healthRes = await fetch(`${base}/v1/health`)
    assert.equal(healthRes.headers.get("x-content-type-options"), "nosniff")
    assert.equal(healthRes.headers.get("cache-control"), "no-store")
    const health = await jsonOf(healthRes)
    assert.equal(health.status, 200)
    assert.equal(health.body.engine, "muse-web")
    assert.equal(health.body.version, "0.11.0")
    assert.equal(health.body.accounts, 3)

    const denied = await jsonOf(await api("/v1/models", {}, "", "wrong"))
    assert.equal(denied.status, 401)
    assert.equal(denied.body.error.code, "engine_key_invalid")
    const models = await jsonOf(await api("/v1/models"))
    assert.equal(models.status, 200)
    assert.equal(models.body.data[0].id, "muse-spark")

    const accounts = await jsonOf(await api("/v1/accounts"))
    assert.equal(accounts.status, 200)
    assert.deepEqual(accounts.body.accounts.map((item: any) => item.id), ["expired", "good-account"])
    assert.equal(accounts.body.accounts[1].label, "good@example.test")
    assert.equal(accounts.body.accounts[1].expires, 1_900_000_000_000)
    assert.equal(accounts.body.accounts[1].cookies, undefined)

    const unknown = await jsonOf(await chat("nobody", { messages: [{ role: "user", content: "REPLY:x" }] }))
    assert.equal(unknown.status, 401)
    assert.equal(unknown.body.error.code, "account_unknown")
  })

  test("streams text and non-streamed completions", async () => {
    const streamed = await chat("good-account", { messages: [{ role: "user", content: "REPLY:流式" }] })
    assert.equal(streamed.status, 200)
    const raw = await streamed.text()
    const events = sseEvents(raw)
    const text = events.flatMap((event) => event.choices || []).map((choice: any) => choice.delta?.content || "").join("")
    assert.equal(text, "流式")
    assert.equal(events.at(-1).choices[0].finish_reason, "stop")
    assert.match(raw, /data: \[DONE\]/)

    const plain = await jsonOf(await chat("good-account", { stream: false, messages: [{ role: "user", content: "REPLY:非流式" }] }))
    assert.equal(plain.status, 200)
    assert.equal(plain.body.object, "chat.completion")
    assert.equal(plain.body.model, "muse-spark")
    assert.equal(plain.body.choices[0].message.content, "非流式")
    assert.equal(plain.body.choices[0].finish_reason, "stop")
  })

  test("maps tool calls in both streamed and non-streamed replies", async () => {
    const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }]
    const streamed = await chat("good-account", { messages: [{ role: "user", content: "TOOLCALL:列目录" }], tools })
    assert.equal(streamed.status, 200)
    const raw = await streamed.text()
    assert.match(raw, /"tool_calls"/)
    assert.match(raw, /"name":"shell"/)
    assert.match(raw, /ls -la/)
    assert.equal(sseEvents(raw).at(-1).choices[0].finish_reason, "tool_calls")

    const plain = await jsonOf(await chat("good-account", { stream: false, messages: [{ role: "user", content: "TOOLCALL:列目录" }], tools }))
    assert.equal(plain.status, 200)
    const message = plain.body.choices[0].message
    assert.equal(message.content, "好的，我来看一下。")
    assert.equal(message.tool_calls.length, 1)
    assert.equal(message.tool_calls[0].function.name, "shell")
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { command: "ls -la" })
    assert.equal(plain.body.choices[0].finish_reason, "tool_calls")
  })

  test("passes a required tool choice through and returns its call", async () => {
    const tools = [{ type: "function", function: { name: process.platform === "win32" ? "powershell" : "shell", parameters: { type: "object" } } }]
    const name = tools[0].function.name
    const res = await chat(
      "good-account",
      { messages: [{ role: "user", content: "TOOLTEXT:请调用工具" }], tools, tool_choice: { type: "function", function: { name } } },
      "repair-session",
    )
    assert.equal(res.status, 200)
    const events = sseEvents(await res.text())
    const calls = events.flatMap((event) => event.choices || []).flatMap((choice: any) => choice.delta?.tool_calls || [])
    assert.ok(calls.some((call: any) => call.function?.name === name))
    const prompts = readFileSync(path.join(home, "driver-prompts.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.ok(prompts.some((item) => item.tool_choice?.function?.name === name))
  })

  test("returns the documented 429/401 failures", async () => {
    const quota = await jsonOf(await chat("good-account", { messages: [{ role: "user", content: "QUOTA:用完" }] }))
    assert.equal(quota.status, 429)
    assert.equal(quota.body.error.code, "quota_spent")

    const expired = await jsonOf(await chat("expired", { messages: [{ role: "user", content: "REPLY:x" }] }))
    assert.equal(expired.status, 401)
    assert.equal(expired.body.error.code, "session_expired")

    const first = chat("good-account", { messages: [{ role: "user", content: "DELAY:1500" }] })
    await sleep(250)
    const busy = await jsonOf(await chat("good-account", { messages: [{ role: "user", content: "REPLY:busy" }] }))
    assert.equal(busy.status, 429)
    assert.equal(busy.body.error.code, "account_busy")
    assert.match(await (await first).text(), /收到/)
  })

  test("reads usage, renews cookies, and runs the sign-in handshake", async () => {
    const usage = await jsonOf(await api("/v1/usage", {}, "good-account"))
    assert.equal(usage.status, 200)
    assert.match(usage.body.plan, /免费版/)
    assert.match(usage.body.plan, /已就绪/)
    assert.equal(usage.body.user, "good@example.test")
    assert.equal(usage.body.windows.length, 2)

    const renewal = await jsonOf(await api("/v1/session/refresh", { method: "POST" }, "good-account"))
    assert.equal(renewal.status, 200)
    assert.ok(renewal.body.expires > Date.now())
    const expired = await jsonOf(await api("/v1/session/refresh", { method: "POST" }, "expired"))
    assert.equal(expired.status, 401)
    assert.equal(expired.body.error.code, "session_expired")

    const start = await jsonOf(await api("/v1/login", { method: "POST", body: "{}" }))
    assert.equal(start.status, 200)
    assert.equal(start.body.id, "fake-login")
    assert.match(start.body.url, /\/login\/fake-login$/)
    const state = await jsonOf(await api("/v1/login/fake-login"))
    assert.equal(state.status, 200)
    assert.equal(state.body.status, "done")
    assert.equal(state.body.handle, "good-account")
    const page = await fetch(`${base}/login/fake-login`)
    assert.equal(page.status, 200)
    assert.equal(page.headers.get("cache-control"), "no-store")
    assert.equal(page.headers.get("x-content-type-options"), "nosniff")
    assert.equal(page.headers.get("x-frame-options"), "DENY")
    assert.equal(page.headers.get("referrer-policy"), "no-referrer")
    assert.match(page.headers.get("content-security-policy") || "", /default-src 'none'/)
    assert.match(await page.text(), /登录完成/)
  })

  test("stops cleanly on /v1/shutdown", async () => {
    const res = await jsonOf(await api("/v1/shutdown", { method: "POST" }))
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    const ended = await Promise.race([exit, sleep(5000).then(() => null)])
    assert.ok(ended, "engine did not exit")
    assert.equal(ended.code, 0)
  })
})
