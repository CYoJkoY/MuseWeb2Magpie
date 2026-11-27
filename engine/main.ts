// The engine process: it holds the loopback port, keeps the account store, and supervises the
// browser driver. Everything that has to evaluate JavaScript inside muse.ai's page lives in
// engine/driver.ts; everything that can be decided from HTTP alone lives here, so the process that
// owns the port needs no browser of its own to start answering.
import { timingSafeEqual } from "node:crypto"
import { mkdirSync, realpathSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { Driver } from "./bridge.ts"
import { healthProof } from "./health.ts"
import { anyFetch } from "./local-fetch.ts"
import { Logger, timeString } from "./log.ts"
import { watchParent } from "./parent.ts"
import { dataDir, engineKey, enginePort, randomHex } from "./paths.ts"
import { redact } from "./redact.ts"
import { Engine } from "./server.ts"
import { Store } from "./store.ts"
import type { Account } from "./types.ts"
import { VERSION } from "./version.ts"

// Caps how many usage reads run at once during a cold start. Each read opens its own tab, so a
// small pool keeps a large saved set from flooding the browser.
const PREWARM_USAGE_PARALLEL = 3
// Bounds how long one request may take to arrive — headers and body together. Any user on the
// machine can reach 127.0.0.1, and only this user can read engine.key; a request without the key is
// rejected before its body is read, so a deadline keeps a connection that trickles bytes from
// pinning the process. Chat bodies are a few KB of JSON and never come close; responses (SSE
// included) are not bounded by it.
const READ_TIMEOUT_MS = 30_000
const MAX_HEADER_BYTES = 32 << 10
const IDLE_TIMEOUT_MS = 60_000
const KEEPALIVE_EVERY_MS = 30 * 60_000
const KEEPALIVE_DUE_MS = 6 * 3_600_000

export type Config = {
  dir: string
  port: number
  key: string
  idleMs: number
  prewarm: boolean
  parentPID: number
}

// Go's strconv.ParseFloat rejects padding and empty input; Number() accepts " 12 " as 12 and ""
// as 0. The idle window is only ever a plain number in practice, so a finite product is enough.
function loadConfig(): Config {
  let home = ""
  try {
    home = os.homedir()
  } catch {
    home = ""
  }
  if (!home && !process.env.MUSE_WEB_HOME) throw new Error("cannot find the home directory; set MUSE_WEB_HOME")
  let idleMinutes = Number(String(process.env.MUSE_WEB_IDLE_MIN ?? ""))
  if (!(Number.isFinite(idleMinutes) && idleMinutes > 0 && idleMinutes <= 525_600)) idleMinutes = 60
  const parent = Number.parseInt(String(process.env.MUSE_WEB_PARENT_PID ?? ""), 10)
  return {
    dir: dataDir(),
    port: enginePort(),
    key: "",
    idleMs: Math.round(idleMinutes * 60_000),
    prewarm: process.env.MUSE_WEB_PREWARM !== "0",
    parentPID: Number.isInteger(parent) ? parent : 0,
  }
}

// The one place the loopback listener's limits are set, so a test can read them instead of
// trusting a literal buried in run().
export function newHTTPServer(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void): http.Server {
  const server = handler
    ? http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler)
    : http.createServer({ maxHeaderSize: MAX_HEADER_BYTES })
  server.headersTimeout = READ_TIMEOUT_MS
  server.requestTimeout = READ_TIMEOUT_MS
  server.keepAliveTimeout = IDLE_TIMEOUT_MS
  return server
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening)
      reject(err)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })
}

async function run(): Promise<void> {
  const cfg = loadConfig()
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 })
  const log = new Logger(cfg.dir, process.stderr)
  cfg.key = engineKey(cfg.dir)
  const store = new Store(path.join(cfg.dir, "accounts.json"))

  const server = newHTTPServer()
  try {
    await listen(server, cfg.port)
  } catch (err: any) {
    // The port is already served by another engine that shares this data directory — one that can
    // prove it holds the same engine.key. A squatter answering in the engine's name cannot, so its
    // port stays unavailable instead of being adopted.
    if (err?.code === "EADDRINUSE" && (await sameEngine(cfg.port, cfg.key))) {
      log.log(`another muse-web engine already serves port ${cfg.port}; leaving it running`)
      return
    }
    throw new Error(`port ${cfg.port} unavailable; set MUSE_WEB_ENGINE_PORT: ${err?.message || err}`)
  }

  const ctx = new AbortController()
  const done = new Promise<void>((resolve) => server.once("close", () => resolve()))
  const drv = new Driver(log)
  const e = new Engine(cfg, log, store, drv)
  server.on("request", (req, res) => {
    void e.handle(req, res)
  })

  const woken = new Map<string, number>()
  for (const handle of store.handles()) woken.set(handle, Date.now())

  drv.setHandler((request, params) => {
    switch (request) {
      case "store.get":
        return store.get(String(params?.handle || "")) ?? null
      case "store.add":
        return store.add(params?.cookies || {}, params?.cookies_exp || {}, String(params?.label || ""), String(params?.vm || ""))
      case "store.update":
        store.update(String(params?.handle || ""), params?.cookies ?? null, params?.cookies_exp ?? null, String(params?.vm || ""))
        return null
      case "store.remove":
        store.remove(String(params?.handle || ""))
        return null
      case "woken":
        woken.set(String(params?.handle || ""), Date.now())
        return null
      default:
        throw new Error(`unknown driver callback: ${request}`)
    }
  })
  // The driver reports a sign-in it saved into that account's browser context; the store keeps it.
  drv.setCookiesHandler((event) => {
    store.update(event.handle, event.cookies, event.cookies_exp, event.vm)
  })

  let stopped = false
  const stop = (why: string): void => {
    if (stopped) return
    stopped = true
    log.log(`${timeString()} engine stopping (${why})`)
    ctx.abort()
    server.close()
    // Node's server.close() stops accepting but lets live sockets finish; Go's Close dropped them
    // at once, and a stopped engine should not keep a chat or a health poll waiting.
    server.closeAllConnections?.()
  }
  e.stop = stop

  // A signal is a person or the OS asking the engine to leave; both end the same way.
  const onSignal = (why: string) => () => stop(why)
  const onInterrupt = onSignal("interrupt")
  const onTerminate = onSignal("terminated")
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  // An engine the plugin started is detached, so it outlives Magpie unless it watches the process
  // that started it. A hand-started engine passes no parent and stays independent.
  watchParent(cfg.parentPID, () => stop("Magpie exited"))

  const idleTimer = setInterval(async () => {
    if (!(e.idleFor() > cfg.idleMs && e.beginIdle())) return
    const bounded = new AbortController()
    const timer = setTimeout(() => bounded.abort(), 15_000)
    try {
      await drv.do(bounded.signal, "stop", null)
    } catch {
    } finally {
      clearTimeout(timer)
    }
    e.endIdle()
  }, 60_000)
  idleTimer.unref?.()

  const keepTimer = setInterval(async () => {
    for (const handle of store.handles()) {
      const due = Date.now() - (woken.get(handle) ?? 0) >= KEEPALIVE_DUE_MS
      if (!due || !e.acquire(handle)) continue
      const acct = store.get(handle)
      if (acct) {
        woken.set(handle, Date.now())
        const bounded = new AbortController()
        const timer = setTimeout(() => bounded.abort(), 60_000)
        try {
          const kept: any = await drv.decode(bounded.signal, "keep_alive", { account: acct })
          const vmState = String(kept?.vmState || "") || "?"
          log.log(`${timeString()} keepalive account=${handle} vm=${vmState}`)
        } catch (err: any) {
          log.log(`${timeString()} keepalive account=${handle} failed reason=${redact(err?.message || err)}`)
        } finally {
          clearTimeout(timer)
        }
      }
      e.setBusy(handle, false)
    }
  }, KEEPALIVE_EVERY_MS)
  keepTimer.unref?.()

  log.log(`muse-web engine ${VERSION} listening on http://127.0.0.1:${cfg.port} · ${store.count()} accounts · data ${cfg.dir}`)
  if (cfg.prewarm && store.count() > 0) {
    void prewarm(ctx.signal, log, store, drv, e)
  }

  await done
  ctx.abort()
  process.off("SIGINT", onInterrupt)
  process.off("SIGTERM", onTerminate)
  await drv.close()
}

// Warms every saved account in parallel, then reads each card's usage through a small pool. It is
// best effort: a warm or a read that fails is logged and left to the first real request.
async function prewarm(signal: AbortSignal, log: Logger, store: Store, drv: Driver, e: Engine): Promise<void> {
  const startedAt = Date.now()
  await Promise.all(
    store.handles().map(async (handle) => {
      const acct = store.get(handle)
      if (!acct) return
      const bounded = new AbortController()
      const timer = setTimeout(() => bounded.abort(), 3 * 60_000)
      try {
        await drv.do(bounded.signal, "warm", { account: acct })
      } catch (err: any) {
        log.log(`${timeString()} warm account=${acct.id} failed reason=${redact(err?.message || err)}`)
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  const warmDone = Date.now()
  const queue: Account[] = []
  for (const handle of store.handles()) {
    const acct = store.get(handle)
    if (acct) queue.push(acct)
  }
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted || next >= queue.length) return
      await e.readUsage(signal, queue[next++], 0)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PREWARM_USAGE_PARALLEL, queue.length) }, worker))
  log.log(`${timeString()} prewarm accounts=${queue.length} warm=${warmDone - startedAt}ms total=${Date.now() - startedAt}ms`)
}

// Reports whether the port is held by another engine that shares this data directory — that is,
// one that can prove it holds the same engine.key. The proof is the HMAC only a key holder can
// answer, so a squatter that merely answers in the engine's name is not "the engine".
async function sameEngine(port: number, key: string): Promise<boolean> {
  const nonce = randomHex(16)
  try {
    const res = await anyFetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { "x-muse-challenge": nonce },
      signal: AbortSignal.timeout(2_000),
    })
    if (res.status !== 200) return false
    const body: any = await res.json()
    if (body?.engine !== "muse-web") return false
    const got = Buffer.from(String(body?.proof ?? "").trim().toLowerCase(), "utf8")
    const want = Buffer.from(healthProof(key, nonce), "utf8")
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  }
}

// Whether this file is the process entry point, so a test can import newHTTPServer without binding
// a port. argv[1] is the path as the caller typed it: on Windows the same file may arrive with
// another letter case, and a short or symlinked path names it just as well. Comparing the resolved
// paths and then the real ones is what makes `node engine\MAIN.TS` start the engine instead of
// silently doing nothing and exiting 0.
export function sameEntryPath(a: string, b: string, platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const same = sameEntryPath
  const self = fileURLToPath(import.meta.url)
  if (same(path.resolve(entry), self)) return true
  try {
    return same(realpathSync(path.resolve(entry)), realpathSync(self))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  run().catch((err: any) => {
    process.stderr.write(redact(err?.message || String(err)) + "\n")
    process.exit(1)
  })
}
