// Engine process. The plugin starts it detached with Magpie's own Bun; `node main.mjs` works too.
// Settings (all optional): MUSE_WEB_HOME, MUSE_WEB_ENGINE_PORT, MUSE_WEB_PROXY, MUSE_WEB_BROWSER
// (headless | hidden | show), MUSE_WEB_CHROME, MUSE_WEB_SITE, MUSE_WEB_IDLE_MIN.
// The default browser is the open-source fingerprint browser Apostate: a copy already on this
// machine is reused, otherwise the pinned release is downloaded once into the data directory.
// MUSE_WEB_FINGERPRINT=0 turns that off; MUSE_WEB_FINGERPRINT_BROWSER points at another copy;
// MUSE_WEB_FINGERPRINT_VERSION changes the release; MUSE_WEB_FINGERPRINT_PLATFORM sets the persona.
// MUSE_WEB_PARENT_PID is set by the plugin: the engine stops when that process exits.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"
import { findBrowser } from "./browser.mjs"
import { ensureFingerprintBrowser } from "./fingerprint.mjs"
import { anyFetch } from "./local-fetch.mjs"
import { Logins } from "./login.mjs"
import { AuthError, Muse, QuotaError, redact } from "./muse.mjs"
import { proxiedFetch, resolveProxy } from "./net.mjs"
import { watchParent } from "./parent.mjs"
import { dataDir, engineKey, enginePort } from "./paths.mjs"
import { createServer, VERSION } from "./server.mjs"
import { Store } from "./store.mjs"

const env = process.env
const dir = dataDir(env)
mkdirSync(dir, { recursive: true })
const logFile = path.join(dir, "engine.log")

function log(line) {
  process.stderr.write(line + "\n")
  try {
    if (statSync(logFile, { throwIfNoEntry: false })?.size > 5 << 20) renameSync(logFile, `${logFile}.1`)
    appendFileSync(logFile, line + "\n")
  } catch {}
}

const masked = (url) => String(url).replace(/\/\/[^@/]+@/, "//***@")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A new account's VM can still be warming when the test message goes out. Retry that, but not
// a refused session (AuthError) or a spent allowance (QuotaError, still a working sign-in).
async function verifyAccount(account, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      return await muse.verify(account)
    } catch (err) {
      last = err
      if (err instanceof AuthError || err instanceof QuotaError) throw err
      if (i < tries - 1) await sleep(8_000 * (i + 1))
    }
  }
  throw last
}
const key = engineKey(dir)
const port = enginePort(env)
const site = (env.MUSE_WEB_SITE || "https://muse.ai").replace(/\/+$/, "")
const proxy = resolveProxy(env)
const fetchImpl = proxiedFetch(proxy)
// What launches if the fingerprint browser cannot be had: a Chromium already on the machine.
const fallbackExecutable = findBrowser(env)
const mode = ["headless", "hidden", "show"].includes(env.MUSE_WEB_BROWSER) ? env.MUSE_WEB_BROWSER : "headless"
const idleMs = (Number(env.MUSE_WEB_IDLE_MIN) || 60) * 60_000
const prewarm = env.MUSE_WEB_PREWARM !== "0"
const verifyLogin = env.MUSE_WEB_VERIFY_LOGIN !== "0"

const store = new Store(path.join(dir, "accounts.json"))

// The browser for every window this engine opens. Runs once and is remembered, so the download
// (or the reuse of a local copy) happens once, and a request that arrives while it is running
// waits for it rather than starting a second install.
let browserReady = null
function prepareBrowser() {
  browserReady ??= (async () => {
    let picked = null
    try {
      picked = await ensureFingerprintBrowser({ dir, env, log, fetchImpl, exists: existsSync })
    } catch (err) {
      log(`指纹浏览器：准备失败，改用系统中的 Chromium（${redact(err.message)}）`)
      picked = null
    }
    if (picked?.executable) {
      log(`browser: ${picked.executable} (${picked.source}${picked.version ? ` ${picked.version}` : ""})`)
      return picked
    }
    if (fallbackExecutable) {
      log(`browser: ${fallbackExecutable} (system)`)
      return { executable: fallbackExecutable, extraArgs: [], source: "system", version: "" }
    }
    log("browser: 没有可用的浏览器——指纹浏览器没能下载，本机也没有 Chrome、Edge 或 Chromium")
    return null
  })()
  return browserReady
}

const muse = new Muse({
  site,
  executable: fallbackExecutable,
  resolveExecutable: prepareBrowser,
  profileDir: path.join(dir, "browser"),
  headless: mode === "headless",
  hidden: mode === "hidden",
  proxy,
  fetchImpl,
  onCookies: (id, cookies, exp, vm) => store.update(id, cookies, exp, vm),
  onLost: (why) => log(`${new Date().toTimeString().slice(0, 8)} browser lost (${why}) — a new one starts with the next request`),
})
const logins = new Logins({
  site,
  executable: fallbackExecutable,
  resolveExecutable: prepareBrowser,
  dir: path.join(dir, "login"),
  proxy,
  fetchImpl,
  headless: env.MUSE_WEB_LOGIN_HEADLESS === "1", // tests only: a person has to see the sign-in window
  onDone: async (c, e, label, vm) => {
    const saved = store.add(c, e, label, vm)
    // the account's context still holds the cookies of before
    if (saved.again) await muse.closeAccount(saved.handle).catch(() => {})
    woken.set(saved.handle, Date.now())
    if (verifyLogin) {
      const t0 = Date.now()
      const at = new Date().toTimeString().slice(0, 8)
      try {
        await verifyAccount(store.get(saved.handle))
        log(`${at} verify account=${saved.handle} ${Date.now() - t0}ms`)
      } catch (err) {
        log(`${at} verify account=${saved.handle} failed reason=${redact(err.message)}`)
        // a used-up account is still a working sign-in
        if (!(err instanceof QuotaError)) {
          if (!saved.again) {
            await muse.closeAccount(saved.handle).catch(() => {})
            store.remove(saved.handle)
          }
          throw new Error(`已登录，但账号没有回答测试消息：${err.message}`)
        }
      }
    }
    if (prewarm) warm([saved.handle])
    return saved
  },
})

// All accounts at once: each page spends its ~10 s waiting on its own VM, not on this machine,
// and Magpie may send the first message to any of them. Usage is read after, one at a time.
async function warm(handles) {
  const ready = await Promise.all(handles.map(async (handle) => {
    const account = store.get(handle)
    if (!account) return null
    const t0 = Date.now()
    try {
      await muse.warm(account)
      log(`${new Date().toTimeString().slice(0, 8)} warm account=${handle} ${Date.now() - t0}ms`)
      return account
    } catch (err) {
      log(`${new Date().toTimeString().slice(0, 8)} warm account=${handle} failed reason=${redact(err.message)}`)
      return null
    }
  }))
  for (const account of ready) if (account) await readUsage(account)
}

async function readUsage(account, maxAgeMs = 0) {
  const t0 = Date.now()
  const at = () => new Date().toTimeString().slice(0, 8)
  try {
    const u = await muse.readUsage(account, { maxAgeMs })
    if (u && u.at >= t0) log(`${at()} usage account=${account.id} ${Date.now() - t0}ms ${u.windows.map((w) => `${w.name}=${w.used}%`).join(" ")}`)
  } catch (err) {
    log(`${at()} usage account=${account.id} failed reason=${redact(err.message)}`)
  }
}

let lastUse = Date.now()
const server = createServer({
  muse,
  logins,
  store,
  key,
  port,
  site,
  log,
  onActivity: () => { lastUse = Date.now() },
  readUsage,
  onShutdown: () => shutdown("asked to stop"),
})

// Keep-alive as muse2api 1.6.1 has it: not a heartbeat, but a renewal and VM wake for an
// account nobody has woken for 6 hours. It is not use: the idle clock below doesn't move.
const KEEPALIVE_EVERY_MS = 6 * 3600_000
const woken = new Map(store.handles().map((h) => [h, Date.now()]))
setInterval(async () => {
  for (const handle of store.handles()) {
    const account = store.get(handle)
    if (!account || Date.now() - (woken.get(handle) || 0) < KEEPALIVE_EVERY_MS) continue
    woken.set(handle, Date.now())
    const at = new Date().toTimeString().slice(0, 8)
    try {
      const { vmState } = await muse.keepAlive(account)
      log(`${at} keepalive account=${handle} vm=${vmState || "?"}`)
    } catch (err) {
      log(`${at} keepalive account=${handle} failed reason=${redact(err.message)}`)
    }
  }
}, 30 * 60_000).unref()

// The browser is the heavy part; let it go when nobody has used the engine for a while.
setInterval(() => {
  if (muse.started && Date.now() - lastUse > idleMs) {
    log(`${new Date().toTimeString().slice(0, 8)} idle — browser closed until the next request`)
    muse.stop()
  }
}, 60_000).unref()

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    const other = await anyFetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json()).catch(() => null)
    if (other?.engine === "muse-web") {
      log(`another muse-web engine already serves port ${port}; leaving it running`)
      process.exit(0)
    }
    log(`port ${port} is taken by something else; set MUSE_WEB_ENGINE_PORT`)
    process.exit(1)
  }
  log(`engine error: ${err.message}`)
  process.exit(1)
})

server.listen(port, "127.0.0.1", () => {
  log(
    `muse-web engine ${VERSION} listening on http://127.0.0.1:${port} · ${store.count()} accounts · ` +
      `browser ${fallbackExecutable ? `fallback ${path.basename(fallbackExecutable)}` : "none yet"} (${mode}) · proxy ${masked(proxy)} · data ${dir}`,
  )
  // Getting the browser ready costs nothing when it is already here, and a download started now
  // is finished long before the first message.
  const ready = prepareBrowser()
  if (prewarm) ready.then((picked) => { if (picked?.executable) warm(store.handles()) }).catch(() => {})
})

async function shutdown(why) {
  log(`${new Date().toTimeString().slice(0, 8)} engine stopping (${why})`)
  logins.stopAll()
  await muse.stop().catch(() => {})
  process.exit(0)
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => shutdown(sig))

// Detached so a plugin reload or replacement does not kill it; this stops it when Magpie itself goes.
watchParent(env.MUSE_WEB_PARENT_PID, () => shutdown("Magpie exited"))
