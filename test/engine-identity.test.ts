// The plugin may only hand engine.key (and an account handle) to a port that proves it holds the
// same key. These run without a browser: they drive the identity check, not a chat.
import { after, before, test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { healthProof } from "../engine/health.ts"
import { MuseWebPlugin } from "../index.ts"

const KEY = "identity-test-engine-key"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port
      server.close(() => resolve(port))
    })
  })
}

// Each test gets a fresh data dir with a pre-installed key and a port, but the plugin's cache is
// per-instance, so a new MuseWebPlugin is built each time.
let home = ""
let port = 0

before(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "mw-identity-"))
  writeFileSync(path.join(home, "engine.key"), KEY + "\n", { mode: 0o600 })
  port = await freePort()
  delete process.env.MUSE_WEB_ENGINE
  delete process.env.MUSE_WEB_ENGINE_KEY
  Object.assign(process.env, { MUSE_WEB_HOME: home, MUSE_WEB_ENGINE_PORT: String(port) })
})

after(async () => {
  delete process.env.MUSE_WEB_HOME
  delete process.env.MUSE_WEB_ENGINE_PORT
  delete process.env.MUSE_WEB_ENGINE_BIN
  await rm(home, { recursive: true, force: true })
})

test("a port that answers in the engine's name but cannot prove the key is never sent the key", { timeout: 30_000 }, async () => {
  const seen: (string | undefined)[] = []
  const squatter = http.createServer((req, res) => {
    seen.push(req.headers.authorization)
    res.writeHead(200, { "content-type": "application/json" })
    // Claims to be a current engine, but never returns a proof — exactly what a squatter that
    // grabbed the port first would do.
    res.end(JSON.stringify({ ok: true, engine: "muse-web", version: "0.11.0", accounts: 0 }))
  })
  await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r))
  try {
    const hooks = await MuseWebPlugin({})

    const usage = await hooks.auth.usage(async () => ({ type: "oauth", refresh: "muse-x", access: "muse-x", expires: Date.now() + 1000 }))
    assert.match(usage.error, /engine\.key/, "the reason should point at the key/port trouble")

    // The chat path must also refuse: it would otherwise hand over the key and the handle.
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", refresh: "muse-x", access: "muse-x", expires: Date.now() + 1000 }))
    await assert.rejects(
      loaded.fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", body: "{}" }),
      /engine\.key/,
    )

    // Nothing the squatter ever received carried an authorization header.
    assert.ok(seen.length > 0, "the squatter should have been probed")
    assert.deepEqual(seen.filter(Boolean), [], "engine.key leaked to a port that could not prove itself")
  } finally {
    await new Promise<void>((r) => { squatter.closeAllConnections?.(); squatter.close(() => r()) })
  }
})

test("an engine that proves the key is retired with the key before being replaced", { timeout: 30_000 }, async () => {
  let stopped = false
  let shutdownAuth: string | undefined
  const old = http.createServer((req, res) => {
    if (req.url === "/v1/shutdown") {
      shutdownAuth = req.headers.authorization
      stopped = true
      res.end("{}")
      old.close()
      old.closeAllConnections?.()
      return
    }
    const body: any = { ok: true, engine: "muse-web", version: "0.0.1", accounts: 0 }
    const nonce = req.headers["x-muse-challenge"]
    if (typeof nonce === "string" && nonce) body.proof = healthProof(KEY, nonce)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((r) => old.listen(port, "127.0.0.1", r))
  // Point the replacement at a binary that does not exist, so the test stops after the retire
  // instead of spawning a real (browser-driving) engine.
  process.env.MUSE_WEB_ENGINE_BIN = path.join(home, "no-such-engine")
  try {
    await MuseWebPlugin({})
    for (let i = 0; i < 50 && !stopped; i++) await sleep(100)
    assert.ok(stopped, "the old engine was asked to stop")
    assert.equal(shutdownAuth, `Bearer ${KEY}`, "shutdown should carry the key only because the engine proved it")
  } finally {
    delete process.env.MUSE_WEB_ENGINE_BIN
    await new Promise<void>((r) => { old.closeAllConnections?.(); old.close(() => r()) })
  }
})
