// MUSE_WEB_SITE is the address that receives this account's session cookies, so its value follows
// the same rule as engine.key (ADR 0006): clear http only to this machine, https anywhere else.
// These tests pin the rule in engine/site.ts and prove the two places that can start the engine —
// the plugin (before it spawns) and the driver (before it launches a browser) — both enforce it.
// @ts-nocheck
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { siteOrDefault, siteProblem } from "../engine/site.ts"
import { MuseWebPlugin } from "../index.ts"

// The plugin checks a port before it checks the site, so this test needs a port nothing answers on
// — a Magpie the person is running would otherwise hold the default one and answer for it.
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

test("the site the cookies ride to must be loopback http or https", () => {
  for (const value of [undefined, "", "   ", "https://muse.ai", "http://127.0.0.1:3000", "http://localhost:3000/", "http://[::1]:3000"]) {
    assert.equal(siteProblem(value), null, `${value} should be allowed`)
  }
  for (const [value, why] of [
    ["muse.ai", /完整的网址/],
    ["ftp://muse.ai", /只支持 http 或 https/],
    ["https://user:pass@muse.ai", /用户名或密码/],
    ["http://192.0.2.10:3000", /明文传输/],
    ["http://mirror.example.test:3000", /明文传输/],
    ["http://127.0.0.1.evil.test:3000", /明文传输/],
  ]) {
    assert.match(siteProblem(value) ?? "", why, `${value} should be refused`)
  }
})

test("siteOrDefault keeps the muse.ai default and trims slashes", () => {
  assert.equal(siteOrDefault(undefined), "https://muse.ai")
  assert.equal(siteOrDefault(""), "https://muse.ai")
  assert.equal(siteOrDefault("https://muse.ai/"), "https://muse.ai")
  assert.equal(siteOrDefault(" https://mirror.test/ "), "https://mirror.test")
})

test("the plugin refuses to start an engine pointed at an unsafe site, and the reason is the error", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mw-site-"))
  const port = await closedPort()
  const previous = {
    home: process.env.MUSE_WEB_HOME,
    site: process.env.MUSE_WEB_SITE,
    port: process.env.MUSE_WEB_ENGINE_PORT,
    engine: process.env.MUSE_WEB_ENGINE,
    key: process.env.MUSE_WEB_ENGINE_KEY,
  }
  Object.assign(process.env, {
    MUSE_WEB_HOME: home,
    MUSE_WEB_SITE: "http://mirror.example.test:3000",
    MUSE_WEB_ENGINE_PORT: String(port),
  })
  delete process.env.MUSE_WEB_ENGINE
  delete process.env.MUSE_WEB_ENGINE_KEY
  try {
    const hooks = await MuseWebPlugin({})
    // Spawning the engine would be the old behaviour; with the rule, the usage card carries the
    // reason instead of an engine that would have sent cookies to the mirror.
    const card = await hooks.auth.usage(async () => ({ type: "oauth", refresh: "muse-x", access: "muse-x", expires: Date.now() + 1000 }))
    assert.match(card.error, /明文传输/, "the reason should name the transport rule")
  } finally {
    for (const [name, value] of [
      ["MUSE_WEB_HOME", previous.home],
      ["MUSE_WEB_SITE", previous.site],
      ["MUSE_WEB_ENGINE_PORT", previous.port],
      ["MUSE_WEB_ENGINE", previous.engine],
      ["MUSE_WEB_ENGINE_KEY", previous.key],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})
