import { test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { launchBrowser, termsDisabled, termsError, termsRequired } from "../engine/browser.ts"

// What a kernel that has never been started prints before it exits 1.
const KERNEL_SAID = [
  "To accept the terms and continue, run:",
  "| ./Chromium --accept-terms-and-conditions |",
  "========================================",
].join("\n")

test("the terms request is found in the whole message, not the last three lines", () => {
  assert.equal(termsRequired(KERNEL_SAID), true)
  // The existing tail keeps three lines; a message that grows past that still has to be seen.
  assert.equal(termsRequired(KERNEL_SAID + "\nno window system\nretrying once\nbye"), true)
  assert.equal(termsRequired("fake-browser: no usable display"), false)
  assert.equal(termsRequired(""), false)
  assert.equal(termsRequired(undefined), false)
})

test("only an explicit no keeps the engine from accepting the terms", () => {
  for (const value of ["0", "off", "no", "false", " OFF "]) {
    assert.equal(termsDisabled({ MUSE_WEB_ACCEPT_TERMS: value }), true)
  }
  for (const value of ["", "1", "yes", "true", "on"]) {
    assert.equal(termsDisabled({ MUSE_WEB_ACCEPT_TERMS: value }), false)
  }
  assert.equal(termsDisabled({}), false)
})

test("a refusal names the executable and the command to run", () => {
  const err = termsError("C:\\Program Files\\Donut\\Wayfern\\chrome.exe", KERNEL_SAID)
  assert.ok(err.message.includes("\"C:\\Program Files\\Donut\\Wayfern\\chrome.exe\""))
  assert.match(err.message, /--accept-terms-and-conditions/)
  assert.match(err.message, /MUSE_WEB_ACCEPT_TERMS=0/)
  // The kernel's own words survive, so a refusal for another reason is still readable.
  assert.match(err.message, /To accept the terms/)
})

// A shell script needs a POSIX host; the Windows runner exercises the pure functions above.
const posix = { skip: process.platform === "win32" && "a shell script needs a POSIX host", timeout: 30_000 }

// The fake kernel counts its starts, records the licence the way the real one does, and prints the
// request while it is still unanswered. After the answer it starts but never opens a port, which
// is the failure this test is not about: it is what the retry is seen through.
function fakeKernel(root: string): { fake: string; runs: string; accepted: string } {
  const fake = path.join(root, "fake-kernel")
  const runs = path.join(root, "runs")
  const accepted = path.join(root, "accepted")
  const script = [
    "#!/bin/sh",
    `runs='${runs}'`,
    `accepted='${accepted}'`,
    "n=$(cat \"$runs\" 2>/dev/null || echo 0)",
    "echo $((n + 1)) > \"$runs\"",
    "if [ \"$1\" = \"--accept-terms-and-conditions\" ]; then",
    "  : > \"$accepted\"",
    "  exit 0",
    "fi",
    "if [ -f \"$accepted\" ]; then",
    "  exit 0",
    "fi",
    "cat >&2 <<'END'",
    "To accept the terms and continue, run:",
    "| ./Chromium --accept-terms-and-conditions |",
    "========================================",
    "END",
    "exit 1",
  ].join("\n")
  writeFileSync(fake, script, { mode: 0o755 })
  return { fake, runs, accepted }
}

test("a kernel that asks for its licence is accepted once and started again", posix, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-terms-"))
  const { fake, runs, accepted } = fakeKernel(root)
  try {
    await assert.rejects(
      launchBrowser({ executable: fake, profileDir: path.join(root, "browser"), temporary: true, waitMs: 1200 }),
      (err: any) => {
        // The second start got past the licence; it stops on its own terms after that.
        assert.match(err.message, /exited during start \(code 0\)/)
        return true
      },
    )
    // One start that asked, the acknowledgement command, and one start after the answer.
    assert.equal(readFileSync(runs, "utf8").trim(), "3")
    assert.equal(existsSync(accepted), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("MUSE_WEB_ACCEPT_TERMS=0 leaves the decision to the person", posix, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mw-terms-off-"))
  const { fake, runs, accepted } = fakeKernel(root)
  try {
    await assert.rejects(
      launchBrowser({
        executable: fake,
        profileDir: path.join(root, "browser"),
        temporary: true,
        waitMs: 1200,
        env: { MUSE_WEB_ACCEPT_TERMS: "0" },
      }),
      (err: any) => {
        assert.match(err.message, /--accept-terms-and-conditions/)
        assert.match(err.message, /MUSE_WEB_ACCEPT_TERMS=0/)
        return true
      },
    )
    assert.equal(readFileSync(runs, "utf8").trim(), "1")
    assert.equal(existsSync(accepted), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
