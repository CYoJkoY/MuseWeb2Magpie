// The HTTP engine and the browser driver are separate Node processes. This bridge owns their
// newline-delimited JSON protocol: it starts a driver only when needed, keeps requests associated
// with one generation of that process, and answers callbacks the driver makes into the account
// store.
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import process from "node:process"
import readline from "node:readline"
import { LineWriter, Logger, timeString } from "./log.ts"
import { redact } from "./redact.ts"

export const errDriverDown = new Error("muse-web driver is not running")

// The caller's own reason when it cancelled, in the shape the HTTP layer tests for ("AbortError").
function abortReason(signal: AbortSignal): Error {
  // A bare AbortController.abort() hands back a DOMException, which is not an Error on every Node
  // this plugin supports; the name is what callers test, so carry it over either way.
  const reason: any = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(String(reason?.message || "This operation was aborted"))
  error.name = String(reason?.name || "AbortError")
  return error
}

export class DriverError extends Error {
  kind: string

  constructor(kind: string, message: string) {
    super(message || "engine unavailable")
    this.kind = kind
  }
}

type DriverEvent = {
  id?: string
  rid?: string
  ev?: string
  req?: string
  params?: any
  value?: any
  error?: string
  kind?: string
  message?: string
  line?: string
  why?: string
  version?: string
  handle?: string
  cookies?: Record<string, string>
  cookies_exp?: Record<string, number>
  vm?: string
  text?: string
  content?: string
  calls?: Array<{ name: string; arguments: string }>
  tools?: string
  how?: string
  sent?: string
  tabMs?: number
  firstMs?: number
}

type Waiting = {
  queue: DriverEvent[]
  wake: (() => void) | null
  closed: boolean
}

type DriverHandler = (request: string, params: any) => Promise<any> | any
type CookieHandler = (event: { handle: string; cookies: Record<string, string>; cookies_exp: Record<string, number>; vm: string }) => Promise<void> | void

export class Driver {
  private log: Logger
  private handler: DriverHandler | null
  private cookiesHandler: CookieHandler | null
  private startLock: Promise<void> | null = null
  private stateLock = false
  private stdin: NodeJS.WritableStream | null = null
  private child: ChildProcess | null = null
  private exited: Promise<void> | null = null
  private finishExit: (() => void) | null = null
  private generation = 0
  private gone = Promise.resolve()
  private finishGone: (() => void) | null = null
  private started = false
  private closed = false
  private failed: Error | null = null
  private failedAt = 0
  private pending = new Map<string, Waiting>()
  private sequence = 0
  private writeLock: Promise<void> = Promise.resolve()

  constructor(log: Logger, handler: DriverHandler | null = null, cookiesHandler: CookieHandler | null = null) {
    this.log = log
    this.handler = handler
    this.cookiesHandler = cookiesHandler
  }

  setHandler(handler: DriverHandler): void { this.handler = handler }
  setCookiesHandler(handler: CookieHandler): void { this.cookiesHandler = handler }

  private nextID(): string { return `r${++this.sequence}` }

  running(): boolean { return this.started && this.stdin !== null }

  private script(): string {
    const configured = String(process.env.MUSE_WEB_DRIVER || "").trim()
    if (configured) {
      // Existence is checked by the child process too, but this message is much more useful than
      // Node's generic ENOENT when a manually started engine points at a stale plugin directory.
      return configured
    }
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "driver.ts")
  }

  private async ensure(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw errDriverDown
    if (this.running()) return
    if (this.failed && Date.now() - this.failedAt < 3_000) throw this.failed
    if (!this.startLock) {
      this.startLock = this.start(signal).finally(() => { this.startLock = null })
    }
    return this.startLock
  }

  private async start(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw errDriverDown
    const runtime = String(process.env.MUSE_WEB_NODE || process.execPath).trim() || process.execPath
    const script = this.script()
    const child = spawn(runtime, [script], {
      env: { ...process.env, MUSE_WEB_CHILD: "1" },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams
    const generation = ++this.generation
    let resolveReady: (() => void) | null = null
    let rejectReady: ((error: Error) => void) | null = null
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const gone = new Promise<void>((resolve) => { this.finishGone = resolve })
    this.gone = gone
    this.child = child
    this.stdin = child.stdin
    this.started = true
    this.failed = null
    this.pending.clear()
    this.exited = new Promise<void>((resolve) => { this.finishExit = resolve })

    const retire = (cause: Error) => {
      if (this.generation !== generation) return
      this.stdin = null
      this.started = false
      this.failed = cause
      this.failedAt = Date.now()
      for (const waiter of this.pending.values()) {
        waiter.closed = true
        waiter.wake?.()
      }
      this.pending.clear()
      this.finishGone?.()
      this.finishGone = null
    }

    let output = Buffer.alloc(0)
    // A write to a stdin whose peer has already died raises an 'error' event on the socket. Left
    // unhandled that event crashes the engine, so retire the generation instead of throwing.
    child.stdin.on("error", (error: Error) => {
      this.log.log(`driver: stdin ${redact(error?.message || String(error))}`)
      retire(new Error(`driver: ${error?.message || "stdin closed"}`))
    })
    child.stdout.on("data", (chunk: Buffer) => {
      output = Buffer.concat([output, chunk])
      for (;;) {
        const at = output.indexOf(0x0a)
        if (at < 0) break
        const line = output.subarray(0, at).toString("utf8").replace(/\r+$/, "")
        output = output.subarray(at + 1)
        if (!line) continue
        if (Buffer.byteLength(line) > 16 << 20) {
          this.log.log(`driver: unreadable line (${Buffer.byteLength(line)} bytes)`)
          continue
        }
        let event: DriverEvent
        try { event = JSON.parse(line) } catch {
          this.log.log(`driver: unreadable line (${Buffer.byteLength(line)} bytes)`)
          continue
        }
        if (event.ev === "ready") resolveReady?.()
        else this.dispatch(event, generation)
      }
      if (output.length > 16 << 20) {
        this.log.log(`driver: unreadable line (${output.length} bytes)`)
        output = Buffer.alloc(0)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => new LineWriter(this.log).write(chunk))
    child.stdout.on("end", () => retire(new Error("driver output closed")))
    child.on("error", (error) => {
      rejectReady?.(new Error(`driver: ${error.message}`))
      retire(new Error(`driver: ${error.message}`))
    })
    child.on("exit", () => {
      retire(new Error("driver exited"))
      this.finishExit?.()
      this.finishExit = null
    })

    const timeout = setTimeout(() => {
      rejectReady?.(new Error("driver did not become ready"))
      child.kill()
    }, 60_000)
    try {
      if (signal?.aborted) throw abortReason(signal)
      await Promise.race([
        ready,
        gone.then(() => { throw new Error("driver stopped before it was ready") }),
        new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(abortReason(signal)), { once: true })),
      ])
    } catch (error: any) {
      child.kill()
      throw error instanceof Error ? error : new Error(String(error))
    } finally {
      clearTimeout(timeout)
    }
  }

  private dispatch(event: DriverEvent, generation: number): void {
    if (generation !== this.generation) return
    if (event.rid && event.req) {
      void this.answer(event)
      return
    }
    if (event.id) {
      const waiting = this.pending.get(event.id)
      if (!waiting || waiting.closed) return
      if (waiting.queue.length < 256) waiting.queue.push(event)
      waiting.wake?.()
      waiting.wake = null
      return
    }
    if (event.ev === "cookies") {
      this.log.log(`${timeString()} cookies account=${event.handle || ""} (${Object.keys(event.cookies || {}).length})`)
      const saved = this.cookiesHandler?.({ handle: event.handle || "", cookies: event.cookies || {}, cookies_exp: event.cookies_exp || {}, vm: event.vm || "" })
      void Promise.resolve(saved).catch((error) => {
        this.log.log(`driver: saving renewed cookies failed: ${redact(error?.message || error)}`)
      })
    } else if (event.ev === "lost") {
      this.log.log(`${timeString()} browser lost (${redact(event.why || "")}) — a new one starts with the next request`)
    } else if (event.ev === "log") {
      this.log.log(`${timeString()} ${redact(event.line || "")}`)
    }
  }

  private async answer(event: DriverEvent): Promise<void> {
    try {
      const value = this.handler ? await this.handler(event.req as string, event.params) : undefined
      await this.send({ rid: event.rid, ok: true, value })
    } catch (error: any) {
      await this.send({ rid: event.rid, ok: false, error: redact(error?.message || error) }).catch(() => {})
    }
  }

  private send(value: unknown): Promise<void> {
    const stdin = this.stdin
    if (!stdin || (stdin as any).destroyed) return Promise.reject(errDriverDown)
    const line = JSON.stringify(value) + "\n"
    const previous = this.writeLock
    let release: () => void = () => {}
    this.writeLock = new Promise<void>((resolve) => { release = resolve })
    return previous.then(() => new Promise<void>((resolve, reject) => {
      if (this.stdin !== stdin || (stdin as any).destroyed) { release(); reject(errDriverDown); return }
      stdin.write(line, (error?: Error | null) => {
        release()
        if (error) reject(error)
        else resolve()
      })
    }))
  }

  private register(id: string): Waiting {
    const waiting: Waiting = { queue: [], wake: null, closed: false }
    this.pending.set(id, waiting)
    return waiting
  }

  // One "abort" line per request: the driver stops the work behind that id and still answers, so a
  // cancelled request never becomes a second cancel when the caller goes away twice.
  private abortOnce(id: string): () => void {
    let sent = false
    return () => {
      if (sent) return
      sent = true
      void this.send({ id, op: "abort" }).catch(() => {})
    }
  }

  private unregister(id: string): void {
    const waiting = this.pending.get(id)
    if (waiting) waiting.closed = true
    this.pending.delete(id)
  }

  // The next message for this request, or the caller's own abort: the Go engine selected over the
  // same three cases — the request's channel, the driver going away, and ctx.Done(). An abort also
  // tells the driver to stop the work, so a client that leaves does not leave a chat running.
  private async next(waiting: Waiting, signal?: AbortSignal, onAbort?: () => void): Promise<DriverEvent> {
    if (waiting.queue.length) return waiting.queue.shift() as DriverEvent
    if (waiting.closed) throw errDriverDown
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", aborted)
        settle()
      }
      const aborted = () => {
        onAbort?.()
        finish(() => reject(abortReason(signal as AbortSignal)))
      }
      // retire() sets closed and calls wake, so one wake is the only way a waiting request learns
      // that its driver is gone.
      waiting.wake = () => {
        if (waiting.queue.length) finish(() => resolve(waiting.queue.shift() as DriverEvent))
        else if (waiting.closed) finish(() => reject(errDriverDown))
      }
      if (signal) {
        if (signal.aborted) aborted()
        else signal.addEventListener("abort", aborted, { once: true })
      }
    })
  }

  async do(signal: AbortSignal | undefined, op: string, params: unknown): Promise<any> {
    await this.ensure(signal)
    const id = this.nextID()
    const waiting = this.register(id)
    const abort = this.abortOnce(id)
    try {
      await this.send({ id, op, params })
      for (;;) {
        const event = await this.next(waiting, signal, abort)
        if (event.ev === "result") return event.value
        if (event.ev === "error") throw new DriverError(event.kind || "", event.message || "engine unavailable")
      }
    } finally {
      this.unregister(id)
    }
  }

  async decode(signal: AbortSignal | undefined, op: string, params: unknown): Promise<any> {
    return this.do(signal, op, params)
  }

  async stream(signal: AbortSignal | undefined, op: string, params: unknown, onEvent?: (event: DriverEvent) => void): Promise<DriverEvent> {
    await this.ensure(signal)
    const id = this.nextID()
    const waiting = this.register(id)
    const abort = this.abortOnce(id)
    try {
      await this.send({ id, op, params })
      for (;;) {
        const event = await this.next(waiting, signal, abort)
        if (event.ev === "delta" || event.ev === "meta") {
          try { onEvent?.(event) } catch (error) { abort(); throw error }
        } else if (event.ev === "final") return event
        else if (event.ev === "error") throw new DriverError(event.kind || "", event.message || "engine unavailable")
      }
    } finally {
      this.unregister(id)
    }
  }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    const stdin = this.stdin
    this.stdin = null
    this.started = false
    try { stdin?.end() } catch {}
    if (!child) return
    await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))])
    if (child.exitCode == null) child.kill()
    this.failed = errDriverDown
    this.failedAt = Date.now()
  }
}

export type { DriverEvent }
