// The connector edition points at an engine you run yourself — often one you run on another
// machine — so it needs the same two rules as the full edition: a credential (engine.key, an
// account handle) only rides loopback or https, and only to a port that proves it holds the key.
// These drive the same allow/refuse matrix as test/engine-origin.test.ts so the editions cannot
// drift apart silently.
import { test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import http from "node:http"
import { MuseWebConnectorPlugin } from "./index.ts"

const KEY = "connector-security-key"
const auth = async () => ({ type: "api", key: "muse-abc" })

function listen(handler): Promise<{ server: any; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${(server.address() as any).port}` }))
  })
}

const close = (server) => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()) })

test("a plain-http engine on another host is refused before a connection is made", async () => {
  // 192.0.2.0/24 is TEST-NET-1 and nothing answers there; a real connect attempt would stall
  // until the timeout. Refusing locally has to come back almost immediately.
  const hooks = await MuseWebConnectorPlugin({}, { engine: "http://192.0.2.10:18611", key: KEY })
  const started = Date.now()
  const usage = await hooks.auth.usage(auth)
  assert.match(usage.error, /https/, "the reason must name the transport rule")
  assert.ok(Date.now() - started < 500, "no connection should have been attempted")

  const loader = await hooks.auth.loader(auth)
  await assert.rejects(
    loader.fetch("http://192.0.2.10:18611/v1/chat/completions", { method: "POST", body: "{}" }),
    /https/,
  )
  await assert.rejects(hooks.auth.refresh({ type: "api", key: "muse-abc" }), /https/)
})

test("a loopback port that answers in the engine's name but cannot prove the key never gets it", async () => {
  const seen: (string | undefined)[] = []
  const { server, base } = await listen((req, res) => {
    seen.push(req.headers.authorization)
    res.writeHead(200, { "content-type": "application/json" })
    // Claims to be the engine, but never returns a proof.
    res.end(JSON.stringify({ engine: "muse-web", version: "0.11.0" }))
  })
  try {
    const hooks = await MuseWebConnectorPlugin({}, { engine: base, key: KEY })
    const usage = await hooks.auth.usage(auth)
    assert.ok(usage.error, "usage should fail rather than trust the port")
    const loader = await hooks.auth.loader(auth)
    await assert.rejects(loader.fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" }), /引擎/)
    assert.ok(seen.length > 0, "the port should have been probed")
    assert.deepEqual(seen.filter(Boolean), [], "the key leaked to a port that could not prove itself")
  } finally {
    await close(server)
  }
})

test("an engine that proves the key is trusted", async () => {
  const { server, base } = await listen((req, res) => {
    const health: any = { engine: "muse-web", version: "0.11.0" }
    const nonce = req.headers["x-muse-challenge"]
    if (typeof nonce === "string" && nonce) health.proof = createHmac("sha256", KEY).update(`muse-web-health:${nonce}`).digest("hex")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(req.url === "/v1/usage" ? { plan: "proved", windows: [] } : health))
  })
  try {
    const hooks = await MuseWebConnectorPlugin({}, { engine: base, key: KEY })
    const card: any = await hooks.auth.usage(auth)
    assert.equal(card.plan, "proved")
  } finally {
    await close(server)
  }
})

test("a redirect is refused, and the redirect target is never touched", async () => {
  let reached = 0
  const target = await listen((req, res) => { reached++; res.end("{}") })
  const { server, base } = await listen((req, res) => {
    res.writeHead(302, { location: `${target.base}/v1/health` })
    res.end()
  })
  try {
    const hooks = await MuseWebConnectorPlugin({}, { engine: base, key: KEY })
    const usage = await hooks.auth.usage(auth)
    assert.ok(usage.error, "a redirect must not be followed")
    assert.equal(reached, 0, "the redirect target received a request")
  } finally {
    await close(server)
    await close(target.server)
  }
})
