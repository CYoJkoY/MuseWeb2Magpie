// Sign-in in a visible browser window with a throwaway profile. Done when muse.ai has set the
// core cookies and /api/session accepts them; the cookies (httpOnly included) are read through
// CDP, never typed or seen by the user. Signing in sets only hatch_sess and the device cookie and
// leaves the user on the home page; the gateway and VM cookies come once the chat page loads,
// so the window is sent there.
import { randomBytes } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import { browserPathProblem, launchBrowser, normalizeBrowserPath, pageUrl } from "./browser.ts"
import { CDP, httpJSON } from "./cdp.ts"
import { fingerprintArgs, isFingerprintBrowser, stableFingerprintSeed } from "./fingerprint.ts"
import { AccountUnlinkedError, AuthError, ESSENTIAL, UNLINKED, renewSession } from "./muse.ts"
import type { Cookies, ExpiryMap, SavedAccount } from "./types.ts"

type LoginRun = {
  status: string
  step?: string
  note?: string
  handle?: string
  expires?: number | null
  label?: string
  error?: string
  stop?: () => void
  [key: string]: any
}

// A sign-in window needs a desktop. Linux servers and SSH sessions often have none.
export function noDesktop(platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

// The tab the sign-in window should be sent to, and only one this browser serves. /json/list
// answers on the port the browser wrote into DevToolsActivePort, but the sign-in poll can ask
// after that browser is gone: whoever holds the port then would receive the CDP session, and the
// engine would navigate a page of its choosing. A target on another host, another port or another
// endpoint kind is not this browser's page, so it is skipped; the tab on the configured site wins
// over whatever else the window happens to hold.
export function chatTarget(list: unknown, port: number, site: string): string | null {
  if (!Array.isArray(list)) return null
  const pages = list
    .filter((t: any) => t && t.type === "page")
    .map((t: any) => ({ address: pageUrl(t.webSocketDebuggerUrl, port), url: String(t.url || "") }))
    .filter((t): t is { address: string; url: string } => Boolean(t.address))
  const onSite = pages.find((t) => t.url.startsWith(site))
  return (onSite ?? pages[0])?.address ?? null
}

// What the sign-in window is showing, in the two answers that decide the run: a composer means the
// account can be used, and the 「Muse已解除关联」 screen means only a person can do anything.
const SCREEN_JS = `(function(){
  var b = document.body;
  return JSON.stringify({
    text: b ? b.innerText.slice(0, 2000) : "",
    composer: !!document.querySelector('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]')
  });
})()`

// A page that shows the unlinked screen instead of a composer is not a sign-in that can be
// finished from here: muse.ai replaced the chat with a form, and the form is the way back.
export function screenNeedsPerson(screen: { text: string; composer: boolean }): boolean {
  return !screen.composer && UNLINKED.test(String(screen.text || ""))
}

// Said while the window is still open, on the screen it is showing. Every step named here can be
// carried out in that window; the previous wording named a button on a page nothing had opened.
export function handOffProblem(): string {
  return "muse.ai 已解除这个账号的 Muse 关联（页面原文「Muse已解除关联」）：工作区的虚拟机被停用，重新登录不会恢复。"
    + "登录窗口还留着这一页——请在那个窗口里点「提交工单」，填「提交反馈」表单（主题选「账户访问与登录」），"
    + "等 muse.ai 重新关联后再登录一次；换一个没被解除关联的账号也能立刻继续用。"
    + "窗口会一直留着，直到你关掉它，或引擎停止。"
}

export class Logins {
  site: string
  host: string
  executable: string | undefined
  resolveExecutable: (() => Promise<any>) | undefined
  dir: string
  proxy: string
  fetchImpl: typeof fetch
  everyMs: number
  limitMs: number
  headless: boolean
  screenMs: number
  onDone: (cookies: Cookies, exp: ExpiryMap, label: string, vm: string) => Promise<SavedAccount>
  runs: Map<string, LoginRun>

  constructor({ site, executable, resolveExecutable, dir, proxy = "", fetchImpl = fetch, everyMs = 2000, limitMs = 15 * 60_000, headless = false, screenMs = 15_000, onDone }: {
    site: string
    executable?: string
    resolveExecutable?: () => Promise<any>
    dir: string
    proxy?: string
    fetchImpl?: typeof fetch
    everyMs?: number
    limitMs?: number
    headless?: boolean
    screenMs?: number
    onDone: (cookies: Cookies, exp: ExpiryMap, label: string, vm: string) => Promise<SavedAccount>
  }) {
    this.site = site.replace(/\/+$/, "")
    this.host = new URL(this.site).hostname
    Object.assign(this, { executable, resolveExecutable, dir, proxy, fetchImpl, everyMs, limitMs, headless, screenMs, onDone })
    this.runs = new Map<string, LoginRun>() // id → {status, step, handle?, expires?, error?, stop?}
  }

  // Closes every sign-in window still open, e.g. when the engine stops.
  stopAll() {
    for (const run of this.runs.values()) run.stop?.()
  }

  async openChat(port: number) {
    // Same bounded read as the launch probe: this is the same port, and the same squatter may be
    // the one answering it.
    const list: unknown = await httpJSON(`http://127.0.0.1:${port}/json/list`, 2000)
    const target = chatTarget(list, port, this.site)
    if (!target) {
      // A page that exists but is not this browser's is the squatter case: say so, instead of
      // leaving the sign-in waiting for a chat page that will never open.
      if (Array.isArray(list) && list.some((t: any) => t && t.type === "page")) {
        throw new Error(`登录窗口的调试端口 ${port} 上没有属于这个浏览器的页面，跳过打开聊天页`)
      }
      return
    }
    const page = await CDP.connect(target)
    try {
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
    } finally {
      page.close()
    }
  }

  async start(browser = ""): Promise<string> {
    const id = randomBytes(9).toString("base64url")
    const profileDir = path.join(this.dir, id)
    const run: LoginRun = { status: "starting" }
    this.runs.set(id, run)
    let stopped = false
    run.stop = () => {
      stopped = true
      if (run.status === "starting") Object.assign(run, { status: "failed", error: "引擎停止了，登录没有完成" })
    }
    if (!this.headless && noDesktop()) {
      Object.assign(run, { status: "failed", error: "这台 Linux 没有图形桌面（DISPLAY / WAYLAND_DISPLAY 都没设），弹不出登录窗口；请在有桌面的会话里登录" })
      return id
    }
    // The browser chosen in the sign-in prompt applies to this window only; anything else keeps
    // the engine's own default (the fingerprint browser, then MUSE_WEB_CHROME, then Chrome,
    // Edge, Chromium, Brave).
    const chosen = normalizeBrowserPath(String(browser || ""))
    if (chosen) {
      // The engine has the last word on a typed path: the plugin checks it too, but the engine is
      // what launches it, and a path that is relative or not a file must fail here with that
      // reason rather than a launch error about a browser that would not start.
      const problem = browserPathProblem(chosen)
      if (problem) {
        Object.assign(run, { status: "failed", error: problem })
        return id
      }
    }
    // Preparing the browser can mean waiting for the first-run download of the fingerprint
    // browser, which takes longer than the plugin waits for this HTTP answer. Give the id back
    // now and open the window as soon as the browser is ready; the status poll reports the rest.
    run.step = "正在准备浏览器（优先用 Donut Browser 的 Wayfern 内核，没有时第一次使用会先下载开源指纹浏览器）"
    this.launch(run, chosen, profileDir, () => stopped).catch((err: any) => {
      if (run.status !== "failed") Object.assign(run, { status: "failed", error: `打不开浏览器: ${err.message}` })
    })
    return id
  }

  async launch(run: LoginRun, chosen: string, profileDir: string, wasStopped: () => boolean) {
    // The engine's resolver picks (or downloads) the fingerprint browser; without one, the
    // executable the engine was started with, which is what older versions used directly.
    let resolved: any = null
    if (!chosen) {
      try {
        resolved = this.resolveExecutable ? await this.resolveExecutable() : null
      } catch (err: any) {
        Object.assign(run, { status: "failed", error: `没准备好浏览器: ${err.message}` })
        return
      }
    }
    if (wasStopped()) {
      Object.assign(run, { status: "failed", error: "引擎停止了，登录没有完成" })
      return
    }
    const picked = resolved && typeof resolved === "object" ? resolved : null
    const executable = chosen || (typeof resolved === "string" ? resolved : picked?.executable) || this.executable
    // A fingerprint browser chosen by path from the sign-in prompt keeps its persona flags too;
    // any other browser ignores them and is launched untouched.
    const extraArgs = chosen && isFingerprintBrowser(executable)
      ? fingerprintArgs({ seed: stableFingerprintSeed(this.dir), platform: process.platform })
      : chosen ? [] : picked?.extraArgs || []
    if (executable && !existsSync(executable)) {
      Object.assign(run, { status: "failed", error: `指定的浏览器不存在: ${executable}` })
      return
    }
    let opened
    try {
      opened = await launchBrowser({ executable, extraArgs, profileDir, headless: this.headless, proxy: this.proxy, url: `${this.site}/` })
    } catch (err: any) {
      Object.assign(run, { status: "failed", error: `打不开浏览器: ${err.message}` })
      return
    }
    if (wasStopped()) {
      // The engine can be asked to stop while the browser is being provisioned; close the
      // window that arrived late instead of leaving it on screen with a temp profile.
      await opened.close().catch(() => {})
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
      Object.assign(run, { status: "failed", error: "引擎停止了，登录没有完成" })
      return
    }
    run.status = "pending"
    run.step = "等你在窗口里登录"
    let closed = false
    let timer: ReturnType<typeof setInterval> | null = null
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
    const close = () => {
      if (closed) return
      closed = true
      stopPolling()
      opened.close().then(() => rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })).catch(() => {})
    }
    const finish = (fields: Partial<LoginRun>) => {
      if (run.status !== "pending") return
      Object.assign(run, fields)
      close()
    }
    // The window is left standing where the person can act on it: nothing is closed and the profile
    // is kept, because the form they are about to fill lives in that window. Closing the window by
    // hand, or stopping the engine, ends the run and cleans up as it always did.
    const hold = () => {
      // The window can close between the read and here; then the exit handler above has already
      // finished the run with its own words, and there is no window left to point at.
      if (closed) return
      Object.assign(run, { status: "failed", error: handOffProblem() })
      stopPolling()
      run.stop = () => close()
      opened.proc.once("exit", () => {
        if (closed) return
        closed = true
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 })
      })
    }
    run.stop = () => finish({ status: "failed", error: "引擎停止了，登录没有完成" })
    opened.proc.on("exit", () => { if (!closed) finish({ status: "failed", error: "登录窗口在登录完成前被关掉了" }) })
    const started = Date.now()
    let busy = false
    let sentToChat = 0
    timer = setInterval(async () => {
      if (busy || run.status !== "pending") return
      if (Date.now() - started > this.limitMs) return finish({ status: "failed", error: "登录超时" })
      busy = true
      try {
        const got = await this.cookies(opened.browser)
        if (got.cookies.hatch_sess && !ESSENTIAL.every((n) => got.cookies[n]) && Date.now() - sentToChat > 20_000) {
          sentToChat = Date.now()
          run.step = "已登录，正在打开聊天页领取会话"
          await this.openChat(opened.port)
        }
        if (ESSENTIAL.every((n) => got.cookies[n])) {
          run.step = "正在向 muse.ai 确认会话"
          const renewed = await renewSession(this.site, got.cookies, got.exp, { fetchImpl: this.fetchImpl, wakeVm: false })
          // Read the window before closing it. muse.ai answers /api/session for a workspace it has
          // already unlinked, so the page is the ground truth; and the 「提交工单」 form that
          // re-links the account exists only in this window. Closing first would leave the person
          // an instruction they can no longer carry out.
          if (!this.headless) {
            if (!sentToChat) {
              sentToChat = Date.now()
              await this.openChat(opened.port).catch(() => {})
            }
            run.step = "正在确认这个账号还能用（就看你登录的这个窗口）"
            const screen = await this.windowScreen(opened.port, this.screenMs)
            if (screenNeedsPerson(screen)) {
              hold()
              return
            }
          }
          // the window has done its part; onDone may still be checking the account answers
          close()
          run.step = "已领到会话，正在发一条测试消息确认账号能回答"
          try {
            const saved = await this.onDone(renewed.cookies, renewed.cookies_exp, renewed.label, renewed.vm)
            finish({ status: "done", handle: saved.handle, expires: saved.expires, label: saved.label, warning: saved.warning })
          } catch (err: any) {
            // The account was saved, then the test message met the unlinked screen: the window is
            // gone, so the message has to say that signing in again opens one.
            finish({ status: "failed", error: err instanceof AccountUnlinkedError ? `${err.message}重新登录一次，登录窗口会停在这一页，可以在那里提交工单。` : err.message })
          }
        }
      } catch (err: any) {
        if (!(err instanceof AuthError)) run.note = err.message
      } finally {
        busy = false
      }
    }, this.everyMs)
  }

  // What the window the person signed in through is showing, read on the port that window wrote.
  // Two answers end the wait: a composer, which means the account can be used, and the unlinked
  // screen, which means the form in this very window is the only way back. Anything else (a page
  // still painting, a site that has not decided yet) is waited out up to the ceiling, and the
  // caller then behaves exactly as it did before this check existed.
  async windowScreen(port: number, ms: number): Promise<{ text: string; composer: boolean }> {
    const end = Date.now() + ms
    let text = ""
    let composer = false
    while (Date.now() < end) {
      const list: unknown = await httpJSON(`http://127.0.0.1:${port}/json/list`, 2000).catch(() => null)
      const target = chatTarget(list, port, this.site)
      if (target) {
        const page = await CDP.connect(target).catch(() => null)
        if (page) {
          try {
            const seen = JSON.parse(String((await page.js(SCREEN_JS).catch(() => "")) || "{}") || "{}")
            text = String(seen.text || "")
            composer = Boolean(seen.composer)
          } finally {
            page.close()
          }
        }
      }
      if (composer || UNLINKED.test(text)) return { text, composer }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { text, composer }
  }

  async cookies(browser: any): Promise<{ cookies: Cookies; exp: ExpiryMap }> {
    const { cookies = [] } = await browser.send("Storage.getCookies", {}) as { cookies?: any[] }
    const out: { cookies: Cookies; exp: ExpiryMap } = { cookies: {}, exp: {} }
    for (const c of cookies) {
      const domain = String(c.domain || "").replace(/^\./, "")
      if (domain !== this.host && !this.host.endsWith(`.${domain}`)) continue
      out.cookies[c.name] = c.value
      if (c.expires > 0) out.exp[c.name] = Math.floor(c.expires)
    }
    return out
  }

  status(id: string): any {
    const run = this.runs.get(id)
    if (!run) return null
    const { status, step, note, handle, expires, label, warning, error } = run
    return {
      status,
      ...((status === "pending" || status === "starting") ? { step, ...(note ? { note } : {}) } : {}),
      ...(handle ? { handle, expires, label } : {}),
      ...(warning ? { warning } : {}),
      ...(error ? { error } : {}),
    }
  }
}
