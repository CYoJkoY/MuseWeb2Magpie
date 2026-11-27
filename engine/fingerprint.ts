// An open-source fingerprint browser (Apostate, GPL-3.0) as the engine's default browser.
// A copy already on this machine is reused first; otherwise the pinned release is downloaded
// once into the data directory and kept there. Everything is pure and injectable (fetch, fs
// probes, clock) so it can be tested without a network or a real browser.
//
// Why a fingerprint browser: muse.ai treats a bare headless Chromium like a bot. Apostate is a
// Chromium build that presents a consistent Windows/macOS/Linux persona (GPU, screen, fonts,
// locale, timezone) from C++, with no JS patch and no DevTools override, so the same host looks
// like a normal machine. --fingerprint keeps that persona stable across restarts.
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, closeSync, existsSync as fsExists, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { inflateRawSync, zstdDecompressSync } from "node:zlib"
import { writePrivate } from "./paths.ts"
import type { PickedBrowser } from "./types.ts"

export const APOSTATE_REPO = "heretic-tech/apostate"
// Pinned so a download is reproducible and verifiable. The GitHub API is asked first for the
// exact release; this is the fallback, and the source of the sha256 when the API is unreachable.
// Names and hashes were read from each release asset's ".manifest.json" (v0.5.1, Chromium 155).
export const APOSTATE_PIN = {
  version: "0.5.1",
  release: "v0.5.1",
  chromium: "155.0.8059.31",
  assets: {
    "win32-x64": { name: "apostate-155.0.8059.31-windows-x64.zip", sha256: "8e55e44fb7f58619461e1d42a947446dcc08a2b46493c420c8e62ae27ab9c7e5" },
    "linux-x64": { name: "apostate-155.0.8059.31-linux-x64.tar.zst", sha256: "351955271b7ba1aed314bf14c2d64f6bd59bfdcb5c4a1541c9c921c570ff97bb" },
    "linux-arm64": { name: "apostate-155.0.8059.31-linux-arm64.tar.zst", sha256: "e63e3023e4a691a1ee104074331894dec18567a41b42472e782c910588453a7c" },
    "darwin-arm64": { name: "apostate-155.0.8059.31-macos-arm64.zip", sha256: "58176ba9b3e9cfd74029165bdf716c636e618af17a48bd905fe6d5f1552d901a" },
  },
}

const DISABLED = new Set(["0", "off", "false", "no", "none", "disabled"])

// The persona Apostate should present: a Windows/macOS/Linux identity independent of the host.
// Defaults to the host's own OS (fonts and metrics line up), overridable for a fixed persona.
export function personaFor(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const own = String(env.MUSE_WEB_FINGERPRINT_PLATFORM || "").trim().toLowerCase()
  if (own === "windows" || own === "win") return "windows"
  if (own === "macos" || own === "darwin" || own === "mac") return "macos"
  if (own === "linux") return "linux"
  if (platform === "win32") return "windows"
  if (platform === "darwin") return "macos"
  return "linux"
}

// The flags Apostate reads to hold a stable persona. A non-Apostate browser ignores them.
export function fingerprintArgs({ seed, platform = process.platform, env = process.env }: { seed: string | number; platform?: string; env?: NodeJS.ProcessEnv }): string[] {
  return [`--fingerprint=${seed}`, `--fingerprint-platform=${personaFor(platform, env)}`]
}

// Only Apostate takes the fingerprint flags; a plain Chrome/Chromium must launch untouched.
export function isFingerprintBrowser(executable: unknown): boolean {
  return /apostate/i.test(String(executable || ""))
}

// Donut Browser (donutbrowser/donutbrowser, AGPL-3.0) ships its own Chromium fork, Wayfern, under
// <data>/binaries/wayfern/<version>/. At the command line Wayfern is an ordinary Chromium, so it
// runs with the same flags as Chrome: no fingerprint flags, no Donut protocol, no paid token.
// Reusing it means the browser someone already uses every day is preferred over a second download.
export const DONUT_ENV = "MUSE_WEB_DONUT_BROWSER"

export function isWayfernBrowser(executable: unknown): boolean {
  return /[\\/]wayfern[\\/]/i.test(String(executable || ""))
}

const KERNEL_NAME = /^(chrome|chromium)(\.exe)?$/i

// Version folders compare as numbers, so "156.0.8078.86" beats "155.0.8059.31".
function compareVersions(a: string, b: string): number {
  const left = String(a).split(/[.\-+_]/).map((part) => Number(part) || 0)
  const right = String(b).split(/[.\-+_]/).map((part) => Number(part) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff) return diff
  }
  return 0
}

// The newest Wayfern kernel under <root>/binaries/wayfern, or null when Donut has not fetched one.
export function wayfernIn(root: string, platform: string = process.platform): string | null {
  const binaries = path.join(String(root || ""), "binaries", "wayfern")
  let versions: string[]
  try { versions = readdirSync(binaries) } catch { return null }
  for (const version of versions.sort(compareVersions).reverse()) {
    const found = findExecutable(path.join(binaries, version), platform)
    if (found) return found
  }
  return null
}

// Where Donut Browser keeps its data, in the order Donut resolves it: the two env overrides, the
// per-user data folder, then a portable/Scoop install (which keeps its data beside the exe).
export function donutDataRoots(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const out: string[] = []
  const add = (value: unknown) => {
    const dir = String(value || "").trim()
    if (dir) out.push(dir)
  }
  add(env.DONUTBROWSER_DATA_DIR)
  const root = String(env.DONUTBROWSER_DATA_ROOT || "").trim()
  if (root) add(path.join(root, "data"))
  const home = env.HOME || env.USERPROFILE || os.homedir()
  if (platform === "win32") {
    if (env.LOCALAPPDATA) add(path.join(env.LOCALAPPDATA, "DonutBrowser"))
  } else if (platform === "darwin") {
    add(path.join(home, "Library", "Application Support", "DonutBrowser"))
  } else {
    add(path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "DonutBrowser"))
  }
  const scoop: string[] = []
  for (const base of [env.SCOOP, env.SCOOP_GLOBAL]) if (base) scoop.push(base)
  if (env.USERPROFILE) scoop.push(path.join(env.USERPROFILE, "scoop"))
  for (const base of scoop) add(path.join(base, "apps", "donutbrowser", "current"))
  return [...new Set(out)]
}

// Every place a Wayfern kernel could be: the MUSE_WEB_DONUT_BROWSER override (a kernel itself or a
// Donut folder), then the folders Donut uses on its own. A folder is tried both as the data root
// and as the install folder that holds it.
export function wayfernCandidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] {
  const out: string[] = []
  const add = (file: string | null) => {
    if (file && !out.includes(file)) out.push(file)
  }
  const own = String(env[DONUT_ENV] || "").trim()
  // "off" means this person does not want Donut used at all, not just "use the default folders".
  if (DISABLED.has(own.toLowerCase())) return []
  if (own) {
    if (KERNEL_NAME.test(path.basename(own))) add(own)
    else {
      add(wayfernIn(own, platform))
      add(wayfernIn(path.join(own, "data"), platform))
    }
  }
  for (const root of donutDataRoots(env, platform)) {
    add(wayfernIn(root, platform))
    add(wayfernIn(path.join(root, "data"), platform))
  }
  return out
}

export function findWayfernBrowser(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = fsExists): string | null {
  return wayfernCandidates(env, platform).find((p) => p && exists(p)) ?? null
}

// A persona seed that stays the same across restarts, so the browser keeps one machine identity.
// Apostate's seed is an integer; a random 31-bit value is stable enough and hard to fingerprint.
export function stableFingerprintSeed(dir: string): string {
  const file = path.join(dir, "fingerprint.json")
  try {
    const got = JSON.parse(readFileSync(file, "utf8"))
    const n = Number(got?.seed)
    if (Number.isInteger(n) && n > 0) return String(n)
  } catch {}
  const seed = String(1 + (randomBytes(4).readUInt32BE(0) % 2_000_000_000))
  try { writePrivate(file, JSON.stringify({ seed }) + "\n") } catch {}
  return seed
}

const OS_TOKENS = { win32: ["windows", "win"], darwin: ["macos", "darwin", "osx", "mac"], linux: ["linux"] }
const ARCH_TOKENS = { x64: ["x64", "amd64", "x86_64"], arm64: ["arm64", "aarch64"] }
const EXT_RE = /\.(zip|tar\.zst|tzst|tgz|tar\.gz|tar|dmg)$/i

// The one release asset for this host: right OS token, right arch token, a decompressible suffix.
// Release "assets" are the shapes GitHub's API returns ({name, browser_download_url, size}) or a
// plain [{name, url}] list.
export function pickReleaseAsset(assets: any, platform: string = process.platform, arch: string = process.arch): any | null {
  const os = (OS_TOKENS as Record<string, string[]>)[platform]
  const cpu = (ARCH_TOKENS as Record<string, string[]>)[arch]
  if (!os || !cpu) return null
  for (const asset of assets || []) {
    const name = String(asset?.name || asset?.browser_download_url || asset?.url || "").toLowerCase()
    if (!EXT_RE.test(name)) continue
    if (!os.some((t) => name.includes(t))) continue
    if (!cpu.some((t) => name.includes(t))) continue
    return asset
  }
  return null
}

export function verifySha256(data: Buffer | Uint8Array, expectedHex: unknown): boolean {
  const want = String(expectedHex || "").trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(want)) return false
  return createHash("sha256").update(data).digest("hex") === want
}

function baseName(p: unknown): string {
  return path.basename(String(p || "")).toLowerCase()
}

// The browser executable inside an extracted Apostate tree. Windows ships chrome.exe, macOS the
// app bundle's Contents/MacOS/Chromium, Linux a plain chrome binary (all under a folder named
// after the build). Files are checked before directories and shallower paths first, so the top-
// level binary wins over anything in a helper bundle.
export function findExecutable(root: string, platform: string = process.platform): string | null {
  if (!root) return null
  const wanted = (file: string): boolean => {
    const base = baseName(file)
    if (platform === "win32") return base === "chrome.exe" || base === "wayfern.exe" || /^apostate.*\.exe$/.test(base)
    if (platform === "darwin") {
      const parts = file.split(/[\\/]/)
      const i = parts.lastIndexOf("MacOS")
      return i > 0 && /^(chromium|apostate|wayfern)$/i.test(parts[i + 1] || "") && !/helper/i.test(file)
    }
    return base === "chrome" || base === "chromium" || base === "apostate" || base === "wayfern"
  }
  let stat: any
  try { stat = statSync(root) } catch { return null }
  if (!stat.isDirectory()) return wanted(root) ? root : null
  const walk = (dir: string, depth: number): string | null => {
    let entries: any[] | null
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) if (e.isFile()) { const f = path.join(dir, e.name); if (wanted(f)) return f }
    if (depth <= 0) return null
    for (const e of entries) if (e.isDirectory()) { const r = walk(path.join(dir, e.name), depth - 1); if (r) return r }
    return null
  }
  return walk(root, 8)
}

export function readInstall(dir: string): any | null {
  if (!dir) return null
  try {
    const got = JSON.parse(readFileSync(path.join(dir, "browsers", "apostate", "install.json"), "utf8"))
    return got && typeof got === "object" ? got : null
  } catch {
    return null
  }
}

export function writeInstall(dir: string, info: any) {
  writePrivate(path.join(dir, "browsers", "apostate", "install.json"), JSON.stringify(info, null, 2) + "\n")
}

// Everywhere a fingerprint browser could already be: the exact path someone configured, our own
// earlier download, and the cache folders the Apostate npm/pip packages and manual installs leave.
export function fingerprintCandidates(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, dir = ""): string[] {
  const out: string[] = []
  const own = String(env.MUSE_WEB_FINGERPRINT_BROWSER || "").trim()
  if (own) out.push(own)
  if (dir) {
    const marker = readInstall(dir)
    if (marker?.executable) out.push(marker.executable)
    const found = findExecutable(path.join(dir, "browsers", "apostate"), platform)
    if (found) out.push(found)
  }
  const home = env.HOME || env.USERPROFILE || os.homedir()
  const roots: string[] = []
  if (platform === "win32") {
    if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "apostate"), path.join(env.LOCALAPPDATA, "Apostate"))
    if (env.APPDATA) roots.push(path.join(env.APPDATA, "apostate"))
  } else if (platform === "darwin") {
    roots.push(path.join(home, "Library", "Caches", "apostate"), path.join(home, ".apostate"), path.join(home, "Library", "Application Support", "apostate"))
  } else {
    roots.push(path.join(home, ".cache", "apostate"), path.join(home, ".apostate"), path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "apostate"))
  }
  for (const root of roots) {
    const found = findExecutable(root, platform)
    if (found) out.push(found)
  }
  return [...new Set(out)]
}

export function findFingerprintBrowser(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = fsExists, dir = ""): string | null {
  return fingerprintCandidates(env, platform, dir).find((p) => p && exists(p)) ?? null
}

export function installedFingerprintExecutable({ env = process.env, platform = process.platform, exists = fsExists, dir = "" }: { env?: NodeJS.ProcessEnv; platform?: string; exists?: (p: string) => boolean; dir?: string } = {}): string | null {
  return findFingerprintBrowser(env, platform, exists, dir)
}

// --- archive extraction ----------------------------------------------------------------

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
const Z64_EOCD_SIG = 0x06064b50
const Z64_LOC_SIG = 0x07064b50

// Refuse names that would escape the destination: absolute paths and any ".." segment.
function safeJoin(root: string, name: unknown): string | null {
  const norm = path.normalize(String(name).replace(/^([/\\])+/, ""))
  if (!norm || norm.split(/[\\/]/).includes("..")) return null
  const full = path.join(root, norm)
  const rel = path.relative(root, full)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return rel === "" ? full : null
  return full
}

// A ZIP reader good enough for a Chromium build: stored and deflated entries, ZIP64 sizes.
// Returns the number of files written. Used for the Windows/macOS .zip and as the fallback when
// no system tar can read a zip.
export function extractZip(buffer: Buffer | Uint8Array, destDir: string, log: (msg: string) => void = () => {}): number {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  let eocd = -1
  const stop = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("zip: 找不到中央目录 (EOCD)")
  let count = buf.readUInt16LE(eocd + 10)
  let cenOff = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cenOff === 0xffffffff) {
    const loc = eocd - 20
    if (loc >= 0 && buf.readUInt32LE(loc) === Z64_LOC_SIG) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8))
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === Z64_EOCD_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32))
        cenOff = Number(buf.readBigUInt64LE(z64 + 48))
      }
    }
  }
  let p = cenOff
  let made = 0
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen)
    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) {
      let e = p + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e)
        const sz = buf.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          if (uncompSize === 0xffffffff) { uncompSize = Number(buf.readBigUInt64LE(q)); q += 8 }
          if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8 }
          if (localOff === 0xffffffff) { localOff = Number(buf.readBigUInt64LE(q)); q += 8 }
          break
        }
        e += 4 + sz
      }
    }
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith("/")) continue
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOC_SIG) { log(`zip: 跳过 ${name}（本地头损坏）`); continue }
    const lnLen = buf.readUInt16LE(localOff + 26)
    const leLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lnLen + leLen
    const comp = buf.subarray(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = comp
    else if (method === 8) data = inflateRawSync(comp)
    else { log(`zip: 跳过 ${name}（不支持的压缩方式 ${method}）`); continue }
    const target = safeJoin(destDir, name)
    if (!target) { log(`zip: 跳过可疑路径 ${name}`); continue }
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, data)
    made++
  }
  return made
}

function runTar(args) {
  try {
    return spawnSync("tar", args, { encoding: "utf8", windowsHide: true }).status === 0
  } catch {
    return false
  }
}

// Extract whichever archive the release shipped: .zip, .tar.zst, .tar.gz. The system bsdtar
// reads zip and (with libzstd) tar.zst; Node's zstd fills in on Linux where GNU tar would need
// an external zstd, and the built-in ZIP reader is the last resort.
export function extractArchive(file: string, destDir: string, log: (msg: string) => void = () => {}): boolean {
  const lower = String(file).toLowerCase()
  mkdirSync(destDir, { recursive: true })
  if (lower.endsWith(".zip")) {
    if (runTar(["-xf", file, "-C", destDir])) return true
    log("zip: tar 解压失败，改用内置解压")
    try { extractZip(readFileSync(file), destDir, log); return true } catch (err: any) { log(`zip: 内置解压失败（${err.message}）`); return false }
  }
  if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) {
    const out = file.replace(/\.(tar\.zst|tzst)$/i, ".tar")
    try {
      writeFileSync(out, zstdDecompressSync(readFileSync(file)))
      return runTar(["-xf", out, "-C", destDir])
    } catch (err: any) {
      log(`tar.zst: 解压失败（${err.message}）`)
      return false
    } finally {
      try { rmSync(out, { force: true }) } catch {}
    }
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return runTar(["-xzf", file, "-C", destDir])
  if (lower.endsWith(".tar")) return runTar(["-xf", file, "-C", destDir])
  log(`不认识的压缩格式：${path.basename(file)}`)
  return false
}

// --- download and install --------------------------------------------------------------

const RELEASE_API = `https://api.github.com/repos/${APOSTATE_REPO}/releases`

function assetKey(platform: string, arch: string): string {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : String(arch || "")
  return `${platform}-${cpu}`
}

async function readManifestSha(fetchImpl: typeof fetch, url: string): Promise<string> {
  try {
    const res = await fetchImpl(`${url}.manifest.json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return ""
    const body = await res.json() as any
    const sha = String(body?.sha256 || "").toLowerCase()
    return /^[0-9a-f]{64}$/.test(sha) ? sha : ""
  } catch {
    return ""
  }
}

// The asset to download: from the GitHub API when reachable, else the pinned name/URL. The
// expected sha256 comes from the pinned table when the name matches, otherwise from the release's
// own ".manifest.json" beside the archive.
async function resolveAsset({ fetchImpl, version, platform, arch, log }: {
  fetchImpl: typeof fetch
  version: string
  platform: string
  arch: string
  log: (msg: string) => void
}): Promise<any | null> {
  const pinMatches = String(version).replace(/^v/, "") === APOSTATE_PIN.version
  const pinned = pinMatches ? APOSTATE_PIN.assets[assetKey(platform, arch)] || null : null
  let assets: any[] = []
  try {
    const res = await fetchImpl(`${RELEASE_API}/tags/v${String(version).replace(/^v/, "")}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "magpie-muse-web" },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) {
      const body = await res.json() as any
      assets = Array.isArray(body?.assets) ? body.assets : []
    }
  } catch (err: any) {
    log(`指纹浏览器：GitHub API 不可用（${err?.message || err}），改用固定版本的下载地址`)
  }
  const chosen = pickReleaseAsset(assets, platform, arch)
  if (chosen) {
    const url = String(chosen.browser_download_url || chosen.url || "")
    const name = String(chosen.name || path.basename(url))
    let sha = pinned && pinned.name === name ? pinned.sha256 : ""
    if (!sha) sha = await readManifestSha(fetchImpl, url)
    return { name, url, sha256: sha, size: Number(chosen.size) || 0 }
  }
  if (pinned) {
    const tag = `v${String(version).replace(/^v/, "")}`
    const url = `https://github.com/${APOSTATE_REPO}/releases/download/${tag}/${pinned.name}`
    return { name: pinned.name, url, sha256: pinned.sha256, size: 0 }
  }
  return null
}

async function downloadTo(fetchImpl: typeof fetch, url: string, file: string): Promise<number> {
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, buf)
  return buf.length
}

// One installer at a time across engines sharing the data dir. A lock older than 10 minutes is a
// crashed run; a second engine waits for the first to finish instead of downloading twice.
function acquireInstallLock(root: string, now: () => number, log: (msg: string) => void) {
  const file = path.join(root, "install.lock")
  for (let i = 0; i < 2; i++) {
    try {
      return openSync(file, "wx", 0o600)
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err
      let age = 0
      try { age = now() - statSync(file).mtimeMs } catch { age = 0 }
      if (age > 10 * 60_000 && i === 0) {
        log("指纹浏览器：清理上次遗留的安装锁")
        try { rmSync(file, { force: true }) } catch {}
        continue
      }
      return null
    }
  }
  return null
}

async function waitForInstall(root: string, exists: (p: string) => boolean, platform: string, ms: number): Promise<string | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = findExecutable(path.join(root, "current"), platform)
    if (found && exists(found)) return found
    await new Promise<void>((r) => setTimeout(r, 1500))
  }
  return null
}

// The engine's browser resolver: a configured path, then Donut Browser's Wayfern kernel, then a
// local Apostate, otherwise download and install the pinned release under <dir>/browsers/apostate.
// Returns {executable, extraArgs, source, version} or null (caller falls back to a system Chrome).
export interface EnsureOptions {
  dir?: string
  env?: NodeJS.ProcessEnv
  platform?: string
  arch?: string
  log?: (msg: string) => void
  fetchImpl?: typeof fetch
  allowDownload?: boolean
  exists?: (p: string) => boolean
  now?: () => number
}

export async function ensureFingerprintBrowser({
  dir,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  log = () => {},
  fetchImpl = fetch,
  allowDownload = true,
  exists = fsExists,
  now = Date.now,
}: EnsureOptions = {}): Promise<PickedBrowser | null> {
  if (!dir) return null
  if (DISABLED.has(String(env.MUSE_WEB_FINGERPRINT || "").trim().toLowerCase())) {
    log("指纹浏览器：MUSE_WEB_FINGERPRINT 已关闭，改用系统中的 Chromium")
    return null
  }
  const decorate = (executable: string, source: string, version = ""): PickedBrowser => ({
    executable,
    extraArgs: isFingerprintBrowser(executable) ? fingerprintArgs({ seed: stableFingerprintSeed(dir), platform, env }) : [],
    source,
    version,
  })

  // 1. An exact path someone configured wins, if it is really there.
  const own = String(env.MUSE_WEB_FINGERPRINT_BROWSER || "").trim()
  if (own) {
    if (exists(own)) return decorate(own, "configured")
    log(`指纹浏览器：MUSE_WEB_FINGERPRINT_BROWSER 指向的文件不存在：${own}`)
  }

  // 2. Donut Browser's own Wayfern kernel, when that is the browser someone actually uses. At the
  // command line it is an ordinary Chromium, so it gets no fingerprint flags.
  if (!DISABLED.has(String(env[DONUT_ENV] || "").trim().toLowerCase())) {
    const wayfern = findWayfernBrowser(env, platform, exists)
    if (wayfern) {
      log(`指纹浏览器：使用 Donut Browser 的 Wayfern 内核 ${wayfern}`)
      return { executable: wayfern, extraArgs: [], source: "donut", version: "" }
    }
  }

  // 3. A copy already on this machine.
  const local = installedFingerprintExecutable({ env, platform, exists, dir })
  if (local) {
    log(`指纹浏览器：复用本机已有的 ${local}`)
    return decorate(local, "installed", readInstall(dir)?.version || "")
  }

  if (!allowDownload) return null

  // 4. Download and install once.
  const version = String(env.MUSE_WEB_FINGERPRINT_VERSION || APOSTATE_PIN.version).replace(/^v/, "") || APOSTATE_PIN.version
  const installRoot = path.join(dir, "browsers", "apostate")
  const key = assetKey(platform, arch)
  let asset
  try {
    asset = await resolveAsset({ fetchImpl, version, platform, arch, log })
  } catch (err: any) {
    log(`指纹浏览器：解析下载地址失败（${err?.message || err}）`)
    asset = null
  }
  if (!asset) {
    log(`指纹浏览器：没有适用于 ${key} 的发布包，改用系统中的 Chromium`)
    return null
  }
  mkdirSync(installRoot, { recursive: true })
  const lock = acquireInstallLock(installRoot, now, log)
  if (!lock) {
    log("指纹浏览器：另一个引擎正在安装，等它完成")
    const waited = await waitForInstall(installRoot, exists, platform, 3 * 60_000)
    return waited ? decorate(waited, "installed", readInstall(dir)?.version || "") : null
  }
  let downloadFile = ""
  let staging = ""
  try {
    const raced = findExecutable(path.join(installRoot, "current"), platform)
    if (raced && exists(raced)) return decorate(raced, "installed", readInstall(dir)?.version || "")
    log(`指纹浏览器：正在下载 Apostate ${version}（${asset.name}${asset.size ? `，约 ${Math.round(asset.size / 1e6)} MB` : ""}）…`)
    downloadFile = path.join(installRoot, "download", asset.name)
    const size = await downloadTo(fetchImpl, asset.url, downloadFile)
    const data = readFileSync(downloadFile)
    const sha = asset.sha256 || (await readManifestSha(fetchImpl, asset.url))
    if (sha) {
      if (!verifySha256(data, sha)) throw new Error(`sha256 校验不匹配（${asset.name}）`)
      log("指纹浏览器：sha256 校验通过")
    } else {
      log(`指纹浏览器：没有可用的 sha256，跳过校验（${asset.name}，${size} 字节）`)
    }
    staging = path.join(installRoot, `staging-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    if (!extractArchive(downloadFile, staging, log)) throw new Error("解压失败")
    const found = findExecutable(staging, platform)
    if (!found) throw new Error("解压后没有找到浏览器可执行文件")
    const current = path.join(installRoot, "current")
    // Swap the new tree in without deleting the old one first: if anything fails, the working
    // install is still there for the next start instead of leaving the plugin with nothing.
    const previous = path.join(installRoot, `previous-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
    rmSync(previous, { recursive: true, force: true })
    const hadCurrent = fsExists(current)
    if (hadCurrent) renameSync(current, previous)
    try {
      renameSync(staging, current)
    } catch (err) {
      if (hadCurrent) {
        try { renameSync(previous, current) } catch {}
      }
      throw err
    }
    try { rmSync(previous, { recursive: true, force: true }) } catch {}
    const finalExe = path.join(current, path.relative(staging, found))
    try { chmodSync(finalExe, 0o755) } catch {}
    writeInstall(dir, { version, asset: asset.name, executable: finalExe, sha256: sha || "", at: new Date(now()).toISOString() })
    try { rmSync(downloadFile, { force: true }) } catch {}
    log(`指纹浏览器：已安装到 ${finalExe}`)
    return decorate(finalExe, "downloaded", version)
  } catch (err: any) {
    if (staging) try { rmSync(staging, { recursive: true, force: true }) } catch {}
    if (downloadFile) try { rmSync(downloadFile, { force: true }) } catch {}
    log(`指纹浏览器：下载或安装失败，改用系统中的 Chromium（${err?.message || err}）`)
    return null
  } finally {
    try { closeSync(lock) } catch {}
    try { rmSync(path.join(installRoot, "install.lock"), { force: true }) } catch {}
  }
}
