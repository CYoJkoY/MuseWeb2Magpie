// Minimal Chrome DevTools Protocol client over the runtime's own WebSocket (Bun, Node ≥ 22).
// Ported from muse2api's cdp.py (MIT, MUSE2API Authors).
import { anyFetch } from "./local-fetch.ts"

export class CDPError extends Error {}

type Waiter = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export class CDP {
  ws: WebSocket
  timeoutMs: number
  nextId: number
  pending: Map<number, Waiter>
  closed: boolean
  closers: Array<() => void>

  static connect(url: string, { timeoutMs = 90_000 }: { timeoutMs?: number } = {}): Promise<CDP> {
    return new Promise<CDP>((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        reject(new CDPError(`CDP connect timed out: ${url}`))
      }, 15_000)
      ws.addEventListener("open", () => {
        clearTimeout(timer)
        resolve(new CDP(ws, timeoutMs))
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new CDPError(`CDP connect failed: ${url}`))
      })
    })
  }

  constructor(ws: WebSocket, timeoutMs: number) {
    this.ws = ws
    this.timeoutMs = timeoutMs
    this.nextId = 0
    this.pending = new Map()
    this.closed = false
    this.closers = []
    ws.addEventListener("message", (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"))
      } catch {
        return
      }
      const waiter = msg.id != null ? this.pending.get(msg.id) : null
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) waiter.reject(new CDPError(`${waiter.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      else waiter.resolve(msg.result ?? {})
    })
    ws.addEventListener("close", () => {
      this.closed = true
      for (const fn of this.closers.splice(0)) fn()
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer)
        waiter.reject(new CDPError(`${waiter.method}: connection closed`))
      }
      this.pending.clear()
    })
  }

  send(method: string, params: any = {}, timeoutMs: number = this.timeoutMs): Promise<any> {
    if (this.closed) return Promise.reject(new CDPError(`${method}: connection closed`))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CDPError(`CDP ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async js(expression: string, { awaitPromise = false, timeoutMs }: { awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, timeoutMs)
    return r.result && "value" in r.result ? r.result.value : undefined
  }

  // Called once when the socket goes away, whoever closed it.
  onClose(fn: () => void) {
    if (this.closed) fn()
    else this.closers.push(fn)
  }

  close() {
    this.closed = true
    try {
      this.ws.close()
    } catch {}
  }
}

export async function httpJSON(url: string, timeoutMs = 5000): Promise<any> {
  const res = await anyFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}
