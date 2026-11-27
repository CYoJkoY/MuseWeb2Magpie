// Find and start a Chromium-family browser on macOS, Windows or Linux.
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs"
import { rm } from "node:fs/promises"
import path from "node:path"
import { CDP, httpJSON } from "./cdp.ts"
import { proxyForBrowser } from "./net.ts"

export function browserCandidates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") {
    const apps: Array<[string, string]> = [
      ["Google Chrome", "Google Chrome"],
      ["Microsoft Edge", "Microsoft Edge"],
      ["Chromium", "Chromium"],
      ["Brave Browser", "Brave Browser"],
    ]
    const roots = ["/Applications", path.join(env.HOME || "", "Applications")]
    return roots.flatMap((root) => apps.map(([app, bin]) => path.join(root, `${app}.app`, "Contents", "MacOS", bin)))
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean)
    const rels: Array<string[]> = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ]
    return rels.flatMap((rel) => roots.map((root) => path.win32.join(root, ...rel)))
  }
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]
  const dirs = (env.PATH || "/usr/bin:/usr/local/bin").split(path.delimiter).concat(["/usr/bin", "/snap/bin", "/opt/google/chrome"])
  return [...new Set(dirs)].flatMap((dir) => names.map((name) => path.join(dir, name))).concat(["/opt/google/chrome/chrome"])
}

export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists = existsSync): string | null {
  const own = (env.MUSE_WEB_CHROME || "").trim()
  if (own) return exists(own) ? own : null
  return browserCandidates(platform, env).find((p) => exists(p)) ?? null
}

// normalizeBrowserPath is what a person types into the sign-in prompt: paths get pasted with
// surrounding quotes often enough to be worth accepting, and a trailing slash is never intended.
export function normalizeBrowserPath(file: string): string {
  let typed = String(file || "").trim()
  while (typed.length >= 2 && ((typed.startsWith("\"") && typed.endsWith("\"")) || (typed.startsWith("'") && typed.endsWith("'")))) {
    typed = typed.slice(1, -1).trim()
  }
  return typed
}

// browserPathProblem says why a typed browser path cannot be used, or null when it can. The path
// has to be absolute and has to name a regular file: a relative path would be resolved against
// whatever directory the engine happens to run in, so it either fails for no visible reason or
// launches a different program than the one the person pointed at; a directory or a device would
// fail later, inside the launch, with a message about a broken browser instead of a broken path.
export function browserPathProblem(file: string): string | null {
  const typed = normalizeBrowserPath(file)
  if (!typed) return "没有填浏览器路径"
  if (!path.isAbsolute(typed)) return `浏览器路径要是完整的绝对路径：${typed}`
  let info
  try {
    info = statSync(typed)
  } catch {
    return `浏览器路径不存在：${typed}`
  }
  if (!info.isFile()) return `浏览器路径不是可执行文件：${typed}`
  return null
}

// The name a person recognizes for a browser executable, used in the sign-in choices.
function browserName(file: string): string {
  const lower = file.toLowerCase()
  // Linux ships the binary as microsoft-edge / microsoft-edge-stable, Windows as msedge.exe,
  // macOS as "Microsoft Edge.app/…/Microsoft Edge".
  if (lower.includes("msedge") || lower.includes("microsoft-edge") || lower.includes("microsoft edge")) return "Microsoft Edge"
  if (lower.includes("brave")) return "Brave"
  if (lower.includes("chromium")) return "Chromium"
  return "Google Chrome"
}

// The sign-in prompt's choices: only browsers that are actually installed, one entry per browser.
// MUSE_WEB_CHROME comes first when it points at an installed file, since the engine would have
// picked it by itself; choosing an entry overrides that default for this sign-in only.
export function browserOptions(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists = existsSync): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []
  const seen = new Set<string>()
  // One entry per browser, not per path: one Linux install offers google-chrome,
  // google-chrome-stable and /opt/google/chrome/chrome for the same Chrome, and a person
  // choosing at sign-in wants to see each browser once.
  const add = (file: string, name: string, label = name) => {
    if (seen.has(name)) return
    seen.add(name)
    out.push({ label, value: file })
  }
  const own = (env.MUSE_WEB_CHROME || "").trim()
  if (own && exists(own)) add(own, browserName(own), `MUSE_WEB_CHROME（${browserName(own)}）`)
  for (const file of browserCandidates(platform, env)) {
    if (exists(file)) add(file, browserName(file))
  }
  return out
}

// The debugging port is the browser's to choose. Asking the OS for a free port and handing it to
// the browser leaves a window in which any local process can take that port first, answer the
// /json/version probe with its own WebSocket address, and then receive the CDP connection that
// carries the account's cookies. Chromium writes <profileDir>/DevToolsActivePort once its own
// listener is up — the port it actually owns, and the browser path it serves — so the engine
// reads the port from there instead of guessing one.
export function readActivePort(dir: string): number {
  let text = ""
  try {
    text = readFileSync(path.join(dir, "DevToolsActivePort"), "utf8")
  } catch {
    return 0
  }
  // The file is two short lines; anything larger is not the file this function expects.
  if (text.length > 4096) return 0
  const [first, second] = text.split(/\r?\n/)
  const port = Number(first)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 0
  // The second line is the browser's own WebSocket path; without it this is not Chrome's file.
  if (!String(second || "").startsWith("/devtools/browser/")) return 0
  return port
}

// The debugger address this browser is actually serving, or null. The port came from the
// browser's own file, so the answer on it has to point back at that same port on loopback with a
// browser path; anything else is a different listener that happened to hold the port.
export function debuggerUrl(value: unknown, port: number): string | null {
  try {
    const url = new URL(String(value || ""))
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null
    if (url.port !== String(port)) return null
    const host = url.hostname.replace(/^\[|\]$/g, "")
    if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") return null
    if (!url.pathname.startsWith("/devtools/browser/")) return null
    return url.toString()
  } catch {
    return null
  }
}

// proxy: "" leaves the browser on the system's own setting, "direct" ignores it, a URL forces it.
// hidden: a real window placed off-screen, for sites that treat headless differently.
// extraArgs: flags only one browser understands (Apostate's --fingerprint), left empty for Chrome.
export interface BrowserArgs {
  port: number
  profileDir: string
  headless?: boolean
  hidden?: boolean
  proxy?: string
  url?: string
  extraArgs?: string[]
}

export function browserArgs({ port, profileDir, headless, hidden = false, proxy, url = "about:blank", extraArgs = [] }: BrowserArgs): string[] {
  // No --remote-allow-origins: it defaults to off, so a page loaded in this browser cannot talk to
  // its own DevTools port. Our CDP client is a WebSocket without an Origin header, which Chrome
  // still accepts, so the engine keeps full control while a hostile site in the profile cannot
  // drive the browser or read the signed-in muse.ai session.
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    // Each engine browser starts on a new profile; without these Chrome downloads its components
    // and on-device models (about 100 MB) into every one of them.
    "--disable-component-update",
    "--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints,Translate,MediaRouter",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,900",
    "--proxy-bypass-list=<-loopback>",
    // Cookies go in and out through CDP, so the profile needs no OS keychain; without these
    // macOS asks for one (and shows "keychain not found" under a HOME that has none).
    "--use-mock-keychain",
    "--password-store=basic",
  ]
  if (headless) args.push("--headless=new", "--disable-gpu")
  else {
    // Chrome's background mode keeps a tray process on Windows that later launches hand off to;
    // the flag also stops an engine browser from outliving the engine.
    args.push("--disable-background-mode", "--new-window")
    if (hidden) args.push("--window-position=-32000,-32000")
  }
  if (proxy === "direct") args.push("--no-proxy-server")
  // Chrome rejects a proxy with a path (ERR_NO_SUPPORTED_PROXIES) and drops credentials in this
  // argument anyway, so proxyForBrowser trims the slash and leaves the user:password out of a
  // command line that every local user can read.
  else if (proxy) args.push(`--proxy-server=${proxyForBrowser(proxy)}`)
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox")
  for (const arg of extraArgs || []) if (arg) args.push(String(arg))
  args.push(url)
  return args
}

// Whether a Chrome is still using this profile. On macOS and Linux its SingletonLock is a
// symlink to "host-pid"; Windows keeps the profile's files open, so removing it fails there.
function inUse(dir: string): boolean {
  try {
    const pid = Number(readlinkSync(path.join(dir, "SingletonLock")).split("-").pop())
    if (!(pid > 0)) return false
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err.code === "EPERM"
  }
}

// Removes the temporary profiles of browsers that are gone: an engine killed outright or a
// power cut skips the cleanup on close. The list is read before returning, so a profile made
// after the call is never touched; the removal itself runs on in the background.
export function sweepProfiles(root: string): Promise<void> {
  let names: string[] = []
  try {
    names = readdirSync(root).filter((n) => n.startsWith("run-"))
  } catch {
    return Promise.resolve()
  }
  return Promise.all(names.map((n) => path.join(root, n)).filter((dir) => !inUse(dir))
    .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {}))).then(() => {})
}

const STDERR_LIMIT = 4096

// Chrome's own message (a missing library, a locked profile, a rejected flag) is the only useful
// clue when it exits before its debugging port opens; a bare "exited during start" hides all of it.
function startFailure({ code, signal, stderr }: { code: number | null; signal: string | null; stderr: string }): Error {
  const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
  const detail = String(stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")
  return new Error(`browser exited during start (${status})${detail ? `: ${detail}` : ""}`)
}

export interface Launched {
  proc: ChildProcess
  port: number
  browser: CDP
  profileDir: string
  close: () => Promise<void>
}

export interface LaunchOptions {
  executable: string
  profileDir: string
  temporary?: boolean
  headless?: boolean
  hidden?: boolean
  proxy?: string
  url?: string
  waitMs?: number
  extraArgs?: string[]
}

export async function launchBrowser({ executable, profileDir, temporary = false, headless = true, hidden = false, proxy = "", url = "about:blank", waitMs = 30_000, extraArgs = [] }: LaunchOptions): Promise<Launched> {
  if (!executable) {
    throw new Error("没找到可用的浏览器：本机没有 Donut Browser 和内嵌的 Wayfern 内核，开源指纹浏览器 Apostate 也没能下载，"
      + "本机也没有 Chrome、Edge 或 Chromium；联网后重试，或用 MUSE_WEB_DONUT_BROWSER / MUSE_WEB_FINGERPRINT_BROWSER"
      + " / MUSE_WEB_CHROME 指定一个可执行文件")
  }
  mkdirSync(profileDir, { recursive: true })
  // Cookies are restored from the account store. A fresh profile also isolates us
  // from a browser left alive by a crashed engine or an asynchronous shutdown.
  if (temporary) {
    sweepProfiles(profileDir)
    profileDir = mkdtempSync(path.join(profileDir, "run-"))
  }
  // A file left behind by an earlier browser names a port this one does not own; the browser
  // writes its own as soon as its listener is up, and trusting the old one would hand the
  // connection to whoever holds that port now.
  rmSync(path.join(profileDir, "DevToolsActivePort"), { force: true })
  const cleanup = async () => {
    if (temporary) await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
  }
  let proc: ChildProcess
  try {
    proc = spawn(executable, browserArgs({ port: 0, profileDir, headless, hidden, proxy, url, extraArgs }), {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: headless || hidden,
    })
  } catch (err) {
    await cleanup()
    throw err
  }
  let stderr = ""
  proc.stderr?.setEncoding("utf8")
  proc.stderr?.on("error", () => {})
  proc.stderr?.on("data", (chunk) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk
  })
  const stderrDone = new Promise<void>((resolve) => {
    if (!proc.stderr) return resolve()
    proc.stderr.once("close", resolve)
    proc.stderr.once("error", resolve)
  })
  let exited = false
  let exitInfo: { code: number | null; signal: string | null } = { code: null, signal: null }
  let spawnError: Error | null = null
  proc.on("error", (err) => { spawnError = err })
  proc.on("exit", (code, signal) => {
    exited = true
    exitInfo = { code, signal }
  })
  let closing: Promise<void> | undefined
  const close = (browser?: CDP): Promise<void> => (closing ??= stopBrowser(proc, browser).finally(cleanup))
  const started = Date.now()
  let last = null
  while (Date.now() - started < waitMs) {
    if (spawnError || exited) {
      // Let the last stderr chunks arrive before closing: the exit event can come first.
      if (exited) await Promise.race([stderrDone, new Promise<void>((r) => setTimeout(r, 200))])
      await close()
      throw spawnError || startFailure({ ...exitInfo, stderr })
    }
    const active = readActivePort(profileDir)
    if (active) {
      try {
        const v = await httpJSON(`http://127.0.0.1:${active}/json/version`, 1500)
        const ws = debuggerUrl(v?.webSocketDebuggerUrl, active)
        if (ws) {
          const browser = await CDP.connect(ws)
          return { proc, port: active, browser, profileDir, close: () => close(browser) }
        }
        last = new Error(`port ${active} did not answer as this browser's debugger`)
      } catch (err) {
        last = err
      }
    }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
  await close()
  throw new Error(`browser did not open its debugging port: ${last?.message ?? "timeout"}`)
}

// Resolves once the process is gone: asked politely first, killed after 3 s.
export function stopBrowser(proc: ChildProcess, browser?: CDP): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  const gone = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
  try {
    browser?.send("Browser.close", {}, 3000).catch(() => {})
  } catch {}
  const kill = setTimeout(() => {
    try { proc.kill() } catch {}
  }, 3000)
  return gone.finally(() => clearTimeout(kill))
}
