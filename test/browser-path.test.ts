// The typed browser path is the only executable the engine launches on a person's word, so it has
// to be an absolute path naming a regular file. These tests pin the rule and its wording, which
// the sign-in prompt shows as-is.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { browserPathProblem, normalizeBrowserPath } from "../engine/browser.ts"

test("a pasted browser path keeps its real characters", () => {
  assert.equal(normalizeBrowserPath("  /usr/bin/chromium  "), "/usr/bin/chromium")
  assert.equal(normalizeBrowserPath('"/usr/bin/chromium"'), "/usr/bin/chromium")
  assert.equal(normalizeBrowserPath("  '/usr/bin/chromium'  "), "/usr/bin/chromium")
  assert.equal(normalizeBrowserPath(""), "")
  // Only a matching pair is stripped, so an unbalanced quote is left exactly as typed.
  assert.equal(normalizeBrowserPath('"/usr/bin/chro"mium'), '"/usr/bin/chro"mium')
})

test("a typed browser path must be absolute and name a file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-browser-path-"))
  try {
    const browser = path.join(dir, "chrome.exe")
    writeFileSync(browser, "")
    // A relative path means "relative to the engine's own directory", which is nobody's intent.
    assert.match(browserPathProblem("chrome.exe") ?? "", /绝对路径/)
    assert.match(browserPathProblem("./chrome.exe") ?? "", /绝对路径/)
    // Absolute, but not on this machine.
    assert.match(browserPathProblem(path.join(dir, "missing.exe")) ?? "", /不存在/)
    // A directory is not something that can be launched as a browser.
    mkdirSync(path.join(dir, "a-folder"))
    assert.match(browserPathProblem(path.join(dir, "a-folder")) ?? "", /不是可执行文件/)
    // The real thing, with and without the quotes a paste brings along.
    assert.equal(browserPathProblem(browser), null)
    assert.equal(browserPathProblem(`"${browser}"`), null)
    assert.match(browserPathProblem("") ?? "", /没有填/)
    assert.match(browserPathProblem("   ") ?? "", /没有填/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a Windows path is still absolute on Windows", { skip: process.platform !== "win32" }, () => {
  // Only checked where the answer is unambiguous: on POSIX, "C:\…" is a relative path.
  assert.match(browserPathProblem("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") ?? "", /不存在/)
})
