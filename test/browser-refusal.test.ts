// A kernel that ships inside another browser (Donut Browser's Wayfern, on its free plan) opens a
// window and serves CDP, but refuses Runtime.evaluate — the one call every page in this engine
// needs. Signing in only reads cookies and navigates, so it looked like a success, and the refusal
// surfaced much later as a chat page that never became ready. These tests are that kernel: a page
// that answers one question and a launcher that says no to the other.
import { test } from "node:test"
// @ts-nocheck
import assert from "node:assert/strict"
import { automationRefused, pageRefusal } from "../engine/browser.ts"
import { Muse } from "../engine/muse.ts"
import { loginPage } from "../engine/login-page.ts"

const REFUSAL = "Runtime.evaluate: Browser automation requires a paid Donut Browser plan."

test("a refusal is recognised by what the kernel says, not by a failed call", () => {
  assert.equal(automationRefused(REFUSAL), true)
  assert.equal(automationRefused("Browser automation requires a paid Donut Browser plan."), true)
  assert.equal(automationRefused("Browser automation is not allowed in this build"), true)
  assert.equal(automationRefused("browser automation is not available"), true)
  // Failures that are not a licence decision must not send the engine hunting for another browser:
  // a page still loading, a tab that went away, a debugger that never answered.
  assert.equal(automationRefused("CDP connect timed out"), false)
  assert.equal(automationRefused("Cannot find context with specified id"), false)
  assert.equal(automationRefused(""), false)
  assert.equal(automationRefused(undefined), false)
})

test("the probe tells a refusal apart from a page that answers or fails otherwise", async () => {
  const answers = { send: async () => ({ result: { value: 1 } }) }
  assert.equal(await pageRefusal(answers), "")

  const refuses = {
    send: async () => {
      throw new Error(REFUSAL)
    },
  }
  // The kernel's own sentence, with the call name trimmed off, so the message can name the fix
  // without repeating "Runtime.evaluate" in front of it.
  assert.equal(await pageRefusal(refuses), "Browser automation requires a paid Donut Browser plan.")

  const broken = {
    send: async () => {
      throw new Error("Cannot find context with specified id")
    },
  }
  assert.equal(await pageRefusal(broken), "")
})

function fakeLaunched(refuse) {
  return {
    browser: { onClose() {}, send() {} },
    proc: { once() {} },
    close: async () => {},
    refuse,
  }
}

test("a browser that refuses page script is replaced by the spare, and remembered", async () => {
  const launched: string[] = []
  const refusedFor: string[] = []
  const muse = new Muse({
    profileDir: "unused",
    executable: "C:/Chrome/chrome.exe",
    resolveExecutable: async () => ({ executable: "C:/Donut/wayfern.exe", extraArgs: ["--fingerprint"] }),
    launch: async (options) => {
      launched.push(options.executable)
      return fakeLaunched(options.executable === "C:/Donut/wayfern.exe")
    },
    probeAutomation: async (started) => (started.refuse ? "Browser automation requires a paid Donut Browser plan." : ""),
    onAutomationRefused: (executable) => refusedFor.push(executable),
  })

  const started = await muse.start()
  // The refused kernel is closed and never handed back; the system browser is what the engine runs
  // on, and the driver is told so the sign-in window stops choosing the kernel too.
  assert.deepEqual(launched, ["C:/Donut/wayfern.exe", "C:/Chrome/chrome.exe"])
  assert.equal(started.refuse, false)
  assert.deepEqual(refusedFor, ["C:/Donut/wayfern.exe"])
  assert.equal(muse.refused.get("C:/Donut/wayfern.exe"), "Browser automation requires a paid Donut Browser plan.")

  // A later start must not pay the refused kernel's probe again: it goes straight to the spare.
  launched.length = 0
  await muse.open("C:/Donut/wayfern.exe", ["--fingerprint"])
  assert.deepEqual(launched, ["C:/Chrome/chrome.exe"])
})

test("with no other browser, the refusal is reported as the reason and names the fix", async () => {
  const muse = new Muse({
    profileDir: "unused",
    resolveExecutable: async () => "C:/Donut/wayfern.exe",
    launch: async (options) => fakeLaunched(true),
    probeAutomation: async () => "Browser automation requires a paid Donut Browser plan.",
  })

  await assert.rejects(muse.start(), (err: any) => {
    assert.match(err.message, /浏览器启动失败/)
    assert.match(err.message, /不允许自动化/)
    assert.match(err.message, /Chrome、Edge 或 Chromium/)
    return true
  })
})

test("a saved sign-in that could not be confirmed says so on the page", () => {
  const warning = "已登录并保存；但没能用一条测试消息确认它能回答（页面加载超时），第一条对话会再试"
  const page = loginPage({ status: "done", handle: "acc-1", warning })
  assert.ok(page.includes("登录完成"))
  assert.ok(page.includes("没能用一条测试消息确认它能回答"))
  assert.ok(page.includes("可以关掉这个页面"))
  // A clean finish still reads as clean.
  const clean = loginPage({ status: "done", handle: "acc-1" })
  assert.ok(!clean.includes("没能用一条测试消息"))
})
