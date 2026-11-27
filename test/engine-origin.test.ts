// Credentials — engine.key and account handles — may travel in the clear only to this machine.
// A named engine on another host has to be https, or the plugin must refuse it outright.
import { test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { credentialSafeUrl, isLoopbackUrl } from "../engine/local-fetch.ts"
import { MuseWebPlugin } from "../index.ts"

test("loopback and https are the only carriers a credential may ride", () => {
  for (const value of [
    "http://127.0.0.1:18611",
    "http://localhost:18611/v1/health",
    "http://[::1]:18611",
    "https://127.0.0.1:18611",
    "https://engine.example.test:8443",
  ]) {
    assert.equal(credentialSafeUrl(value), true, `${value} should be allowed`)
  }
  for (const value of [
    "http://192.0.2.10:18611",
    "http://engine.example.test:18611",
    "http://127.0.0.1.evil.test:18611",
    "http://localhost.evil.test:18611",
    "file:///etc/passwd",
    "",
    "not a url",
  ]) {
    assert.equal(credentialSafeUrl(value), false, `${value} should be refused`)
  }
  // The loopback check underneath stays as narrow as before.
  assert.equal(isLoopbackUrl("http://127.0.0.1:18611"), true)
  assert.equal(isLoopbackUrl("http://127.0.0.1.evil.test:18611"), false)
})

test("a named plain-http engine on another host is refused, and never gets the key", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mw-origin-"))
  const previous = {
    home: process.env.MUSE_WEB_HOME,
    engine: process.env.MUSE_WEB_ENGINE,
    key: process.env.MUSE_WEB_ENGINE_KEY,
  }
  Object.assign(process.env, {
    MUSE_WEB_HOME: home,
    MUSE_WEB_ENGINE: "http://192.0.2.10:18611",
    MUSE_WEB_ENGINE_KEY: "should-never-travel",
  })
  writeFileSync(path.join(home, "engine.key"), "local-key\n", { mode: 0o600 })
  try {
    const hooks = await MuseWebPlugin({})
    const usage = await hooks.auth.usage(async () => ({ type: "oauth", refresh: "muse-x", access: "muse-x", expires: Date.now() + 1000 }))
    assert.match(usage.error, /https/, "the reason should name the transport rule")

    // The same rule holds on the path that would carry the account handle.
    const loaded = await hooks.auth.loader(async () => ({ type: "oauth", refresh: "muse-x", access: "muse-x", expires: Date.now() + 1000 }))
    await assert.rejects(
      loaded.fetch("http://192.0.2.10:18611/v1/chat/completions", { method: "POST", body: "{}" }),
      /https/,
    )
  } finally {
    for (const [name, value] of [
      ["MUSE_WEB_HOME", previous.home],
      ["MUSE_WEB_ENGINE", previous.engine],
      ["MUSE_WEB_ENGINE_KEY", previous.key],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})
