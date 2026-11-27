import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import readline from "node:readline"
import { browserPathProblem, findBrowser } from "./browser.ts"
import { ensureFingerprintBrowser } from "./fingerprint.ts"
import { Logins } from "./login.ts"
import { AuthError, Muse, PromptTooLongError, QuotaError, redact, renewSession } from "./muse.ts"
import { proxiedFetch, proxyHasCredentials, resolveProxy } from "./net.ts"
import { dataDir } from "./paths.ts"
import { buildPrompt, PromptError } from "./prompt.ts"
import { siteOrDefault, siteProblem } from "./site.ts"
import { functions, parseToolCalls, stripLabels, TOOLS_REMINDER, toolChoiceRequired, toolChoiceSatisfied, toolsPrompt } from "./tools.ts"
import { VERSION } from "./version.ts"

const env = process.env
const dir = dataDir(env)
mkdirSync(dir, { recursive: true })

console.log = console.error

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const now = () => new Date().toTimeString().slice(0, 8)

// How many accounts may read usage at once. Each read opens its own tab, so the pool keeps
// a large saved set from flooding the browser while still finishing well ahead of a serial loop.
const USAGE_PARALLEL = 3

async function inBatches<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => worker()))
}

function send(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n")
}

function log(line: string) {
  send({ ev: "log", line })
}

const callbacks = new Map<string, (message: any) => void>()
let callbackSeq = 0

function storeRequest(request: string, params: unknown): Promise<any> {
  const rid = `g${++callbackSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(rid)
      reject(new Error(`${request} timed out`))
    }, 30_000)
    callbacks.set(rid, (message) => {
      clearTimeout(timer)
      if (message.ok) resolve(message.value)
      else reject(new Error(message.error || request))
    })
    send({ rid, req: request, params })
  })
}

async function verifyAccount(account: any, tries = 3) {
  let last: any
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await muse.verify(account)
    } catch (err: any) {
      last = err
      if (err instanceof AuthError || err instanceof QuotaError) throw err
      if (attempt < tries - 1) await sleep(8_000 * (attempt + 1))
    }
  }
  throw last
}

// The site receives the account's cookies, so a value that cannot be carried safely is refused
// here rather than discovered later by a browser showing an error page. The plugin checks the same
// thing before it starts this engine (one predicate, both callers, like the typed browser path);
// this side is the one that matters when the engine is started by hand.
const siteTrouble = siteProblem(env.MUSE_WEB_SITE)
const site = siteOrDefault(env.MUSE_WEB_SITE)
if (siteTrouble) log(`muse-web: ${siteTrouble}`)
const proxy = resolveProxy(env)
// The browser gets the proxy without its credentials (they would only sit in a command line any
// local user can read, and Chrome ignores them there). Say so once, so a proxy that needs a
// password is not silently a proxy that refuses the browser's requests.
if (proxyHasCredentials(proxy)) log("muse-web: 代理地址带的用户名密码只用于引擎自己的请求；浏览器的 --proxy-server 里不带凭据")
const fetchImpl = proxiedFetch(proxy)
// MUSE_WEB_CHROME names the program this engine launches, so it follows the same rule as a path
// typed into the sign-in prompt. Say why a configured value was set aside: otherwise the browser
// that starts is a mystery, or there is none and the reason is not visible anywhere.
const configuredBrowser = (env.MUSE_WEB_CHROME || "").trim()
const configuredTrouble = configuredBrowser ? browserPathProblem(configuredBrowser) : null
if (configuredTrouble) log(`muse-web: MUSE_WEB_CHROME ${configuredTrouble}；按未设置处理`)
const fallbackExecutable = findBrowser(env)
const mode = ["headless", "hidden", "show"].includes(env.MUSE_WEB_BROWSER || "") ? env.MUSE_WEB_BROWSER : "headless"
const prewarm = env.MUSE_WEB_PREWARM !== "0"
const verifyLogin = env.MUSE_WEB_VERIFY_LOGIN !== "0"

let browserReady: Promise<any> | null = null
function prepareBrowser() {
  browserReady ??= (async () => {
    let picked: any = null
    try {
      picked = await ensureFingerprintBrowser({ dir, env, log, fetchImpl, exists: existsSync })
    } catch (err: any) {
      log(`指纹浏览器：准备失败，改用系统中的 Chromium（${redact(err.message)}）`)
      picked = null
    }
    if (picked?.executable) {
      log(`browser: ${picked.executable} (${picked.source}${picked.version ? ` ${picked.version}` : ""})`)
      return picked
    }
    if (fallbackExecutable) {
      log(`browser: ${fallbackExecutable} (system)`)
      return { executable: fallbackExecutable, extraArgs: [], source: "system", version: "" }
    }
    log("browser: 没有可用的浏览器——没找到 Donut Browser 的 Wayfern 内核，指纹浏览器也没能下载，本机也没有 Chrome、Edge 或 Chromium")
    return null
  })()
  return browserReady
}

const muse = new Muse({
  site,
  executable: fallbackExecutable,
  resolveExecutable: prepareBrowser,
  profileDir: path.join(dir, "browser"),
  headless: mode === "headless",
  hidden: mode === "hidden",
  proxy,
  fetchImpl,
  onCookies: (id, cookies, exp, vm) => send({ ev: "cookies", handle: id, cookies, cookies_exp: exp, vm }),
  onLost: (why) => send({ ev: "lost", why }),
})

async function warmOne(account: any) {
  const startedAt = Date.now()
  try {
    await muse.warm(account)
    log(`${now()} warm account=${account.id} ${Date.now() - startedAt}ms`)
    return true
  } catch (err: any) {
    log(`${now()} warm account=${account.id} failed reason=${redact(err.message)}`)
    return false
  }
}

async function warm(handles: string[]) {
  const startedAt = Date.now()
  const ready = await Promise.all(handles.map(async (handle) => {
    const account = await storeRequest("store.get", { handle })
    if (!account) return null
    return (await warmOne(account)) ? account : null
  }))
  const accounts = ready.filter(Boolean) as any[]
  await inBatches(accounts, USAGE_PARALLEL, (account) => readUsage(account))
  log(`${now()} warm done accounts=${accounts.length} ${Date.now() - startedAt}ms`)
}

async function readUsage(account: any, maxAgeMs = 0) {
  const startedAt = Date.now()
  try {
    const reading = await muse.readUsage(account, { maxAgeMs })
    if (reading && reading.at >= startedAt) {
      const meters = reading.windows.map((item: any) => `${item.name}=${item.used}%`).join(" ")
      log(`${now()} usage account=${account.id} ${Date.now() - startedAt}ms ${meters}`)
    }
  } catch (err: any) {
    log(`${now()} usage account=${account.id} failed reason=${redact(err.message)}`)
  }
}

const logins = new Logins({
  site,
  executable: fallbackExecutable,
  resolveExecutable: prepareBrowser,
  dir: path.join(dir, "login"),
  proxy,
  fetchImpl,
  headless: env.MUSE_WEB_LOGIN_HEADLESS === "1",
  onDone: async (cookies, exp, label, vm) => {
    const saved = await storeRequest("store.add", { cookies, cookies_exp: exp, label, vm })
    if (saved.again) await muse.closeAccount(saved.handle).catch(() => {})
    await storeRequest("woken", { handle: saved.handle })
    if (verifyLogin) {
      const startedAt = Date.now()
      try {
        const account = await storeRequest("store.get", { handle: saved.handle })
        await verifyAccount(account)
        log(`${now()} verify account=${saved.handle} ${Date.now() - startedAt}ms`)
      } catch (err: any) {
        log(`${now()} verify account=${saved.handle} failed reason=${redact(err.message)}`)
        if (!(err instanceof QuotaError)) {
          if (!saved.again) {
            await muse.closeAccount(saved.handle).catch(() => {})
            await storeRequest("store.remove", { handle: saved.handle })
          }
          throw new Error(`已登录，但账号没有回答测试消息：${err.message}`)
        }
      }
    }
    if (prewarm) warm([saved.handle]).catch(() => {})
    return saved
  },
})

const busy = new Set<string>()
async function once(handle: string, run: () => Promise<any>): Promise<any> {
  if (busy.has(handle)) throw Object.assign(new Error("account busy"), { kind: "busy" })
  busy.add(handle)
  try {
    return await run()
  } finally {
    busy.delete(handle)
  }
}

function state(handle: string) {
  return muse.state(handle)
}

function errorKind(err: any): string {
  if (err?.kind) return String(err.kind)
  if (err instanceof AuthError) return "auth"
  if (err instanceof QuotaError) return "quota"
  if (err instanceof PromptTooLongError) return "prompt_too_long"
  if (err instanceof PromptError) return "invalid_request"
  return "generation"
}

function fail(id: string, err: any) {
  send({ id, ev: "error", kind: errorKind(err), message: redact(err.message || String(err)) })
}

const operations: Record<string, (params: any) => Promise<any>> = {
  chat_stream: (params) => once(params.account.id, () => chat(params)),
  read_usage: ({ account, maxAgeMs = 0 }) => readUsage(account, maxAgeMs).then(() => ({ usage: muse.usageOf(account.id) })),
  usage: async ({ account, busy: isBusy, maxAgeMs = 0 }) => {
    let usage = muse.usageOf(account.id)
    const { ready } = state(account.id)
    if (ready && !isBusy && (!usage || Date.now() - usage.at > maxAgeMs)) {
      const reading = readUsage(account, maxAgeMs)
      if (!usage) {
        let timer: ReturnType<typeof setTimeout>
        try {
          await Promise.race([reading, new Promise<void>((resolve) => { timer = setTimeout(resolve, 8_000) })])
        } finally {
          clearTimeout(timer!)
        }
        usage = muse.usageOf(account.id)
      }
    }
    return { usage, ready }
  },
  state: async ({ account }) => state(account.id),
  keep_alive: ({ account }) => muse.keepAlive(account).then(({ vmState }) => ({ vmState })),
  warm: ({ account }) => warmOne(account).then(() => ({})),
  verify: ({ account }) => verifyAccount(account).then(() => ({})),
  refresh: ({ account }) => renewSession(site, account.cookies, account.cookies_exp, { fetchImpl, wakeVm: false }).then((renewed) => ({ cookies: renewed.cookies, cookies_exp: renewed.cookies_exp })),
  login_start: ({ browser = "" }) => logins.start(browser).then((id) => ({ id })),
  login_status: ({ id }) => Promise.resolve({ state: logins.status(id) }),
  login_stop_all: () => Promise.resolve(logins.stopAll()),
  close_tab: ({ account, conversation = "" }) => muse.closeTab(account.id, conversation).then(() => ({})),
  close_account: ({ account }) => muse.closeAccount(account.id).then(() => ({})),
  stop: () => muse.stop().then(() => ({})),
}

const running = new Map<string, { abort?: () => void }>()

function serve(line: string) {
  let message: any
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.rid) {
    const callback = callbacks.get(message.rid)
    callbacks.delete(message.rid)
    callback?.(message)
    return
  }
  const { id, op, params = {} } = message
  if (!id) return
  if (op === "abort") {
    running.get(id)?.abort?.()
    return
  }
  // Nothing that would talk to a bad site may run. The two ops that only stop things keep
  // working: closing a sign-in window is not a reason to leave the engine stuck with a bad config.
  if (siteTrouble && op !== "stop" && op !== "login_stop_all") {
    fail(id, Object.assign(new Error(siteTrouble), { kind: "invalid_request" }))
    return
  }
  const run = operations[op]
  if (!run) {
    fail(id, new Error(`unknown op: ${op}`))
    return
  }
  const controller = new AbortController()
  running.set(id, { abort: () => controller.abort() })
  const promise = Promise.resolve().then(() => {
    controller.signal.throwIfAborted()
    return run({ ...params, requestId: id, signal: controller.signal })
  })
  promise.then((value) => send(op === "chat_stream" ? { id, ev: "final", ...value } : { id, ev: "result", value }))
    .catch((err: any) => fail(id, err))
    .finally(() => running.delete(id))
}

async function chat(params: any) {
  const account = params.account
  const session = String(params.conversation || "")
  const stream = params.stream !== false
  let prompt
  try {
    prompt = buildPrompt(params.messages)
  } catch (err: any) {
    throw Object.assign(err, { kind: "invalid_request" })
  }
  const toolNote = toolsPrompt(params.tools, params.tool_choice)
  const requiredTool = toolChoiceRequired(params.tools, params.tool_choice)
  if (toolNote) prompt = { ...prompt, full: `${prompt.full}\n\n${toolNote}`, last: prompt.last && `${prompt.last}\n\n${TOOLS_REMINDER}` }
  const continuing = Boolean(session && prompt.turns > 1)
  const timing: any = {}
  let text = ""
  let shown = ""
  let holding = Boolean(requiredTool)
  let pending = ""
  for await (const delta of muse.chat(account, prompt, { conversation: session, continuing, signal: params.signal, timing, expectTools: Boolean(toolNote) })) {
    text += delta
    if (!stream || holding) continue
    let piece = delta
    if (toolNote) {
      pending += delta
      const at = pending.search(/[<{`]/)
      if (at !== -1) {
        piece = pending.slice(0, at)
        holding = true
      } else {
        const nl = pending.lastIndexOf("\n")
        if (nl === -1) continue
        piece = pending.slice(0, nl + 1)
        pending = pending.slice(nl + 1)
      }
      piece = stripLabels(piece)
    }
    if (!piece) continue
    send({ id: params.requestId, ev: "delta", text: piece })
    shown += piece
  }
  let whole = timing.text || text
  let parsed = toolNote ? parseToolCalls(whole, params.tools) : { calls: [], content: whole }
  let calls = parsed.calls
  let content = parsed.content
  const satisfied = () => toolChoiceSatisfied(requiredTool, calls)
  if (requiredTool && !satisfied() && session) {
    const repair = "你刚才没有按格式调用工具。请只输出一个 tool_call 代码块，里面是一个 JSON 对象：{\"name\": \"工具名\", \"arguments\": {参数}}。不要输出其他文字。"
    let repaired = ""
    try {
      for await (const delta of muse.chat(account, { full: repair, last: repair, turns: 1 }, { conversation: session, continuing: true, signal: params.signal, timing: {}, expectTools: true })) repaired += delta
      const again = parseToolCalls(repaired, params.tools)
      if (again.calls.length) {
        calls = again.calls
        content = again.content
        whole = repaired
        text = repaired
      }
    } catch (err: any) {
      if (err instanceof AuthError || err instanceof QuotaError) throw err
    }
  }
  if (requiredTool && !satisfied()) {
    throw Object.assign(new Error("model did not call the required tool"), { kind: "tool_call_not_parsed" })
  }
  params.signal.throwIfAborted()
  const rest = toolNote ? stripLabels(calls.length ? content : whole) : whole
  const more = rest.startsWith(shown) ? rest.slice(shown.length) : ""
  if (stream && more) send({ id: params.requestId, ev: "delta", text: more })
  send({ id: params.requestId, ev: "meta", how: timing.how, sent: timing.sent, tabMs: timing.tabMs, firstMs: timing.firstMs })
  return {
    text: whole,
    content: calls.length ? content || null : whole,
    calls,
    tools: toolNote ? `${functions(params.tools).length}→${calls.map((call) => call.name).join(",") || "text"}` : "",
  }
}

function close() {
  logins.stopAll()
  muse.stop().catch(() => {}).finally(() => process.exit(0))
}

function main() {
  process.on("SIGINT", close)
  process.on("SIGTERM", close)
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  reader.on("line", (line) => {
    try {
      serve(line)
    } catch (err: any) {
      console.error(redact(err.message || String(err)))
    }
  })
  reader.on("close", close)
  send({ ev: "ready", version: VERSION })
  // With a site that cannot be used, preparing a browser is work done for a request that will be
  // refused, and the fingerprint browser may be a download.
  if (!siteTrouble) prepareBrowser().catch(() => {})
}

main()
