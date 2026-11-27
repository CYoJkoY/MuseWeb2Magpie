// The engine never redirects, and following one would re-issue the request — with the account
// handle in a custom header — at an origin this process never vetted. `anyFetch` refuses instead.
import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { anyFetch } from "../engine/local-fetch.ts"

let server
let base
const hits: string[] = []

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(String(req.url))
    if (req.url === "/moved") {
      res.writeHead(302, { location: "/somewhere-else" })
      res.end()
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

test("a redirect from the engine is refused, not chased", async () => {
  await assert.rejects(anyFetch(`${base}/moved`), /redirect/, "a 3xx must reject")
  // The redirect target was never requested: nothing was followed.
  assert.deepEqual(hits.filter((url) => url === "/somewhere-else"), [])
})

test("a normal answer still comes through", async () => {
  const res = await anyFetch(`${base}/ok`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})
