// The engine's own HTTP surface, exercised in this process instead of through a spawned engine.
// One real listener on an ephemeral port keeps the request path identical to production — Host
// header, status line, streaming — while the driver stays a lazy child that never starts unless a
// test points it at a script.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Driver } from "../engine/bridge.ts"
import { healthProof } from "../engine/health.ts"
import { ENGINE_NAME, Logger } from "../engine/log.ts"
import { newHTTPServer } from "../engine/main.ts"
import { Engine, KEYED_IN_FLIGHT, OPEN_IN_FLIGHT, loopbackHost } from "../engine/server.ts"
import { Store } from "../engine/store.ts"
import { VERSION } from "../engine/version.ts"

// A login id of the shape login_start hands out: 12 base64url characters.
const LOGIN_ID = "abcdefgh1234"
const KEY = "test-engine-key"

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string }

type Fixture = {
  engine: Engine
  drv: Driver
  store: Store
  dir: string
  port: number
  close(): Promise<void>
}

// Every fixture points the driver at a script that does not exist unless a test names one: a keyed
// login start really does start the driver, and this suite must never launch a browser.
async function fixture(driverScript = path.join(os.tmpdir(), "mw-http-no-driver", "absent-driver.ts")): Promise<Fixture> {
  const savedDriver = process.env.MUSE_WEB_DRIVER
  const savedNode = process.env.MUSE_WEB_NODE
  process.env.MUSE_WEB_DRIVER = driverScript
  process.env.MUSE_WEB_NODE = process.execPath
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-http-"))
  const log = new Logger(dir, null)
  const store = new Store(path.join(dir, "accounts.json"))
  const drv = new Driver(log)
  const engine = new Engine({ port: 18611, key: KEY }, log, store, drv)
  const server = newHTTPServer((req, res) => { void engine.handle(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = (server.address() as any).port
  return {
    engine,
    drv,
    store,
    dir,
    port,
    close: async () => {
      await drv.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (savedDriver === undefined) delete process.env.MUSE_WEB_DRIVER
      else process.env.MUSE_WEB_DRIVER = savedDriver
      if (savedNode === undefined) delete process.env.MUSE_WEB_NODE
      else process.env.MUSE_WEB_NODE = savedNode
    },
  }
}

// node:http rather than fetch, because a Host header has to be set by hand here and undici owns
// its own.
function send(
  port: number,
  method: string,
  target: string,
  opts: { host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        agent: false,
        headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.headers || {}) },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => { body += chunk })
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body }))
      },
    )
    req.on("error", reject)
    if (opts.body != null) req.write(opts.body)
    req.end()
  })
}

const codeOf = (reply: Reply): string => {
  try {
    return JSON.parse(reply.body)?.error?.code || ""
  } catch {
    return ""
  }
}

// Takes every token of a budget and hands back the releases, so a test can put them back.
function occupy(budget: { take(): (() => void) | null }, size: number): Array<() => void> {
  const releases: Array<() => void> = []
  for (let i = 0; i < size; i++) {
    const release = budget.take()
    assert.ok(release, `budget refused token ${i + 1} of ${size}`)
    releases.push(release as () => void)
  }
  return releases
}

function drain(releases: Array<() => void>): void {
  for (const release of releases) release()
}

// Polls a condition so a test waits for the engine to reach a state instead of for a fixed time.
async function until(condition: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(message)
}

describe("the engine's HTTP surface", { timeout: 60_000 }, () => {
  test("every authenticated route answers 401 before its handler runs", async () => {
    const f = await fixture()
    try {
      for (const route of f.engine.table) {
        if (!route.auth) continue
        const target = route.pattern.replace("{id}", LOGIN_ID)
        const reply = await send(f.port, route.method, target)
        assert.equal(reply.status, 401, `${route.method} ${target} without Authorization`)
        assert.equal(codeOf(reply), "engine_key_invalid", `${route.method} ${target}`)
      }
    } finally {
      await f.close()
    }
  })

  test("only health and the login progress page need no key", async () => {
    const f = await fixture()
    try {
      const open = f.engine.table.filter((route) => !route.auth).map((route) => `${route.method} ${route.pattern}`)
      assert.deepEqual(open, ["GET /v1/health", "GET /login/{id}"])
    } finally {
      await f.close()
    }
  })

  test("the key is accepted on every route that asks for one", async () => {
    const f = await fixture()
    try {
      for (const route of f.engine.table) {
        if (!route.auth) continue
        const target = route.pattern.replace("{id}", LOGIN_ID)
        const reply = await send(f.port, route.method, target, { headers: { authorization: `Bearer ${KEY}` } })
        assert.notEqual(reply.status, 401, `${route.method} ${target} with the key`)
      }
    } finally {
      await f.close()
    }
  })

  test("the Host header must name this machine", async () => {
    const f = await fixture()
    try {
      const table: Array<{ host: string; status: number; code?: string }> = [
        { host: "evil.example:18611", status: 403, code: "host_not_allowed" },
        { host: "evil.example", status: 403, code: "host_not_allowed" },
        { host: "localhost.evil.example:18611", status: 403, code: "host_not_allowed" },
        { host: "127.0.0.2:18611", status: 403, code: "host_not_allowed" },
        { host: "::ffff:127.0.0.1:18611", status: 403, code: "host_not_allowed" },
        { host: "127.0.0.1:18611", status: 200 },
        { host: "127.0.0.1", status: 200 },
        { host: "localhost:18611", status: 200 },
        { host: "localhost.", status: 200 },
        { host: "LOCALHOST:18611", status: 200 },
        { host: "[::1]:18611", status: 200 },
        { host: "[::1]", status: 200 },
      ]
      for (const spec of table) {
        const reply = await send(f.port, "GET", "/v1/health", { host: spec.host })
        assert.equal(reply.status, spec.status, `Host ${spec.host}`)
        if (spec.code) assert.equal(codeOf(reply), spec.code, `Host ${spec.host}`)
      }
    } finally {
      await f.close()
    }
  })

  test("health answers a proof for a valid challenge", async () => {
    const f = await fixture()
    try {
      const nonce = "nonce-0123456789"
      const reply = await send(f.port, "GET", "/v1/health", { headers: { "x-muse-challenge": nonce } })
      assert.equal(reply.status, 200)
      const body = JSON.parse(reply.body)
      assert.equal(body.proof, healthProof(KEY, nonce))
      assert.equal(body.engine, ENGINE_NAME)
      assert.equal(body.version, VERSION)
    } finally {
      await f.close()
    }
  })

  test("the login page renders without the key and keeps its hardening headers", async () => {
    const f = await fixture()
    try {
      const reply = await send(f.port, "GET", `/login/${LOGIN_ID}`)
      assert.equal(reply.status, 200)
      for (const name of ["content-security-policy", "x-frame-options", "referrer-policy"]) {
        assert.ok(reply.headers[name], `login page is missing ${name}`)
      }
      assert.ok(reply.body.includes("找不到这次登录"), reply.body)
    } finally {
      await f.close()
    }
  })

  test("a wrong method on a known path stays a plain 404", async () => {
    const f = await fixture()
    try {
      const table = [
        ["POST", "/v1/health"],
        ["GET", "/v1/chat/completions"],
        ["GET", "/v1/shutdown"],
      ]
      for (const [method, target] of table) {
        const reply = await send(f.port, method, target)
        assert.equal(reply.status, 404, `${method} ${target}`)
      }
    } finally {
      await f.close()
    }
  })

  test("a login id that is not the shape login_start hands out stays a 404", async () => {
    const f = await fixture()
    try {
      const paths = [
        "/v1/login/",
        "/v1/login/a/b",
        "/login/",
        "/login/a/b",
        "/login/../x",
        "/login/a%20b",
        "/login/abc",
        "/login/x%2Fy",
        "/login/" + "a".repeat(33),
      ]
      for (const target of paths) {
        const reply = await send(f.port, "GET", target)
        assert.equal(reply.status, 404, `GET ${target}`)
      }
    } finally {
      await f.close()
    }
  })

  test("health stays thin: it names the engine, not the accounts behind the key", async () => {
    const f = await fixture()
    try {
      f.store.add({ hatch_sess: "s" }, {}, "someone@example.test", "")
      const reply = await send(f.port, "GET", "/v1/health")
      assert.equal(reply.status, 200)
      const body = JSON.parse(reply.body)
      assert.equal(body.accounts, undefined, "unauthenticated health counts accounts")
      assert.equal(body.engine, ENGINE_NAME)

      const listed = await send(f.port, "GET", "/v1/accounts", { headers: { authorization: `Bearer ${KEY}` } })
      assert.equal(JSON.parse(listed.body).accounts.length, 1)
    } finally {
      await f.close()
    }
  })

  test("the listener bounds a request but never a streaming answer", () => {
    const server = newHTTPServer()
    try {
      assert.ok(server.headersTimeout > 0, "no header deadline")
      assert.ok(server.requestTimeout > 0, "no request deadline")
      assert.ok(server.requestTimeout <= 2 * 60_000, `request deadline ${server.requestTimeout}ms can pin the process`)
      assert.ok(server.keepAliveTimeout > 0, "no keep-alive window")
      // A socket inactivity deadline would cut an answer that streams for minutes; Node's 0 is
      // the absence of one.
      assert.equal(server.timeout, 0, "a socket timeout would cut streaming answers")
    } finally {
      server.close()
    }
  })

  test("a spent open budget answers 503 instead of queueing, and health stays exempt", async () => {
    const f = await fixture()
    const held = occupy(f.engine.open, OPEN_IN_FLIGHT)
    try {
      const refused = await send(f.port, "GET", `/login/${LOGIN_ID}`)
      assert.equal(refused.status, 503)
      assert.equal(codeOf(refused), "engine_busy")
      assert.ok(refused.headers["retry-after"], "503 engine_busy carries no retry-after")

      assert.equal((await send(f.port, "GET", "/v1/health")).status, 200, "health with a spent open budget")
      const keyed = await send(f.port, "GET", "/v1/models", { headers: { authorization: `Bearer ${KEY}` } })
      assert.equal(keyed.status, 200, "keyed route with a spent open budget")

      held.pop()?.()
      assert.equal((await send(f.port, "GET", `/login/${LOGIN_ID}`)).status, 200, "login page after one token came back")
    } finally {
      drain(held)
      await f.close()
    }
  })

  test("a spent keyed budget answers 503, and a normal answer gives its token back", async () => {
    const f = await fixture()
    const held = occupy(f.engine.keyed, KEYED_IN_FLIGHT)
    try {
      const keyed = { authorization: `Bearer ${KEY}` }
      const refused = await send(f.port, "GET", "/v1/models", { headers: keyed })
      assert.equal(refused.status, 503)
      assert.equal(codeOf(refused), "engine_busy")
      assert.equal((await send(f.port, "GET", "/v1/health")).status, 200, "health with a spent keyed budget")

      drain(held)
      held.length = 0
      assert.equal((await send(f.port, "GET", "/v1/models", { headers: keyed })).status, 200)
      assert.equal(f.engine.keyed.used(), 0, "the keyed budget shrank over one answer")
      assert.equal(f.engine.open.used(), 0, "the open budget shrank over one answer")
    } finally {
      drain(held)
      await f.close()
    }
  })

  test("a wrong key is refused before it can hold a token", async () => {
    const f = await fixture()
    const held = occupy(f.engine.open, OPEN_IN_FLIGHT)
    try {
      const reply = await send(f.port, "GET", "/v1/models", { headers: { authorization: "Bearer not-the-key" } })
      assert.equal(reply.status, 401)
      assert.equal(f.engine.keyed.used(), 0, "a rejected request is holding keyed tokens")
    } finally {
      drain(held)
      await f.close()
    }
  })

  test("the unauthenticated page starts no process, while a keyed login start does", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-marker-"))
    const marker = path.join(dir, "spawned")
    const script = path.join(dir, "driver.ts")
    // A driver of the same protocol that records the fact it was started: "no process" cannot be
    // answered by counting processes portably, so a spawn becomes a file that is or is not there.
    writeFileSync(
      script,
      [
        `import { writeFileSync } from "node:fs"`,
        `import readline from "node:readline"`,
        `writeFileSync(${JSON.stringify(marker)}, "spawned\\n")`,
        `process.stdout.write('{"ev":"ready"}\\n')`,
        `readline.createInterface({ input: process.stdin }).on("line", (line: string) => {`,
        `  const req = JSON.parse(line)`,
        `  const value = req.op === "login_start" ? { id: ${JSON.stringify(LOGIN_ID)} } : req.op === "login_status" ? { state: null } : null`,
        `  const reply = value ? { id: req.id, ev: "result", value } : { id: req.id, ev: "error", kind: "engine_unavailable", message: "fake driver has no " + req.op }`,
        `  process.stdout.write(JSON.stringify(reply) + "\\n")`,
        `})`,
        ``,
      ].join("\n"),
    )
    const f = await fixture(script)
    try {
      const page = await send(f.port, "GET", `/login/${LOGIN_ID}`)
      assert.equal(page.status, 200)
      assert.throws(() => readFileSync(marker, "utf8"), "the unauthenticated progress page started the driver")
      assert.equal(f.drv.running(), false, "the unauthenticated progress page left a driver running")

      const started = await send(f.port, "POST", "/v1/login", { headers: { authorization: `Bearer ${KEY}` } })
      assert.equal(started.status, 200, started.body)
      assert.equal(readFileSync(marker, "utf8"), "spawned\n", "the keyed login start did not start the driver")
      assert.equal(f.drv.running(), true, "the keyed login start did not leave a driver running")
    } finally {
      await f.close()
    }
  })

  test("one unauthenticated request writes one log record", async () => {
    const f = await fixture()
    try {
      // A newline in a request target: Node keeps the target raw, so it arrives as %0A, but the
      // record must stay one line either way — the log is what a reader trusts.
      const forged = "2026-11-27T00:00:00 200 GET /v1/accounts account=muse-forged"
      const target = "/v1/health%0A" + encodeURIComponent(forged)
      const reply = await send(f.port, "GET", target)
      assert.equal(reply.status, 404)
      const raw = readFileSync(path.join(f.dir, "engine.log"), "utf8")
      const lines = raw.replace(/\n+$/, "").split("\n")
      assert.equal(lines.length, 1, `one request wrote ${lines.length} records:\n${raw}`)
      assert.ok(lines[0].includes("GET /v1/health"), lines[0])
    } finally {
      await f.close()
    }
  })

  test("a client that leaves mid-answer frees the account instead of holding it busy", async () => {
    const f = await fixture(path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-driver.ts"))
    try {
      const acct = f.store.add({ hatch_sess: "s" }, {}, "leaver@example.test", "")
      const req = http.request({
        host: "127.0.0.1",
        port: f.port,
        method: "POST",
        path: "/v1/chat/completions",
        agent: false,
        headers: {
          host: `127.0.0.1:${f.port}`,
          authorization: `Bearer ${KEY}`,
          "x-muse-account": acct.handle,
          "content-type": "application/json",
        },
      })
      req.on("error", () => {})
      req.end(JSON.stringify({ messages: [{ role: "user", content: "DELAY:5000 hello" }], stream: true }))
      await until(() => f.engine.isBusy(acct.handle), 5_000, "the chat never marked the account busy")
      // The answer takes five seconds; a client that goes away must not keep the account for them.
      req.destroy()
      await until(() => !f.engine.isBusy(acct.handle), 2_000, "the account stayed busy after the client left")
    } finally {
      await f.close()
    }
  })
})

describe("a caller that goes away", { timeout: 30_000 }, () => {
  test("stops waiting on a driver that never answers, and tells it to stop", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mw-abort-"))
    const lines = path.join(dir, "requests.jsonl")
    const script = path.join(dir, "driver.ts")
    // A driver that becomes ready and then says nothing: without the caller's abort both calls
    // below would wait here for as long as this process lives.
    writeFileSync(
      script,
      [
        `import { appendFileSync } from "node:fs"`,
        `import readline from "node:readline"`,
        `process.stdout.write('{"ev":"ready"}\\n')`,
        `readline.createInterface({ input: process.stdin }).on("line", (line: string) => {`,
        `  appendFileSync(${JSON.stringify(lines)}, line + "\\n")`,
        `})`,
        ``,
      ].join("\n"),
    )
    const f = await fixture(script)
    try {
      const controller = new AbortController()
      const streaming = f.drv.stream(controller.signal, "chat_stream", { messages: [] })
      const doing = f.drv.do(controller.signal, "usage", {})
      const outcomes = [streaming, doing].map((call) => call.then(() => null, (error: any) => error))
      const ops = (): string[] => {
        try {
          return readFileSync(lines, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).op)
        } catch {
          return []
        }
      }
      await until(() => ops().length >= 2, 5_000, "the driver never received both requests")
      controller.abort()
      for (const outcome of await Promise.all(outcomes)) {
        assert.equal(outcome?.name, "AbortError", `the cancelled call answered ${outcome}`)
      }
      await until(() => ops().length >= 4, 5_000, "the driver was never told to stop")
      // Which of the two requests reached the pipe first is the scheduler's call; both must arrive,
      // and each must be followed by its own stop.
      assert.deepEqual(ops().slice(0, 2).sort(), ["chat_stream", "usage"])
      assert.deepEqual(ops().slice(2), ["abort", "abort"])
    } finally {
      await f.close()
    }
  })
})

describe("loopbackHost", () => {
  test("accepts the names this port answers to", () => {
    for (const host of ["127.0.0.1:18611", "localhost:18611", "[::1]:18611", "[::1]", "::1", "0.0.0.0", "0.0.0.0:18611", "localhost.", "LOCALHOST:18611", "127.0.0.1."]) {
      assert.equal(loopbackHost(host), true, host)
    }
  })

  test("refuses anything else, including an empty or padded header", () => {
    for (const host of ["evil.example:18611", "localhost.evil.example:18611", "127.0.0.2:18611", "::ffff:127.0.0.1:18611", "[::ffff:127.0.0.1]:18611", "", "   "]) {
      assert.equal(loopbackHost(host), false, host)
    }
  })
})
