// Node's global fetch honours HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1 (the plugin starts the
// engine that way), which would send 127.0.0.1 calls through the proxy too. Engine control,
// health checks and the browser's CDP endpoints are always loopback, so they go through
// node:http(s) directly and never touch the environment proxy.
import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"])

export function isLoopbackUrl(value: unknown): boolean {
  try {
    return LOOPBACK.has(new URL(String(value)).hostname)
  } catch {
    return false
  }
}

// engine.key and account handles are credentials. They may travel in the clear only to this
// machine; anywhere else the carrier has to be https, so a plain-http LAN address cannot receive
// them just because someone typed it into MUSE_WEB_ENGINE (or an agent's environment did).
export function credentialSafeUrl(value: unknown): boolean {
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

export function localFetch(input: any, init: any = {}): Promise<Response> {
  const url = input instanceof URL ? input : new URL(String(input))
  const lib = url.protocol === "https:" ? https : http
  const headers: Record<string, string> = {}
  const given = new Headers(init.headers)
  for (const [name, value] of given) headers[name] = value
  if (!("accept-encoding" in headers)) headers["accept-encoding"] = "identity"
  const method = String(init.method || "GET").toUpperCase()
  const signal = init.signal || undefined
  if (signal?.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method, headers, agent: false, signal }, (res) => {
      const out = new Headers()
      for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      const status = res.statusCode || 502
      const bodyless = method === "HEAD" || status === 204 || status === 304
      resolve(new Response(bodyless ? null : Readable.toWeb(res), {
        status,
        statusText: res.statusMessage || "",
        headers: out,
      }))
    })
    req.on("error", reject)
    const body = init.body
    if (body == null) req.end()
    else if (typeof body === "string") req.end(body)
    else if (Buffer.isBuffer(body) || body instanceof Uint8Array) req.end(body)
    else if (typeof body.pipe === "function") body.pipe(req)
    else if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) Readable.fromWeb(body).pipe(req)
    else req.end(String(body))
  })
}

// Same signature as fetch, unless the request is loopback: then no proxy is involved.
export function anyFetch(input: any, init?: any): Promise<Response> {
  return isLoopbackUrl(input) ? localFetch(input, init) : fetch(input, init)
}
