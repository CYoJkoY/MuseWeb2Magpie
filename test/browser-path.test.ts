// The typed browser path is the only executable the engine launches on a person's word, so it has
// to be an absolute path naming a regular file. These tests pin the rule and its wording, which
// the sign-in prompt shows as-is.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { browserOptions, browserPathProblem, findBrowser, normalizeBrowserPath } from "../engine/browser.ts"

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
  // The path must be one no runner has: the GitHub Windows image ships Chrome, so naming
  // Chrome would test whether Chrome is installed instead of whether the path is judged.
  assert.match(browserPathProblem("C:\\Program Files\\MuseWeb2Magpie Missing Browser\\chrome.exe") ?? "", /不存在/)
})

test("the configured browser follows the typed path rule", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-configured-browser-"))
  try {
    const browser = path.join(dir, "chrome.exe")
    writeFileSync(browser, "")
    mkdirSync(path.join(dir, "browser-dir"))
    // A real file at an absolute path is used as configured.
    assert.equal(findBrowser({ MUSE_WEB_CHROME: browser }, process.platform, existsSync, statSync), browser)
    // A bare name would be resolved against the engine's own directory, so it is set aside
    // instead of being handed to spawn — even when something with that name exists there.
    assert.equal(findBrowser({ MUSE_WEB_CHROME: "chrome.exe", PATH: "/usr/bin" }, process.platform, () => true, statSync), null)
    // A directory and a path that is not there are set aside the same way.
    assert.equal(findBrowser({ MUSE_WEB_CHROME: path.join(dir, "browser-dir") }, process.platform, existsSync, statSync), null)
    assert.equal(findBrowser({ MUSE_WEB_CHROME: path.join(dir, "missing.exe") }, process.platform, existsSync, statSync), null)
    // The sign-in choices agree: a configured value that fails the rule is not offered.
    const choices = browserOptions({ MUSE_WEB_CHROME: "chrome.exe", PATH: "/usr/bin" }, "linux", () => true, () => ({ isFile: () => true }))
    assert.equal(choices.some((choice) => choice.label.startsWith("MUSE_WEB_CHROME")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
