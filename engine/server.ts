// Loopback HTTP surface of the engine: chat SSE · 401 sign-in expired · 429 account busy ·
// 503 engine trouble. The shapes here are the contract the Magpie plugin and any [OI]-compatible
// client see; the page work behind them is the driver's, reached over one JSON line per request.
import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { expiryMs } from "./accounts.ts"
import { Driver, DriverError, errDriverDown, type DriverEvent } from "./bridge.ts"
import { healthProof, validNonce } from "./health.ts"
import { ENGINE_NAME, MODEL_NAME, isoMillis, timeString, type Logger } from "./log.ts"
import { loginPage } from "./login-page.ts"
import { randomHex } from "./paths.ts"
import { redact } from "./redact.ts"
import { Store } from "./store.ts"
import type { Account, Cookies, ExpiryMap } from "./types.ts"
import { VERSION } from "./version.ts"

export const USAGE_STALE_MS = 30 * 60_000
export const USAGE_AFTER_CHAT_MS = 2 * 60_000
export const MAX_REQUEST_BODY = 8 << 20
export const ENGINE_BUSY_RETRY = 1
export const LOGIN_LIMIT_MINUTES = 15
export const OPEN_IN_FLIGHT = 4
export const KEYED_IN_FLIGHT = 64

export class HttpError extends Error {
  status: number
  code: string
  retry: number

  constructor(status: number, message: string, code: string, retry = 0) {
    super(message)
    this.status = status
    this.code = code
    this.retry = retry
  }
}

function fail(status: number, message: string, code: string): HttpError {
  return new HttpError(status, message, code)
}

// Turns the page's own words into something a gateway can act on: wait for the VM, retry now, or
// re-sign-in.
export function generationCode(text: string): [string, number] {
  const lower = String(text || "").toLowerCase()
  // A person has to re-link the workspace on muse.ai; waiting and retrying both waste time.
  if (text.includes("解除关联") || lower.includes("unlinked")) return ["account_unlinked", 3600]
  if (text.includes("预热") || lower.includes("warming")) return ["vm_warming", 10]
  if (text.includes("页面") || lower.includes("page") || text.includes("加载")) return ["page_unavailable", 10]
  if (text.includes("超时") || lower.includes("timeout")) return ["upstream_timeout", 5]
  if (text.includes("没有发出去") || lower.includes("send")) return ["send_failed", 2]
  return ["engine_unavailable", 5]
}

// Remembers whether the status line has gone out, so an error after streaming starts becomes an
// event instead of a second header block.
class Answer {
  private res: ServerResponse
  status = 200
  wrote = false

  constructor(res: ServerResponse) {
    this.res = res
  }

  // The request signal watches this response to learn when the client went away.
  serverResponse(): ServerResponse {
    return this.res
  }

  header(status: number, contentType: string, extra: Record<string, string> = {}): void {
    this.status = status
    this.wrote = true
    this.res.setHeader("content-type", contentType)
    // Answers here carry account handles, usage numbers and a stream of live replies. Never let a
    // browser guess the type, and never let anything cache them; callers may pick a stricter
    // cache-control (the SSE stream keeps its own no-cache).
    this.res.setHeader("x-content-type-options", "nosniff")
    if (!("cache-control" in extra)) this.res.setHeader("cache-control", "no-store")
    for (const [name, value] of Object.entries(extra)) this.res.setHeader(name, value)
    this.res.writeHead(status)
  }

  json(status: number, body: unknown): void {
    let data: string
    try {
      data = JSON.stringify(body)
    } catch {
      data = JSON.stringify({ error: { message: "could not encode the answer", type: "engine_error" } })
      status = 500
    }
    this.header(status, "application/json; charset=utf-8", { "content-length": String(Buffer.byteLength(data)) })
    this.res.end(data)
  }

  fail(err: unknown): void {
    let status = 500
    let code = ""
    let retry = 0
    if (err instanceof HttpError) {
      status = err.status
      code = err.code
      retry = err.retry
    }
    let kind = "engine_error"
    if (status === 401) kind = "authentication_error"
    else if (status === 429) kind = "rate_limit_error"
    else if (status >= 400 && status < 500) kind = "invalid_request_error"
    const detail: Record<string, unknown> = { message: redact((err as any)?.message || err), type: kind }
    if (code) detail.code = code
    const data = JSON.stringify({ error: detail })
    const extra: Record<string, string> = { "content-length": String(Buffer.byteLength(data)) }
    if (retry > 0) extra["retry-after"] = String(Math.max(1, Math.trunc(retry + 0.999)))
    this.header(status, "application/json; charset=utf-8", extra)
    this.res.end(data)
  }

  event(payload: unknown): void {
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  // Writes text as-is, after header() has put the status line out: the login page is the one body
  // this port sends that is not JSON or an event.
  raw(text: string): void {
    this.res.write(text)
  }

  // Kept as a no-op: Node writes each event immediately, and a streaming client is served by the
  // socket's own flush. The method exists so the ported call sites stay readable.
  flush(): void {}

  // Ends a streamed response once the last event is out. Without this the client keeps waiting for
  // more of the body and the connection stays open forever.
  end(): void {
    this.res.end()
  }
}

// Frames one chat completion as server-sent events.
class ChatWriter {
  answer: Answer
  id: string
  created: number
  started = false
  shown = ""

  constructor(answer: Answer, id: string, created: number) {
    this.answer = answer
    this.id = id
    this.created = created
  }

  chunk(delta: unknown, finish: unknown): void {
    this.answer.event({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: MODEL_NAME,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })
  }

  begin(): void {
    if (this.started) return
    this.answer.header(200, "text/event-stream; charset=utf-8", { "cache-control": "no-cache", connection: "keep-alive" })
    this.started = true
    this.chunk({ role: "assistant", content: "" }, null)
  }
}

type Meta = { account: string; session: string; reason: string; timing: string; tools: string }

type Route = {
  method: string
  pattern: string
  match?: (pathname: string) => [string, boolean]
  auth: boolean
  free?: boolean
  handle: (engine: Engine, answer: Answer, req: IncomingMessage, meta: Meta, param: string) => Promise<unknown> | unknown
}

// An id of the shape login_start hands out (9 random bytes in base64url, so 12 characters of the
// alphabet below). Checking the shape here rather than inside a handler means a made-up path is a
// plain 404 and never reaches the driver.
export function validLoginID(id: string): boolean {
  if (id.length < 8 || id.length > 32) return false
  return /^[A-Za-z0-9_-]+$/.test(id)
}

function matchLoginID(prefix: string): (pathname: string) => [string, boolean] {
  return (pathname) => {
    if (!pathname.startsWith(prefix)) return ["", false]
    const id = pathname.slice(prefix.length)
    return [id, validLoginID(id)]
  }
}

// A page that reached the port through DNS rebinding still carries its own domain in Host, so
// accepting only loopback names keeps any unauthenticated GET from becoming readable by it.
export function loopbackHost(hostport: string): boolean {
  let host = String(hostport || "").toLowerCase().trim()
  if (host.endsWith(".")) host = host.slice(0, -1)
  // Strip the port. An IPv6 literal keeps its brackets; a bare "::1" has several colons and no
  // port, so the colon rule must not eat it.
  if (host.startsWith("[")) {
    const at = host.indexOf("]")
    if (at >= 0) host = host.slice(0, at + 1)
  } else {
    const at = host.lastIndexOf(":")
    if (at >= 0 && !host.slice(0, at).includes(":")) host = host.slice(0, at)
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0"
}

function sameSecret(given: string, want: string): boolean {
  const a = Buffer.from(given, "utf8")
  const b = Buffer.from(want, "utf8")
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isAbort(err: unknown): boolean {
  return (err as any)?.name === "AbortError"
}

function budget(size: number) {
  let used = 0
  return {
    take(): (() => void) | null {
      if (used >= size) return null
      used++
      let done = false
      return () => {
        if (done) return
        done = true
        used--
      }
    },
    // Read by the admission tests, which occupy every token and then check the answer releases
    // them again; nothing in the engine needs the count.
    used(): number {
      return used
    },
  }
}

export type EngineConfig = { port: number; key: string }

export class Engine {
  cfg: EngineConfig
  log: Logger
  store: Store
  drv: Driver
  table: Route[]

  private busy = new Set<string>()
  private idling = false
  // Both budgets stay public so a test can hold every token and prove the refusal path without
  // keeping that many real requests open. Nothing outside this file takes from them.
  open = budget(OPEN_IN_FLIGHT)
  keyed = budget(KEYED_IN_FLIGHT)
  private lastUse = Date.now()

  // Set by main.ts: the one way the engine leaves its loop, whatever asked it to.
  stop: ((why: string) => void) | null = null

  constructor(cfg: EngineConfig, log: Logger, store: Store, drv: Driver) {
    this.cfg = cfg
    this.log = log
    this.store = store
    this.drv = drv
    this.table = routes()
  }

  touch(): void { this.lastUse = Date.now() }
  idleFor(): number { return Date.now() - this.lastUse }
  isBusy(id: string): boolean { return this.busy.has(id) }

  acquire(id: string): boolean {
    if (this.idling || this.busy.has(id)) return false
    this.busy.add(id)
    return true
  }

  beginIdle(): boolean {
    if (this.idling || this.busy.size !== 0) return false
    this.idling = true
    return true
  }

  endIdle(): void { this.idling = false }

  setBusy(id: string, busy: boolean): void {
    if (busy) this.busy.add(id)
    else this.busy.delete(id)
  }

  private authorize(req: IncomingMessage): void {
    const header = String(req.headers.authorization || "")
    let token = ""
    if (header.length > 7 && header.slice(0, 7).toLowerCase() === "bearer ") token = header.slice(7).trim()
    if (!token || !sameSecret(token, this.cfg.key)) throw fail(401, "bad engine key", "engine_key_invalid")
  }

  private account(req: IncomingMessage): Account {
    const id = String(req.headers["x-muse-account"] || "").trim()
    if (!id) throw fail(400, "missing X-Muse-Account", "account_missing")
    const acct = this.store.get(id)
    if (!acct) throw fail(401, "unknown account; sign in again", "account_unknown")
    return acct
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now()
    this.touch()
    const answer = new Answer(res)
    const meta: Meta = { account: "", session: "", reason: "", timing: "", tools: "" }
    let error: unknown = null
    // The Host header check goes before any routing: a page that reached this port through DNS
    // rebinding still names its own domain here, and the unauthenticated health answer and login
    // progress page must not become readable by it.
    if (!loopbackHost(String(req.headers.host || ""))) {
      error = fail(403, "requests must address 127.0.0.1 or localhost", "host_not_allowed")
    } else {
      try {
        await this.route(answer, req, meta)
      } catch (err) {
        error = err
      }
    }
    if (error) {
      meta.reason = redact((error as any)?.message || error)
      if (!answer.wrote) answer.fail(error)
    }
    this.touch()
    const pathname = pathOf(req)
    let line = `${timeString()} ${answer.status} ${req.method || "GET"} ${pathname}`
    if (meta.account) line += ` account=${meta.account}`
    if (meta.session) line += ` session=${meta.session.slice(0, 12)}`
    line += ` ${Date.now() - started}ms`
    if (meta.timing) line += ` ${meta.timing}`
    if (meta.tools) line += ` tools=${meta.tools}`
    if (meta.reason) line += ` reason=${meta.reason}`
    this.log.log(line)
  }

  private async route(answer: Answer, req: IncomingMessage, meta: Meta): Promise<void> {
    const pathname = pathOf(req)
    // Dispatch is one walk over a table built once at start-up. Authorization is decided by the
    // row, not by remembering to call authorize() inside a handler: a new endpoint that declares
    // auth: true is guarded before its handler can read a byte of the body.
    for (const route of this.table) {
      if (req.method !== route.method) continue
      let param = ""
      let ok = false
      if (!route.match) ok = pathname === route.pattern
      else [param, ok] = route.match(pathname)
      if (!ok) continue
      if (route.auth) this.authorize(req)
      // Admission comes after authorization and before the handler: a caller with a wrong key
      // spends constant time and never holds a token, so guessing keys cannot crowd out real work.
      let release: (() => void) | null = null
      if (!route.free) {
        const which = route.auth ? this.keyed : this.open
        release = which.take()
        if (!release) throw new HttpError(503, "engine is handling too many requests", "engine_busy", ENGINE_BUSY_RETRY)
      }
      try {
        await route.handle(this, answer, req, meta, param)
      } finally {
        release?.()
      }
      return
    }
    throw fail(404, "not found", "not_found")
  }

  // The answer stays deliberately thin: this endpoint is unauthenticated, so any local user can
  // ask it. "An engine is up and which version" is what a caller needs; how many accounts live in
  // this data directory is not, and the count is behind the key at /v1/accounts.
  handleHealth(answer: Answer, req: IncomingMessage): void {
    const body: Record<string, unknown> = { ok: true, engine: ENGINE_NAME, version: VERSION }
    const nonce = String(req.headers["x-muse-challenge"] || "").trim()
    if (validNonce(nonce)) body.proof = healthProof(this.cfg.key, nonce)
    answer.json(200, body)
  }

  handleModels(answer: Answer): void {
    answer.json(200, { object: "list", data: [{ id: MODEL_NAME, object: "model", owned_by: "muse.ai" }] })
  }

  handleAccounts(answer: Answer): void {
    const accounts = []
    for (const id of this.store.handles()) {
      const acct = this.store.get(id)
      if (!acct) continue
      accounts.push({ id, label: acct.label, expires: expiryMs(acct.cookies_exp) })
    }
    answer.json(200, { accounts })
  }

  async chat(answer: Answer, req: IncomingMessage, meta: Meta): Promise<void> {
    const raw = await readBody(req)
    let payload: any = {}
    if (raw.length > 0) {
      try { payload = JSON.parse(raw.toString("utf8")) } catch { throw fail(400, "invalid JSON body", "invalid_json") }
    }
    if (!Array.isArray(payload?.messages) || payload.messages.length === 0) throw fail(400, "messages is empty", "invalid_request")
    const acct = this.account(req)
    meta.account = acct.id
    if (!this.acquire(acct.id)) throw new HttpError(429, "account busy", "account_busy", ENGINE_BUSY_RETRY)
    const signal = requestSignal(req, answer.serverResponse())
    try {
      const session = String(req.headers["x-muse-session"] || "").trim()
      meta.session = session
      const stream = payload.stream == null || Boolean(payload.stream)
      const id = "chatcmpl-" + mustHex(16)
      const created = Math.floor(Date.now() / 1000)
      const out = new ChatWriter(answer, id, created)
      const timing: Record<string, any> = {}
      let final: DriverEvent
      try {
        final = await this.drv.stream(signal, "chat_stream", {
          account: acct,
          messages: payload.messages,
          tools: payload.tools,
          tool_choice: payload.tool_choice,
          conversation: session,
          stream,
        }, (event) => {
          if (event.ev === "delta") {
            if (!stream || !event.text) return
            out.begin()
            out.chunk({ content: event.text }, null)
            out.shown += event.text
          } else if (event.ev === "meta") {
            if (event.how) timing.how = event.how
            if (event.sent) timing.sent = event.sent
            if (event.tabMs != null) timing.tabMs = event.tabMs
            if (event.firstMs != null) timing.firstMs = event.firstMs
          }
        })
      } catch (err) {
        meta.timing = timingLine(timing)
        await this.chatFailure(out, acct, session, err, meta)
        return
      }
      meta.timing = timingLine(timing)
      if (!signal.aborted) this.afterChatUsage(acct, USAGE_AFTER_CHAT_MS)

      const calls = Array.isArray(final.calls) ? final.calls : []
      const finish = calls.length ? "tool_calls" : "stop"
      meta.tools = final.tools || ""
      const toolCalls = calls.map((call) => ({
        id: "call_" + mustHex(12),
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }))

      if (!stream) {
        const message: Record<string, unknown> = { role: "assistant" }
        if (toolCalls.length) {
          message.content = final.content && final.content !== "" ? final.content : null
          message.tool_calls = toolCalls
        } else {
          message.content = final.text || ""
        }
        answer.json(200, {
          id,
          object: "chat.completion",
          created,
          model: MODEL_NAME,
          choices: [{ index: 0, message, finish_reason: finish }],
        })
        return
      }

      out.begin()
      toolCalls.forEach((call, index) => {
        out.chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } }] }, null)
        out.chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }, null)
      })
      out.chunk({}, finish)
      answer.raw("data: [DONE]\n\n")
      answer.end()
    } finally {
      this.setBusy(acct.id, false)
    }
  }

  // Maps the driver's classification onto the status the client expects, and turns a failure after
  // the first byte into an event instead of a header rewrite.
  private async chatFailure(out: ChatWriter, acct: Account, session: string, err: unknown, meta: Meta): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      await this.drv.do(controller.signal, "close_tab", { account: acct, conversation: session })
    } catch {} finally {
      clearTimeout(timer)
    }
    if (isAbort(err)) return
    const kind = err instanceof DriverError ? err.kind : ""
    const message = (err as any)?.message || String(err)
    let mapped: HttpError
    switch (kind) {
      case "auth":
        mapped = fail(401, message, "session_expired")
        break
      case "quota":
        this.afterChatUsage(acct, 0)
        mapped = new HttpError(429, message, "quota_spent", 60)
        break
      case "prompt_too_long":
        mapped = fail(413, message, "prompt_too_long")
        break
      case "account_unlinked":
        mapped = new HttpError(503, message, "account_unlinked", 3600)
        break
      case "invalid_request":
        mapped = fail(400, message, "invalid_request")
        break
      case "busy":
        mapped = new HttpError(429, message, "account_busy", 1)
        break
      case "tool_call_not_parsed":
        mapped = fail(422, message, "tool_call_not_parsed")
        break
      case "generation": {
        const [code, retry] = generationCode(message)
        mapped = new HttpError(503, message, code, retry)
        break
      }
      default: {
        if (kind === "" && !out.started) {
          const [code, retry] = generationCode(message)
          throw new HttpError(503, message, code, retry)
        }
        mapped = new HttpError(503, message, "engine_unavailable", 5)
      }
    }
    if (!out.started) throw mapped
    out.answer.event({ error: { message: redact(message), type: "engine_error", code: "stream_interrupted" } })
    out.answer.raw("data: [DONE]\n\n")
    out.answer.end()
    meta.reason = meta.reason || redact(message)
  }

  // Lets what the answer spent show on the card soon after, at most every 2 minutes.
  private afterChatUsage(acct: Account, maxAgeMs: number): void {
    const timer = setTimeout(async () => {
      // A new chat may already own this account's page; reading usage now would queue behind it.
      if (this.isBusy(acct.id)) return
      const controller = new AbortController()
      const limit = setTimeout(() => controller.abort(), 30_000)
      try {
        await this.readUsage(controller.signal, acct, maxAgeMs)
      } finally {
        clearTimeout(limit)
      }
    }, 1_500)
    timer.unref?.()
  }

  async readUsage(signal: AbortSignal, acct: Account, maxAgeMs: number): Promise<void> {
    const started = Date.now()
    let out: any
    try {
      out = await this.drv.decode(signal, "read_usage", { account: acct, maxAgeMs })
    } catch (err: any) {
      this.log.log(`${timeString()} usage account=${acct.id} failed reason=${redact(err?.message || err)}`)
      return
    }
    const card = out?.usage
    if (!card) return
    const meters = (Array.isArray(card.windows) ? card.windows : []).map((w: any) => `${w.name}=${w.used}%`).join(" ")
    this.log.log(`${timeString()} usage account=${acct.id} ${Date.now() - started}ms ${meters}`)
  }

  async usage(answer: Answer, req: IncomingMessage, meta: Meta): Promise<void> {
    const acct = this.account(req)
    meta.account = acct.id
    const busy = this.isBusy(acct.id)
    let out: any
    // A driver that is down costs the meters, not the card: the account is still signed in.
    try {
    out = await this.drv.decode(requestSignal(req, answer.serverResponse()), "usage", { account: acct, busy, maxAgeMs: USAGE_STALE_MS })
    } catch (err: any) {
      this.log.log(`${timeString()} usage account=${acct.id} failed reason=${redact(err?.message || err)}`)
    }
    let status = "闲置，下一条约需 30 秒唤醒"
    if (busy) status = "正在回答"
    else if (out?.ready) status = "已就绪"
    let plan = "muse.ai"
    let windows: any[] = []
    if (out?.usage) {
      if (String(out.usage.plan || "").trim()) plan = out.usage.plan
      if (Array.isArray(out.usage.windows)) windows = out.usage.windows
    }
    const body: Record<string, unknown> = { plan: `${plan} · ${status}`, windows }
    if (acct.label) body.user = acct.label
    const until = expiryMs(acct.cookies_exp)
    if (until != null) body.until = isoMillis(until)
    answer.json(200, body)
  }

  async refresh(answer: Answer, req: IncomingMessage, meta: Meta): Promise<void> {
    const acct = this.account(req)
    meta.account = acct.id
    let out: { cookies: Cookies; cookies_exp: ExpiryMap }
    try {
    out = await this.drv.decode(requestSignal(req, answer.serverResponse()), "refresh", { account: acct })
    } catch (err: any) {
      if (err instanceof DriverError && err.kind === "auth") throw fail(401, err.message, "session_expired")
      const [code, retry] = generationCode(err?.message || String(err))
      throw new HttpError(503, err?.message || String(err), code, retry)
    }
    this.store.update(acct.id, out?.cookies ?? null, out?.cookies_exp ?? null, "")
    answer.json(200, { expires: expiryMs(out?.cookies_exp || {}) })
  }

  async loginStart(answer: Answer, req: IncomingMessage): Promise<void> {
    const raw = await readBody(req)
    let browser = ""
    if (raw.length > 0) {
      let payload: any
      try { payload = JSON.parse(raw.toString("utf8")) } catch { throw fail(400, "invalid JSON body", "invalid_json") }
      browser = String(payload?.browser || "").trim()
    }
    let out: any
    try {
      out = await this.drv.decode(requestSignal(req, answer.serverResponse()), "login_start", { browser })
    } catch (err: any) {
      throw new HttpError(503, err?.message || String(err), "engine_unavailable", 5)
    }
    answer.json(200, { id: out?.id || "", url: `http://127.0.0.1:${this.cfg.port}/login/${out?.id || ""}` })
  }

  // The driver's view of one sign-in run, or null when there is no such run.
  async loginState(signal: AbortSignal, id: string): Promise<any> {
    let raw: any
    try {
      raw = await this.drv.do(signal, "login_status", { id })
    } catch (err: any) {
      throw new HttpError(503, err?.message || String(err), "engine_unavailable", 5)
    }
    const state = raw?.state
    if (state == null) return null
    return state
  }

  async handleLoginState(answer: Answer, req: IncomingMessage, param: string): Promise<void> {
    const state = await this.loginState(requestSignal(req, answer.serverResponse()), param)
    if (state === null) throw fail(404, "no such login", "login_not_found")
    answer.json(200, state)
  }

  // This page is the one place a person — not the plugin — reaches the port without a key, so it
  // is also the cheapest thing to flood. It answers without doing any work: when no driver is up
  // nobody can be signing in, and when one is, reading its state costs a question on an open pipe.
  // Nothing here starts a process, so a stranger's GETs cannot turn this port into a browser
  // launcher or allocate a per-request driver stream.
  async handleLoginPage(answer: Answer, req: IncomingMessage, param: string): Promise<void> {
    let state: any = null
    if (this.drv.running()) {
      try { state = await this.loginState(requestSignal(req, answer.serverResponse()), param) } catch {}
    }
    // The progress page is opened by a person in their own browser: keep it out of frames, out of
    // caches and out of any third-party request. It needs no script at all, only inline styles.
    answer.header(200, "text/html; charset=utf-8", {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    })
    answer.raw(loginPage(state))
    answer.end()
  }

  handleShutdown(answer: Answer): void {
    answer.json(200, { ok: true })
    const stop = this.stop
    if (stop) {
      const timer = setTimeout(() => stop("asked to stop"), 100)
      timer.unref?.()
    }
  }
}

function routes(): Route[] {
  return [
    { method: "GET", pattern: "/v1/health", auth: false, free: true, handle: (e, answer, req) => e.handleHealth(answer, req) },
    { method: "GET", pattern: "/v1/models", auth: true, handle: (e, answer) => e.handleModels(answer) },
    { method: "GET", pattern: "/v1/accounts", auth: true, handle: (e, answer) => e.handleAccounts(answer) },
    { method: "POST", pattern: "/v1/chat/completions", auth: true, handle: (e, answer, req, meta) => e.chat(answer, req, meta) },
    { method: "POST", pattern: "/v1/session/refresh", auth: true, handle: (e, answer, req, meta) => e.refresh(answer, req, meta) },
    { method: "GET", pattern: "/v1/usage", auth: true, handle: (e, answer, req, meta) => e.usage(answer, req, meta) },
    { method: "POST", pattern: "/v1/shutdown", auth: true, handle: (e, answer) => e.handleShutdown(answer) },
    { method: "POST", pattern: "/v1/login", auth: true, handle: (e, answer, req) => e.loginStart(answer, req) },
    { method: "GET", pattern: "/v1/login/{id}", auth: true, match: matchLoginID("/v1/login/"), handle: (e, answer, req, _meta, param) => e.handleLoginState(answer, req, param) },
    { method: "GET", pattern: "/login/{id}", auth: false, match: matchLoginID("/login/"), handle: (e, answer, req, _meta, param) => e.handleLoginPage(answer, req, param) },
  ]
}

function pathOf(req: IncomingMessage): string {
  // req.url is the request target; the ported rules are about the path, not the query.
  const url = String(req.url || "/")
  const at = url.indexOf("?")
  return at < 0 ? url : url.slice(0, at)
}

function requestSignal(req: IncomingMessage, res: ServerResponse): AbortSignal {
  // The abort the Go engine got from r.Context(): the client went away mid-request. IncomingMessage
  // 'close' is the wrong signal for that — it also fires once the request body has been fully read,
  // which would cancel every chat right after readBody. The response's 'close' with writableEnded
  // still false is the real disconnect, and a normal end() sets writableEnded first.
  //
  // The response is the only source of truth here: req.destroyed turns true as soon as the request
  // body has been consumed, so asking the request whether the client is still there always answers
  // no and would abort every streamed answer before its first event.
  const controller = new AbortController()
  if (res.destroyed && !res.writableEnded) controller.abort()
  res.on("close", () => {
    if (!res.writableEnded) controller.abort()
  })
  return controller.signal
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any)
    total += buf.length
    if (total > MAX_REQUEST_BODY) throw fail(413, "request too large", "request_too_large")
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export function timingLine(timing: Record<string, any>): string {
  const parts: string[] = []
  if (typeof timing.how === "string" && timing.how) parts.push(`tab=${timing.how}`)
  if (typeof timing.sent === "string" && timing.sent) parts.push(`sent=${timing.sent}`)
  if (typeof timing.tabMs === "number") parts.push(`page=${Math.round(timing.tabMs)}ms`)
  if (typeof timing.firstMs === "number") parts.push(`first=${Math.round(timing.firstMs)}ms`)
  return parts.join(" ")
}

function mustHex(n: number): string {
  try { return randomHex(n) } catch { return "0".repeat(n * 2) }
}
