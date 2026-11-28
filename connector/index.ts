// Connector edition: talk to a muse-web engine you run yourself. This package never starts a
// browser, never reads cookie files and never spawns a process; it only speaks HTTP to
// MUSE_WEB_ENGINE (or the `engine` option). Use the full magpie-muse-web package when you want
// the bundled engine.
//
// This file is published on its own (package `files` ships only index.ts), so the transport and
// identity rules it needs cannot be imported from `engine/`. They are kept byte-for-byte in step
// with `engine/local-fetch.ts` and `engine/health.ts` in the parent package; `connector/security.test.ts`
// drives the same allow/refuse matrix so the two editions cannot drift apart silently.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"

const PROVIDER = "muse-web"
const MODEL = "muse-spark"
const CONTROL_TIMEOUT_MS = 10_000
const LOGIN_LIMIT_MS = 18 * 60_000
const REFRESH_LEAD_MS = 10 * 60_000
const CONTEXT_TOKENS = 128_000
const OUTPUT_TOKENS = 16_000
const DEFAULT_ENGINE = "http://127.0.0.1:18611"
const HEALTH_TIMEOUT_MS = 1500
// How long a port's health proof is trusted before it is asked again.
const PROOF_TTL_MS = 30_000
const CHALLENGE_HEADER = "x-muse-challenge"
const HEALTH_PREFIX = "muse-web-health:"
const ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjNkQ1QkZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRTI1NDlBIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTUiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNMTQgNDdWMjFsMTIuNSAxNUwzOSAyMXYyNiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjYuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHBhdGggZD0iTTQ5LjUgOS41bDIuMyA2LjIgNi4yIDIuMy02LjIgMi4zLTIuMyA2LjItMi4zLTYuMi02LjItMi4zIDYuMi0yLjN6IiBmaWxsPSIjZmZmIi8+PC9zdmc+"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"])

function isLoopbackUrl(value: unknown): boolean {
  try {
    return LOOPBACK.has(new URL(String(value)).hostname)
  } catch {
    return false
  }
}

// engine.key and account handles are credentials. They may travel in the clear only to this
// machine; anywhere else the carrier has to be https. Same rule as `credentialSafeUrl()` in
// `engine/local-fetch.ts`.
function credentialSafeUrl(value: unknown): boolean {
  if (isLoopbackUrl(value)) return true
  try {
    return new URL(String(value)).protocol === "https:"
  } catch {
    return false
  }
}

function abortError(signal: any) {
  if (signal?.reason instanceof Error) return signal.reason
  return Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
}

function redirectRefused(status: number, location?: string) {
  return Object.assign(new Error(`engine answered with a redirect (HTTP ${status}), refused`), {
    name: "EngineRedirectError",
    code: "engine_redirect_refused",
    location: location || "",
  })
}

// Loopback goes through node:http(s) directly, so an HTTP(S)_PROXY in the environment never sees
// the key; a named remote engine goes through global fetch. Either way a redirect is refused
// instead of chased, since it could carry the account handle to an origin never vetted here.
function engineFetch(input: any, init: any = {}): Promise<Response> {
  const options = init && typeof init === "object" ? init : {}
  if (!isLoopbackUrl(input)) return fetch(input, options.redirect ? options : { ...options, redirect: "error" })
  let url: URL
  try {
    url = input instanceof URL ? input : new URL(String(input))
  } catch {
    return Promise.reject(new TypeError(`invalid URL: ${input}`))
  }
  const lib = url.protocol === "https:" ? https : http
  const headers: Record<string, string> = {}
  for (const [name, value] of new Headers(options.headers)) headers[name] = value
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "identity"
  const method = String(options.method || "GET").toUpperCase()
  const signal = options.signal || undefined
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers, agent: false, signal }, (res) => {
      const status = res.statusCode || 502
      if (status >= 300 && status < 400) {
        res.resume()
        req.destroy()
        reject(redirectRefused(status, res.headers.location))
        return
      }
      const out = new Headers()
      for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      const bodyless = method === "HEAD" || status === 204 || status === 304
      resolve(new Response(bodyless ? null : Readable.toWeb(res), {
        status,
        statusText: res.statusMessage || "",
        headers: out,
      }))
    })
    req.on("error", reject)
    const body = options.body
    if (body == null) req.end()
    else if (typeof body === "string") req.end(body)
    else if (Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(body)
    else if (typeof body.pipe === "function") body.pipe(req)
    else if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) Readable.fromWeb(body).pipe(req)
    else req.end(String(body))
  })
}

function healthChallenge(): string {
  return randomBytes(16).toString("hex")
}

// Byte-for-byte with `engine/health.ts`, which the engine answers with.
function healthProof(key: string, nonce: string): string {
  return createHmac("sha256", key).update(HEALTH_PREFIX + nonce).digest("hex")
}

function provesHealth(body: any, key: string, nonce: string): boolean {
  const got = typeof body?.proof === "string" ? body.proof.trim().toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(got)) return false
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(healthProof(key, nonce), "hex"))
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
  return windows.filter((item) => {
    return item && typeof item.name === "string" && item.name.trim() !== "" && typeof item.used === "number" && item.used >= 0 && item.used <= 100
  })
}

export const MuseWebConnectorPlugin = async (_input: any = {}, options: any = {}) => {
  const opt = options && typeof options === "object" ? options : {}
  const namedEngine = () => String(opt.engine || process.env.MUSE_WEB_ENGINE || "").trim()
  const engineOrigin = () => originFrom(namedEngine() || DEFAULT_ENGINE)
  const engineBaseURL = () => `${engineOrigin()}/v1`
  const engineKey = () => String(opt.key ?? process.env.MUSE_WEB_ENGINE_KEY ?? "").trim()

  // Why a named engine may not receive a credential, or "" when it may. The connector's whole
  // point is pointing at an engine you run elsewhere, so this is the case the transport rule
  // exists for: a plain-http LAN or domain address would put engine.key on the wire in the clear.
  const originTrouble = () => {
    if (!namedEngine() || credentialSafeUrl(engineOrigin())) return ""
    return `引擎地址 ${engineOrigin()} 既不是本机回环地址，也不是 https。engine.key 和账号句柄只会发给回环或 https 端口；请改用 https 证书，或让引擎跑在 127.0.0.1。`
  }

  // When the port last proved it holds this engine's key.
  let verifiedAt = 0

  // Asks the engine to prove it holds engine.key: send a nonce, check the HMAC only a key holder
  // can make. A port that answers in the engine's name but cannot prove itself is never handed
  // the key — the same gate the full edition uses before it sends a credential anywhere.
  async function inspect(): Promise<{ ours: boolean; answered: boolean }> {
    if (originTrouble()) return { ours: false, answered: false }
    const key = engineKey()
    if (!key) return { ours: false, answered: false }
    const nonce = healthChallenge()
    try {
      const res = await engineFetch(`${engineOrigin()}/v1/health`, {
        headers: { [CHALLENGE_HEADER]: nonce },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      const body = res.ok ? await res.json() as any : null
      if (body?.engine !== "muse-web") return { ours: false, answered: true }
      if (provesHealth(body, key, nonce)) {
        verifiedAt = Date.now()
        return { ours: true, answered: true }
      }
      return { ours: false, answered: true }
    } catch {
      return { ours: false, answered: false }
    }
  }

  // True only when the port may be sent engine.key and account handles.
  async function ours(): Promise<boolean> {
    if (originTrouble()) return false
    if (Date.now() - verifiedAt < PROOF_TTL_MS) return true
    return (await inspect()).ours
  }

  async function control(pathname, method, handle) {
    // Never hand engine.key (or an account handle) to a port that has not proven it is ours.
    if (!(await ours())) return null
    try {
      return await engineFetch(`${engineOrigin()}${pathname}`, {
        method,
        headers: engineHeaders(engineKey(), handle),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      })
    } catch {
      return null
    }
  }

  function unreachable() {
    const why = originTrouble()
    return new Error(
      why
        ? `muse-web 引擎不可以用：${why}`
        : `muse-web 引擎没有响应（${engineOrigin()}）。先启动引擎，并设置 MUSE_WEB_ENGINE / MUSE_WEB_ENGINE_KEY；引擎必须能对 /v1/health 的挑战作出自证（旧版引擎请升级）。`,
    )
  }

  async function engineLogin() {
    const res = await control("/v1/login", "POST", "")
    if (!res?.ok) throw res ? new Error(`muse-web 引擎没有开始登录（HTTP ${res.status}）`) : unreachable()
    const { id, url } = await res.json() as any
    return {
      url,
      instructions: "在弹出的浏览器窗口里登录 muse.ai。若 muse.ai 要求人机验证，请在这个窗口里完成，它不会自动关掉；通过后引擎自动继续并关闭窗口，再发一条测试消息，账号能回答才算登录成功。",
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
            // The name Magpie keys the account by: muse.ai's own id, never the sign-in time, so
            // signing in again renews this account instead of adding a look-alike. An engine too
            // old to send it is named by its label, as before.
            const accountId = state.accountId || state.label
            return {
              type: "success",
              refresh: state.handle,
              access: state.handle,
              expires,
              ...(accountId ? { accountId } : {}),
              ...(state.label?.includes("@") ? { email: state.label } : {}),
            }
          }
          if (state.status === "failed") return { type: "failed", error: `muse.ai 登录：${state.error || "没有完成"}` }
        }
        return { type: "failed", error: "muse.ai 登录：没有在时限内完成" }
      },
    }
  }

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
      refreshLead: REFRESH_LEAD_MS,
      methods: [
        { type: "oauth", label: "在已运行的引擎里登录 muse.ai", authorize: engineLogin },
        { type: "api", label: "引擎账号 ID（GET /v1/accounts 里的 id）", placeholder: "muse-xxxxxxxxxxxx" },
      ],
      async refresh(auth) {
        const handle = handleOf(auth)
        if (!handle) throw Object.assign(new Error("muse-web account has no engine handle"), { signIn: "expired" })
        const res = await control("/v1/session/refresh", "POST", handle)
        if (!res) throw unreachable()
        if (res.status === 401) throw Object.assign(new Error("session refused"), { signIn: "expired" })
        if (!res.ok) throw new Error("session refresh unavailable")
        const body = await res.json() as any
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
        if (!res) return { error: originTrouble() || "engine unreachable" }
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
            // The chat path carries both the key and the handle; gate it exactly like control().
            if (!(await ours())) throw unreachable()
            const incoming = new Headers(init?.headers)
            const headers = new Headers(engineHeaders(engineKey(), handle))
            for (const name of ["content-type", "accept", "x-muse-session"]) {
              const value = incoming.get(name)
              if (value) headers.set(name, value)
            }
            try {
              return await engineFetch(input, { method: init?.method, headers, body: init?.body, signal: init?.signal })
            } catch {
              throw unreachable()
            }
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

export const MuseWebPlugin = MuseWebConnectorPlugin
