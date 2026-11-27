// The engine reads two answers from the browser's debugging port: /json/version at launch and
// /json/list at sign-in. The port belongs to the browser that wrote it into DevToolsActivePort,
// but the browser can be gone by the time the engine asks, and whoever holds the port then can
// answer with anything — including a body that never ends. These tests are that squatter: a real
// listener on loopback, answering in the browser's place.
import { after, before, test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { MAX_DEVTOOLS_BYTES, httpJSON } from "../engine/cdp.ts"
import { Logins } from "../engine/login.ts"

let server
let port
let pulled

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ Browser: "Chrome/155", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/2f8a` }))
      return
    }
    if (req.url === "/declared-huge") {
      // Announces a body far past the ceiling and sends nothing: the refusal must come from the
      // announcement, before a byte is buffered.
      res.writeHead(200, { "content-type": "application/json", "content-length": String(8 * 1024 * 1024 * 1024) })
      res.end()
      return
    }
    if (req.url === "/json/list" || req.url === "/endless") {
      // A body that never ends, arriving as fast as loopback allows. Before the ceiling this was
      // the whole of the attack: the engine buffered it until it died.
      res.writeHead(200, { "content-type": "application/json" })
      const chunk = Buffer.alloc(64 * 1024, 0x20)
      const pump = () => {
        while (res.write(chunk)) pulled++
        pulled++
        res.once("drain", pump)
      }
      res.once("close", () => res.removeListener("drain", pump))
      pump()
      return
    }
    if (req.url === "/not-json") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end("not json at all")
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  port = server.address().port
})

after(async () => {
  await new Promise<void>((r) => {
    server.closeAllConnections?.()
    server.close(() => r())
  })
})

test("a normal answer on the port still parses", async () => {
  const v = await httpJSON(`http://127.0.0.1:${port}/json/version`, 5000)
  assert.equal(v.Browser, "Chrome/155")
})

test("a body announced past the ceiling is refused before it is read", async () => {
  await assert.rejects(
    () => httpJSON(`http://127.0.0.1:${port}/declared-huge`, 5000),
    /超过 \d+ 字节上限（HTTP 声明 8589934592 字节）/,
  )
})

test("a body that never ends is cut off at the ceiling", { timeout: 30_000 }, async () => {
  pulled = 0
  await assert.rejects(() => httpJSON(`http://127.0.0.1:${port}/endless`, 20_000), new RegExp(`超过 ${MAX_DEVTOOLS_BYTES} 字节上限`))
  // The reader was cancelled at the ceiling rather than drained: loopback would otherwise hand
  // over hundreds of megabytes inside the same second.
  assert.equal(pulled < 10_000, true, `the endless body kept being read (${pulled} chunks)`)
})

test("a body within the ceiling that is not JSON has its own reason", async () => {
  await assert.rejects(() => httpJSON(`http://127.0.0.1:${port}/not-json`, 5000), /不是合法的 JSON/)
})

test("the sign-in poll is bounded by the same rule", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-devtools-"))
  try {
    const logins = new Logins({ site: "https://muse.ai", dir, onDone: async () => ({}) as any })
    await assert.rejects(() => logins.openChat(port), new RegExp(`超过 ${MAX_DEVTOOLS_BYTES} 字节上限`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
