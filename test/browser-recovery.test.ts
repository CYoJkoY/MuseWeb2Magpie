import { test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { browserArgs, browserCandidates, browserOptions, debuggerUrl, findBrowser, launchBrowser, readActivePort, sweepProfiles } from "../engine/browser.ts"
import { Muse } from "../engine/muse.ts"

const executable = findBrowser()

test("the debugger port comes from the file the browser writes, never from a guess", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-active-"))
  const file = path.join(root, "DevToolsActivePort")
  const write = (text: string) => writeFileSync(file, text)
  try {
    // Nothing yet: the browser has not opened its listener.
    assert.equal(readActivePort(root), 0)
    write("9333\n/devtools/browser/2f8a1c0e-6a0d-4f43-9d1c-2b3c1a0f9e77\n")
    assert.equal(readActivePort(root), 9333)
    // Chromium writes \n on every platform, but a file that arrives with \r\n still parses.
    write("9333\r\n/devtools/browser/x\r\n")
    assert.equal(readActivePort(root), 9333)
    // A single line is not this file; the browser's own WebSocket path must be there too.
    write("9333\n")
    assert.equal(readActivePort(root), 0)
    write("9333\n/devtools/page/x\n")
    assert.equal(readActivePort(root), 0)
    // Port 0 means "pick one", which is what the engine passes; it is not an answer.
    write("0\n/devtools/browser/x\n")
    assert.equal(readActivePort(root), 0)
    write("http\n/devtools/browser/x\n")
    assert.equal(readActivePort(root), 0)
    write("70000\n/devtools/browser/x\n")
    assert.equal(readActivePort(root), 0)
    // A file far larger than the two short lines is not something to parse at all.
    write("9333\n/devtools/browser/x\n" + "0".repeat(5000))
    assert.equal(readActivePort(root), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an answer on the port counts only if it is this browser's own debugger", () => {
  const ws = "ws://127.0.0.1:9333/devtools/browser/2f8a1c0e"
  assert.equal(debuggerUrl(ws, 9333), ws)
  assert.equal(debuggerUrl("ws://localhost:9333/devtools/browser/x", 9333), "ws://localhost:9333/devtools/browser/x")
  assert.equal(debuggerUrl("ws://[::1]:9333/devtools/browser/x", 9333), "ws://[::1]:9333/devtools/browser/x")
  // Same shape, different port: another listener that took the port before the browser did.
  assert.equal(debuggerUrl("ws://127.0.0.1:9334/devtools/browser/x", 9333), null)
  // Not loopback: the browser is started with --remote-debugging-address=127.0.0.1.
  assert.equal(debuggerUrl("ws://10.0.0.5:9333/devtools/browser/x", 9333), null)
  // A page target, a plain-http answer, and junk are not a browser endpoint.
  assert.equal(debuggerUrl("ws://127.0.0.1:9333/devtools/page/x", 9333), null)
  assert.equal(debuggerUrl("http://127.0.0.1:9333/devtools/browser/x", 9333), null)
  assert.equal(debuggerUrl(undefined, 9333), null)
  assert.equal(debuggerUrl("not a url", 9333), null)
})

test("the engine asks the browser to pick its own debugging port", () => {
  const args = browserArgs({ port: 0, profileDir: "profile", headless: true })
  assert.ok(args.includes("--remote-debugging-port=0"))
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"))
})

test("sign-in choices list installed browsers once and keep MUSE_WEB_CHROME first", () => {
  const env = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    MUSE_WEB_CHROME: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  }
  const installed = new Set([
    env.MUSE_WEB_CHROME,
    "C:\\Users\\x\\AppData\\Local\\Chromium\\Application\\chrome.exe",
  ])
  const exists = (file) => installed.has(file)
  // The configured path is judged as a file, not just as something that exists: the same rule the
  // sign-in prompt applies to a typed path.
  const stat = (file) => ({ isFile: () => installed.has(file) })
  const choices = browserOptions(env, "win32", exists, stat)
  assert.deepEqual(choices, [
    { label: "MUSE_WEB_CHROME（Microsoft Edge）", value: env.MUSE_WEB_CHROME },
    { label: "Chromium", value: "C:\\Users\\x\\AppData\\Local\\Chromium\\Application\\chrome.exe" },
  ])
})

test("sign-in choices name each Linux browser once, Edge included", () => {
  const env = { PATH: "/usr/bin" }
  // Built through browserCandidates so the paths use this host's separator; the repo's CI runs
  // the same test on Windows, where path.join makes \usr\bin\google-chrome.
  const candidates = browserCandidates("linux", env)
  const by = (name) => candidates.find((file) => path.basename(file) === name)
  const installed = new Set([
    by("google-chrome"),
    by("google-chrome-stable"),
    by("chromium"),
    by("microsoft-edge"),
    by("brave-browser"),
    "/opt/google/chrome/chrome",
  ])
  const exists = (file) => installed.has(file)
  const choices = browserOptions(env, "linux", exists)
  assert.deepEqual(choices, [
    { label: "Google Chrome", value: by("google-chrome") },
    { label: "Chromium", value: by("chromium") },
    { label: "Microsoft Edge", value: by("microsoft-edge") },
    { label: "Brave", value: by("brave-browser") },
  ])
})

// Two real browsers start here, and launchBrowser alone may wait 30 s for one of them to open its
// port. A 30 s test deadline therefore expired on a loaded runner while both launches were still
// inside their own budgets; the deadline has to cover two launches plus the CDP round trips.
test("a browser left in the legacy profile cannot block a new engine", { skip: !executable, timeout: 120_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-recovery-"))
  const opts = { executable, profileDir: path.join(root, "browser"), headless: true, proxy: "direct" }
  let old, next
  const muse = new Muse({ ...opts, site: "http://127.0.0.1" })
  try {
    old = await launchBrowser(opts)
    next = await muse.start()
    assert.notEqual(next.profileDir, old.profileDir)
    assert.notEqual(next.proc.pid, old.proc.pid)
    assert.ok(await next.browser.send("Browser.getVersion"))
    // Recovery must neither kill another browser nor delete its singleton lock.
    assert.ok(await old.browser.send("Browser.getVersion"))
    await muse.stop()
    assert.equal(existsSync(next.profileDir), false)
  } finally {
    await muse.stop()
    await old?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test("leftover temporary profiles are removed unless a live browser holds them", { skip: process.platform === "win32" && "symlinks need extra rights on Windows" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-sweep-"))
  const profile = (name: string, pid = 0) => {
    const dir = path.join(root, name)
    mkdirSync(path.join(dir, "Default"), { recursive: true })
    if (pid) symlinkSync(`${os.hostname()}-${pid}`, path.join(dir, "SingletonLock"))
    return dir
  }
  try {
    const gone = profile("run-gone", 2_147_000_000)
    const unlocked = profile("run-unlocked")
    const live = profile("run-live", process.pid)
    const other = profile("legacy-keep")
    await sweepProfiles(root)
    assert.equal(existsSync(gone), false)
    assert.equal(existsSync(unlocked), false)
    assert.equal(existsSync(live), true)
    assert.equal(existsSync(other), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a browser that exits during start reports its exit code and stderr", { skip: process.platform === "win32" && "a shell script needs a POSIX host", timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-start-"))
  const fake = path.join(root, "fake-browser")
  writeFileSync(fake, "#!/bin/sh\necho 'fake-browser: no usable display' >&2\nexit 7\n", { mode: 0o755 })
  try {
    await assert.rejects(
      launchBrowser({ executable: fake, profileDir: path.join(root, "browser"), temporary: true, waitMs: 5000 }),
      (err: any) => {
        assert.match(err.message, /exited during start \(code 7\)/)
        assert.match(err.message, /no usable display/)
        return true
      },
    )
    assert.deepEqual(readdirSync(path.join(root, "browser")), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed spawn rejects and removes its temporary profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-spawn-"))
  try {
    await assert.rejects(launchBrowser({ executable: path.join(root, "missing-browser"), profileDir: root, temporary: true }), { code: "ENOENT" })
    assert.deepEqual(readdirSync(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
