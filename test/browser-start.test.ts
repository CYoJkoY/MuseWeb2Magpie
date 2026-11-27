import { test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { START_BUDGET_MS, launchBrowser, startBudget, startTimeout } from "../engine/browser.ts"

test("a start that times out says what the browser did and did not do", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-stall-"))
  const file = path.join(root, "DevToolsActivePort")
  try {
    // Nothing was written and the browser said nothing: both facts belong in the message, because
    // "timeout" alone cannot tell this apart from a port file that arrived and was never answered.
    const silent = startTimeout({ profileDir: root, stderr: "", last: null, waitedMs: 61_000 })
    assert.match(silent.message, /did not open its debugging port within 61 s/)
    assert.match(silent.message, /DevToolsActivePort still missing/)
    assert.match(silent.message, /last probe: none/)
    assert.match(silent.message, /browser said: nothing/)

    // A file that is there but holds something else is a different case, so the message quotes it.
    writeFileSync(file, "not-a-port\n")
    const wrong = startTimeout({ profileDir: root, stderr: "", last: new Error("port 9333 did not answer"), waitedMs: 2000 })
    assert.match(wrong.message, /within 2 s/)
    assert.match(wrong.message, /DevToolsActivePort holds "not-a-port\\n"/)
    assert.match(wrong.message, /last probe: port 9333 did not answer/)

    // Chrome's own last words are the only clue to why it is silent; the older ones are dropped.
    const noisy = startTimeout({
      profileDir: root,
      stderr: "first line\n\nsecond line\nthird line\nfourth line\n",
      last: null,
      waitedMs: 60_000,
    })
    assert.match(noisy.message, /browser said: second line \| third line \| fourth line\)$/)
    assert.doesNotMatch(noisy.message, /first line/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the start budget has one default and one way to raise it", () => {
  assert.equal(startBudget({}), START_BUDGET_MS)
  assert.equal(startBudget({ MUSE_WEB_START_MS: "120000" }), 120_000)
  // A value that is not a usable number of milliseconds leaves the default alone instead of
  // turning into "never wait at all" (or "wait forever").
  for (const value of ["", "0", "-5", "500", "soon", "NaN", "Infinity"]) {
    assert.equal(startBudget({ MUSE_WEB_START_MS: value }), START_BUDGET_MS, JSON.stringify(value))
  }
})

test("a browser that stays alive without opening its port is reported with what it said", { skip: process.platform === "win32" && "a shell script needs a POSIX host", timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-silent-"))
  const fake = path.join(root, "fake-browser")
  // Ignores the flags it is handed, writes a port file nobody can use, and stays alive: the shape
  // of a start that stalls instead of failing. The file it wrote also proves the message is built
  // before the temporary profile is removed — after that there is nothing left to quote.
  writeFileSync(fake, [
    "#!/bin/sh",
    'for arg in "$@"; do case "$arg" in --user-data-dir=*) dir="${arg#--user-data-dir=}";; esac; done',
    'echo "not-a-port" > "$dir/DevToolsActivePort"',
    "echo 'fake-browser: profile is locked' >&2",
    "exec sleep 30",
    "",
  ].join("\n"), { mode: 0o755 })
  const started = Date.now()
  try {
    await assert.rejects(
      launchBrowser({ executable: fake, profileDir: path.join(root, "browser"), temporary: true, waitMs: 1500 }),
      (err: any) => {
        assert.match(err.message, /did not open its debugging port within \d+ s/)
        assert.match(err.message, /DevToolsActivePort holds "not-a-port\\n"/)
        assert.match(err.message, /profile is locked/)
        return true
      },
    )
    // The wait is the budget, not the browser: a silent process must not hold the engine longer.
    assert.ok(Date.now() - started < 10_000, `waited ${Date.now() - started} ms`)
    assert.deepEqual(readdirSync(path.join(root, "browser")), [])
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
