// The verification-wall reading is only as good as what it sees in a real page. These tests put
// real HTML in front of a real (headless) Chromium and read it back through the engine's own
// windowScreen probe, so the DOM half — the visible-widget test and the composer test — is proven
// against a browser's layout rather than a hand-written object. Headless Chromium still lays pages
// out, so getBoundingClientRect is meaningful without opening a window.
import { after, before, test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { findBrowser, launchBrowser } from "../engine/browser.ts"
import { Logins, screenChallenged } from "../engine/login.ts"

const executable = findBrowser()
const skip = executable ? false : "no Chrome/Edge/Chromium installed"

// A verification vendor ships its response field as a hidden textarea. It must not read as the
// chat composer: on that page the account is not usable yet, the wall is.
const CHALLENGE = `<!doctype html><html><head><meta charset="utf-8"><title>muse</title></head>
<body><h1>Verify you are human</h1>
<p>muse.ai needs to review the security of your connection before proceeding.</p>
<textarea name="h-captcha-response" style="display:none"></textarea>
<div class="cf-turnstile" style="display:none"></div></body></html>`

// A signed-in chat page has a real, visible composer even when a vendor field is also present.
const CHAT = `<!doctype html><html><head><meta charset="utf-8"><title>muse</title></head>
<body><textarea style="width:300px;height:80px"></textarea>
<textarea name="g-recaptcha-response" style="display:none"></textarea></body></html>`

// A hidden challenge container the page never shows is not a wall a person could be asked to pass.
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>muse</title></head>
<body><div class="cf-turnstile" style="display:none"></div><p>正在连接…</p></body></html>`

let server, port, dir, base

before(async () => {
  if (skip) return
  const pages = { "/challenge": CHALLENGE, "/chat": CHAT, "/shell": SHELL }
  server = http.createServer((req, res) => {
    const html = pages[new URL(req.url, "http://x").pathname]
    if (!html) return res.writeHead(404).end()
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(html)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  port = server.address().port
  // The engine's chatTarget prefers the page whose URL starts with the configured site. Here the
  // page is on loopback, so the site is the loopback origin — otherwise Edge's own
  // edge://sync-confirmation tab, which a fresh Edge also opens, would be read instead.
  base = `http://127.0.0.1:${port}`
  dir = mkdtempSync(path.join(os.tmpdir(), "mw-screen-"))
})

after(async () => {
  if (skip) return
  await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function readWindow(pathname: string) {
  const opened = await launchBrowser({
    executable, profileDir: path.join(dir, "browser"), temporary: true,
    headless: true, proxy: "direct", url: `http://127.0.0.1:${port}${pathname}`,
  })
  try {
    const logins = new Logins({ site: base, dir, onDone: async () => ({}) as any })
    return await logins.windowScreen(opened.port, 8_000)
  } finally {
    await opened.close().catch(() => {})
  }
}

test("a challenge page reads as a wall, not as a usable account", { skip, timeout: 120_000 }, async () => {
  const screen = await readWindow("/challenge")
  assert.equal(screen.composer, false)
  assert.equal(screen.challenge, true)
  assert.equal(screenChallenged(screen), true)
  assert.match(screen.text, /Verify you are human/)
})

test("a signed-in chat page reads as a composer even with a vendor field present", { skip, timeout: 120_000 }, async () => {
  const screen = await readWindow("/chat")
  assert.equal(screen.composer, true)
  assert.equal(screen.challenge, false)
  assert.equal(screenChallenged(screen), false)
})

test("a hidden challenge container the page never shows is not a wall", { skip, timeout: 120_000 }, async () => {
  const screen = await readWindow("/shell")
  assert.equal(screen.composer, false)
  assert.equal(screen.challenge, false)
  assert.equal(screenChallenged(screen), false)
})
