import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dataDir, enginePort } from "./engine/paths.ts"
import { browserOptions, browserPathProblem, normalizeBrowserPath } from "./engine/browser.ts"
import { findFingerprintBrowser, findWayfernBrowser, isWayfernBrowser } from "./engine/fingerprint.ts"
import { CHALLENGE_HEADER, healthChallenge, provesHealth } from "./engine/health.ts"
import { anyFetch, credentialSafeUrl } from "./engine/local-fetch.ts"
import { siteProblem } from "./engine/site.ts"
import { VERSION } from "./engine/version.ts"

const PROVIDER = "muse-web"
const MODEL = "muse-spark"
// A select value, never a path: the sign-in prompt offers it when the scan misses a browser.
const MANUAL_BROWSER = "__manual__"
const CONTROL_TIMEOUT_MS = 10_000
const ENGINE_START_MS = 20_000
// the engine's 15 minutes to sign in, then the test message it sends to the new account
const LOGIN_LIMIT_MS = 18 * 60_000
const REFRESH_LEAD_MS = 10 * 60_000
// muse.ai names no limits. These are what one web prompt comfortably holds, so clients
// compact long conversations before the page has to take them.
const CONTEXT_TOKENS = 128_000
const OUTPUT_TOKENS = 16_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ICON = (() => {
  try {
    return `data:image/svg+xml;base64,${readFileSync(path.join(HERE, "icon.svg")).toString("base64")}`
  } catch {
    return ""
  }
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The engine is the plugin's own TypeScript now, run by the same Node that runs the plugin — no
// prebuilt binary to ship or to miss. An installation that predates this still works through
// MUSE_WEB_ENGINE_BIN, which names a native engine to run instead.
const ENGINE_ENTRY = path.join(HERE, "engine", "main.ts")
const ENGINE_DRIVER = path.join(HERE, "engine", "driver.ts")

// An engine at least as new as this plugin is kept: a Magpie that has not reloaded the plugin
// yet must not keep replacing the engine a newer copy of the plugin started.
function current(version) {
  if (!version) return false
  const a = version.split(".").map(Number)
  const b = VERSION.split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return true
}

function originFrom(value) {
  return String(value).trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function isOurs(input) {
  const id = input?.model?.providerID || input?.provider?.info?.id || input?.message?.model?.providerID || ""
  return id === PROVIDER || id === `${PROVIDER}-plugin`
}

function handleOf(auth) {
  const value = auth?.type === "api" ? auth.key : auth?.type === "oauth" ? auth.refresh || auth.access : ""
  return typeof value === "string" ? value.trim() : ""
}

function engineHeaders(key: string, handle: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (handle) headers["x-muse-account"] = handle
  if (key) headers.authorization = `Bearer ${key}`
  return headers
}

function structured(windows: any): any[] {
  if (!Array.isArray(windows)) return []
  // One malformed meter should not throw away the valid ones.
  return windows.filter((item) => {
    return item && typeof item.name === "string" && item.name.trim() !== "" && typeof item.used === "number" && item.used >= 0 && item.used <= 100
  })
}

export const MuseWebPlugin = async (_input: any = {}, options: any = {}) => {
  const opt = options && typeof options === "object" ? options : {}
  // An engine named in options or MUSE_WEB_ENGINE is run by someone else; otherwise the plugin runs its own.
  const namedEngine = () => String(opt.engine || process.env.MUSE_WEB_ENGINE || "").trim()
  const external = () => Boolean(namedEngine())
  const engineOrigin = () => originFrom(namedEngine() || `http://127.0.0.1:${enginePort()}`)
  // Why a named engine may not be used, or "" when it may. The engine key and every account
  // handle are credentials, so they only travel in the clear to loopback; a named engine on
  // another machine has to be https.
  const originTrouble = () => {
    if (!external() || credentialSafeUrl(engineOrigin())) return ""
    return `引擎地址 ${engineOrigin()} 既不是本机回环地址，也不是 https。engine.key 和账号句柄只会发给回环或 https 端口；请改用 https，或让引擎跑在 127.0.0.1。`
  }
  const engineBaseURL = () => `${engineOrigin()}/v1`
  const engineKey = () => {
    const own = String(opt.key ?? process.env.MUSE_WEB_ENGINE_KEY ?? "").trim()
    if (own || external()) return own
    const file = path.join(dataDir(), "engine.key")
    return existsSync(file) ? readFileSync(file, "utf8").trim() : ""
  }

  // When the port last proved it holds this data directory's engine.key. `trouble` explains a port
  // that answers in the engine's name but cannot prove itself, so the message can be acted on.
  let verifiedAt = 0
  let trouble = ""

  // Asks the port to prove it is our engine: send a nonce, check the HMAC only a holder of
  // engine.key can make. A squatter that binds the port first answers in the engine's name but
  // cannot produce the proof, so it is never treated as ours and never handed the key.
  async function inspect(): Promise<{ version: string; ours: boolean; answered: boolean }> {
    // An origin we will never hand a credential to is not worth probing.
    if (originTrouble()) return { version: "", ours: false, answered: false }
    const nonce = healthChallenge()
    try {
      const res = await anyFetch(`${engineOrigin()}/v1/health`, {
        headers: { [CHALLENGE_HEADER]: nonce },
        signal: AbortSignal.timeout(1500),
      })
      const body = res.ok ? await res.json() as any : null
      if (body?.engine !== "muse-web") return { version: "", ours: false, answered: true }
      const version = String(body.version || "?")
      const key = engineKey()
      if (key && provesHealth(body, key, nonce)) {
        verifiedAt = Date.now()
        trouble = ""
        return { version, ours: true, answered: true }
      }
      return { version, ours: false, answered: true }
    } catch {
      return { version: "", ours: false, answered: false }
    }
  }

  // The running engine's version, or "" unless the port proves it is ours.
  async function running() {
    const seen = await inspect()
    return seen.ours ? seen.version : ""
  }

  // True only when the port at engineOrigin() is one we may send engine.key and account handles to.
  async function ours() {
    if (external()) return originTrouble() === ""
    if (Date.now() - verifiedAt < 30_000) return true
    return (await inspect()).ours
  }

  // Why the engine cannot be reached, in terms a person can act on.
  function downMessage() {
    const why = originTrouble() || trouble
    return why
      ? `muse-web 引擎连不上：${why}`
      : "muse-web 引擎没有启动；日志在数据目录的 engine.log"
  }

  async function retire() {
    await anyFetch(`${engineOrigin()}/v1/shutdown`, {
      method: "POST",
      headers: engineHeaders(engineKey(), ""),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    }).catch(() => {})
    const end = Date.now() + 8000
    while (Date.now() < end && (await running())) await sleep(250)
  }

  let starting = null
  let checkedAt = 0
  // Makes sure the bundled engine answers, starting the native supervisor if needed.
  function ensureEngine({ force = false } = {}) {
    if (external()) return Promise.resolve(true)
    if (!force && Date.now() - checkedAt < 30_000) return Promise.resolve(true)
    starting ??= (async () => {
      const seen = await inspect()
      if (seen.ours && current(seen.version)) return true
      if (seen.ours) {
        // An engine left from an older plugin version is replaced; same data dir, same accounts.
        await retire()
      } else if (seen.answered) {
        // Something holds the port and answers in the engine's name but cannot prove it holds our
        // key — typically an engine from before this check that is still running after an upgrade.
        // Do not spawn (the port is taken) and do not send it the key; the person restarts Magpie.
        trouble = `端口 ${enginePort()} 已被别的进程占用，而且它无法证明自己持有 engine.key（常见于升级后仍在运行的旧版引擎）。请重启 Magpie，或结束占用该端口的进程。`
        return false
      }
      // The site decides where this account's cookies go. A mirror named over plain http on
      // another machine would put them on the wire in clear, so no engine is started for it and
      // the reason is what the person sees. The driver refuses the same value itself, which is
      // what covers a hand-started engine; this check is the one that can say it in Magpie.
      const siteWhy = siteProblem(process.env.MUSE_WEB_SITE)
      if (siteWhy) {
        trouble = siteWhy
        return false
      }
      // A native engine named explicitly is run instead; otherwise the plugin runs its own
      // TypeScript entry with this same Node, so a source-only install has everything it needs.
      const named = String(process.env.MUSE_WEB_ENGINE_BIN || "").trim()
      if (named && !existsSync(named)) throw new Error(`muse-web engine binary not found: ${named}`)
      if (!named && !existsSync(ENGINE_ENTRY)) {
        throw new Error(`muse-web 引擎入口缺失：${ENGINE_ENTRY}（插件安装不完整，请重新安装 magpie-muse-web）`)
      }
      const child = spawn(named || process.execPath, named ? [] : [ENGINE_ENTRY], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          MUSE_WEB_NODE: process.execPath,
          MUSE_WEB_DRIVER: ENGINE_DRIVER,
          MUSE_WEB_PARENT_PID: String(process.pid),
        },
      })
      child.on("error", () => {})
      child.unref()
      const end = Date.now() + ENGINE_START_MS
      while (Date.now() < end) {
        await sleep(300)
        const started = await inspect()
        if (started.ours && current(started.version)) return true
      }
      return false
    })().then((ok) => {
      if (ok) checkedAt = Date.now()
      return ok
    }).finally(() => { starting = null })
    return starting
  }

  // Returns null when the engine is down or silent, so callers never mistake that for a refused sign-in.
  async function control(pathname: string, method: string, handle: string, payload?: any): Promise<Response | null> {
    if (!(await ensureEngine())) return null
    // Never hand engine.key (or an account handle) to a port that has not proven it is ours.
    if (!(await ours())) return null
    const headers = engineHeaders(engineKey(), handle)
    if (payload !== undefined) headers["content-type"] = "application/json"
    try {
      return await anyFetch(`${engineOrigin()}${pathname}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
    } catch {
      checkedAt = 0
      return null
    }
  }

  async function browserLogin(inputs: any = {}) {
    const typed = typeof inputs?.browserPath === "string" ? inputs.browserPath.trim() : ""
    const picked = typeof inputs?.browser === "string" ? inputs.browser.trim() : ""
    if (picked === MANUAL_BROWSER && !typed) {
      throw new Error("选了「手动填写浏览器路径」，但没有填路径；请填浏览器可执行文件的完整路径")
    }
    // A typed path is this machine's own, so say now that it is wrong instead of letting the
    // engine's first status poll say it a couple of seconds later. It must be absolute and name a
    // regular file: a relative path would be resolved against whatever directory the engine runs
    // in, which is not a promise anyone can make from a text box.
    if (picked === MANUAL_BROWSER) {
      const problem = browserPathProblem(typed)
      if (problem) throw new Error(`${problem}；请填浏览器可执行文件的完整路径，例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`)
    }
    // A browser picked from the scan is what the person meant; the typed path only stands in
    // when the scan missed it and there is nothing else to go on.
    const browser = picked === MANUAL_BROWSER ? normalizeBrowserPath(typed) : picked || normalizeBrowserPath(typed)
    const res = await control("/v1/login", "POST", "", browser ? { browser } : undefined)
    if (!res?.ok) throw new Error(res ? `muse-web 引擎没能开始登录（HTTP ${res.status}）` : downMessage())
    const { id, url } = await res.json() as any
    return {
      url,
      instructions: "在弹出的浏览器窗口里登录 muse.ai。优先复用本机 Donut Browser 的 Wayfern 内核；没有时会下载开源指纹浏览器 Apostate，窗口会晚一点出现。登录后窗口自动关闭，引擎再发一条测试消息，账号能回答才算登录成功。",
      method: "auto",
      async callback() {
        const end = Date.now() + LOGIN_LIMIT_MS
        while (Date.now() < end) {
          await sleep(1500)
          const poll = await control(`/v1/login/${id}`, "GET", "")
          if (!poll) continue
          if (!poll.ok) return { type: "failed", error: `muse-web 登录状态读不到（HTTP ${poll.status}）` }
          const state = await poll.json() as any
          if (state.status === "done") {
            const expires = Number.isFinite(state.expires) ? state.expires : Date.now() + 86_400_000
            return {
              type: "success",
              refresh: state.handle,
              access: state.handle,
              expires,
              ...(state.label ? { accountId: state.label } : {}),
              ...(state.label?.includes("@") ? { email: state.label } : {}),
            }
          }
          if (state.status === "failed") return { type: "failed", error: `muse.ai 登录：${state.error || "没有完成"}` }
        }
        return { type: "failed", error: "muse.ai 登录：没有在时限内完成" }
      },
    }
  }

  // Start (and so pre-warm) the engine as soon as Magpie loads the plugin, not at the first message.
  if (!external()) ensureEngine().catch(() => {})

  // An engine someone else runs may be on another machine, so its browsers are not ours to list.
  // Donut Browser's Wayfern kernel is listed first because the engine picks it by itself; then a
  // local Apostate, then the plain Chromium installs the scan can see.
  function browserChoices() {
    const out = []
    const seen = new Set<string>()
    const add = (label: string, value: string) => {
      const key = value ? path.resolve(value).toLowerCase() : ""
      if (!key || seen.has(key)) return
      seen.add(key)
      out.push({ label, value })
    }
    add("Donut Browser（Wayfern 内核）", findWayfernBrowser(process.env, process.platform, existsSync))
    const fingerprint = findFingerprintBrowser(process.env, process.platform, existsSync, dataDir())
    add(isWayfernBrowser(fingerprint) ? "Donut Browser（Wayfern 内核）" : "Apostate 指纹浏览器", fingerprint)
    for (const option of browserOptions()) {
      add(option.label, option.value)
    }
    // Portable installs and unusual folders are exactly what the scan misses, so the list
    // always ends with a way to name the executable by hand.
    out.push({ label: "手动填写浏览器路径…", value: MANUAL_BROWSER })
    return out
  }
  const browsers = external() ? [] : browserChoices()

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Muse Web",
        npm: "@ai-sdk/openai-compatible",
        api: engineBaseURL(),
        ...was,
        models: {
          // Text in, text out through the web chat; images and files never reach the page.
          // Tools are told in the prompt and the model's <tool_call> tags come back as tool calls.
          [MODEL]: {
            name: "Muse Spark",
            reasoning: false,
            attachment: false,
            tool_call: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
          ...(was.models ?? {}),
        },
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      ...(ICON ? { icon: ICON } : {}),
      // magpie renews the sign-in this long before it ends, through refresh() below
      refreshLead: REFRESH_LEAD_MS,
      methods: [
        {
          type: "oauth",
          label: "muse.ai（浏览器登录）",
          // Only a local engine can use a path from this machine; an external one keeps its own default.
          ...(browsers.length ? { prompts: [
            { type: "select", key: "browser", message: "用哪个浏览器登录 muse.ai？（最前是 Donut Browser 的 Wayfern 内核，其次是开源指纹浏览器 Apostate，其余是本机已装的 Chromium 系；没扫到时选最后一项手动填写路径）", options: browsers },
            {
              type: "text",
              key: "browserPath",
              message: "浏览器可执行文件的完整路径（Chrome、Edge、Chromium、Brave 都可以）",
              placeholder: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
              when: { key: "browser", value: MANUAL_BROWSER, op: "eq" },
            },
          ] } : {}),
          authorize: browserLogin,
        },
        { type: "api", label: "引擎账号 ID（高级：配合自己运行的引擎）", placeholder: "muse-xxxxxxxxxxxx" },
      ],
      async refresh(auth) {
        const handle = handleOf(auth)
        if (!handle) throw Object.assign(new Error("muse-web account has no engine handle"), { signIn: "expired" })
        const res = await control("/v1/session/refresh", "POST", handle)
        if (!res) throw new Error(downMessage())
        if (res.status === 401) throw Object.assign(new Error("session refused"), { signIn: "expired" })
        if (!res.ok) throw new Error("session refresh unavailable")
        const body = await res.json() as any
        // muse.ai does not always expose a cookie expiry. Keep the account usable with the old
        // deadline when it is still in the future, otherwise give it a day and try again later.
        const expires = Number.isFinite(body.expires)
          ? body.expires
          : Number.isFinite(auth?.expires) && auth.expires > Date.now()
            ? auth.expires
            : Date.now() + 86_400_000
        return auth?.type === "oauth" ? { access: handle, refresh: handle, expires } : { expires }
      },
      async usage(getAuth) {
        const handle = handleOf(await getAuth())
        if (!handle) return { error: "muse-web account has no engine handle", signIn: "expired" }
        const res = await control("/v1/usage", "GET", handle)
        if (!res) return { error: downMessage() }
        if (res.status === 401) return { error: "session refused", signIn: "expired" }
        let body: any = {}
        try {
          body = await res.json()
        } catch {
          body = {}
        }
        if (!res.ok) return { error: "usage unavailable" }
        const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "")
        const card = {
          ...(text(body.plan) ? { plan: text(body.plan) } : {}),
          ...(text(body.user) ? { user: text(body.user) } : {}),
          ...(text(body.until) ? { until: text(body.until) } : {}),
        }
        const windows = structured(body.windows)
        if (windows.length) return { ...card, windows, signIn: "kept" }
        // No quota to show is not an error when the engine described the account.
        if (card.plan) return { ...card, windows: [], signIn: "kept" }
        return { error: text(body.error) || "no structured quota" }
      },
      async loader(getAuth) {
        return {
          baseURL: engineBaseURL(),
          async fetch(input, init) {
            const auth = await getAuth()
            const handle = handleOf(auth)
            if (!handle) throw Object.assign(new Error("muse-web account has no engine handle"), { signIn: "expired" })
            const incoming = new Headers(init?.headers)
            const send = async () => {
              // The engine must be up and must prove it is ours before engine.key or an account
              // handle leaves this process; a port that cannot prove itself never sees either.
              if (!(await ensureEngine())) throw new Error(downMessage())
              if (!(await ours())) throw new Error(downMessage())
              const headers = new Headers(engineHeaders(engineKey(), handle))
              for (const name of ["content-type", "accept", "x-muse-session"]) {
                const value = incoming.get(name)
                if (value) headers.set(name, value)
              }
              return anyFetch(input, { method: init?.method, headers, body: init?.body, signal: init?.signal })
            }
            let res
            try {
              res = await send()
            } catch (err) {
              // The engine may have been stopped or crashed since the last check; start it and try once more.
              if (external() || init?.signal?.aborted || !(await ensureEngine({ force: true }))) throw err
              res = await send()
            }
            const out = new Headers(res.headers)
            out.delete("content-length")
            if (res.status === 401) out.set("x-magpie-sign-in", "expired")
            else if (res.ok) out.set("x-magpie-sign-in", "kept")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },
    },

    "chat.headers": async (input, output) => {
      if (!isOurs(input)) return
      if (input.sessionID) output.headers["x-muse-session"] = input.sessionID
    },
  }
}
