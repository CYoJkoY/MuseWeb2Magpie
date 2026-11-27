// Reading a body from something this engine does not control always has a ceiling. Two callers
// need the same rule: the fingerprint-browser installer (a GitHub release's asset list, a
// ".manifest.json", the archive itself) and the debugging-port probe (the browser's /json/version
// and /json/list). Both talk to an address that may answer with a body of any size — a remote
// server, or a local process that took the port before the browser did — so the limit is enforced
// while the bytes arrive, not after they are already in memory.
//
// Kept in its own module rather than in either caller: the CDP client is the lowest layer and
// must not depend on the browser installer, and a second copy of this rule would be a second
// place to forget the ceiling.

// JSON answers on these paths are small: an asset list, a manifest, /json/version, and the page
// list of a browser. One megabyte is far above any of them and far below what hurts.
export const MAX_JSON_BYTES = 1024 * 1024

// The size the response announces, if any. A real Headers object and the plain object a test
// double returns both work here; a missing or unreadable header counts as "announced nothing".
export function declaredLength(res: any): number {
  const raw = typeof res?.headers?.get === "function" ? res.headers.get("content-length") : res?.headers?.["content-length"]
  const value = Number(raw ?? "")
  return Number.isFinite(value) && value > 0 ? value : 0
}

// Reads a whole response body under a ceiling. A real response has a stream, so the limit is
// enforced while the bytes arrive rather than after they are all in memory; a double that only
// knows arrayBuffer is read in one piece and measured afterwards.
export async function readBounded(res: any, limit: number, what: string): Promise<Buffer> {
  const announced = declaredLength(res)
  if (announced > limit) throw new Error(`${what}超过 ${limit} 字节上限（HTTP 声明 ${announced} 字节）`)
  const body = res?.body
  if (!body || typeof body.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > limit) throw new Error(`${what}超过 ${limit} 字节上限（实际 ${buf.length} 字节）`)
    return buf
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      try {
        await reader.cancel()
      } catch {}
      throw new Error(`${what}超过 ${limit} 字节上限`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

// The JSON reads on these paths are the same rule: a body of unbounded size is refused before it
// is parsed, and a body within the ceiling that is not JSON gets its own reason.
export async function boundedJson(res: any, what: string, limit = MAX_JSON_BYTES): Promise<any> {
  const text = (await readBounded(res, limit, what)).toString("utf8")
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${what}不是合法的 JSON`)
  }
}
