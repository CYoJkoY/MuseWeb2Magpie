// @ts-nocheck
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { deflateRawSync, zstdCompressSync } from "node:zlib"
import {
  APOSTATE_PIN,
  boundedJson,
  downloadTo,
  donutDataRoots,
  ensureFingerprintBrowser,
  extractArchive,
  extractZip,
  findFingerprintBrowser,
  findWayfernBrowser,
  fingerprintArgs,
  pickReleaseAsset,
  releaseFileName,
  verifySha256,
} from "../engine/fingerprint.ts"

const assets = [
  { name: "apostate-0.5.1-windows-x64.zip", browser_download_url: "https://example/win.zip", size: 10 },
  { name: "apostate-0.5.1-linux-x64.tar.zst", browser_download_url: "https://example/linux.tar.zst", size: 10 },
  { name: "apostate-0.5.1-macos-arm64.zip", browser_download_url: "https://example/mac.zip", size: 10 },
  { name: "checksums.txt", browser_download_url: "https://example/checksums.txt", size: 1 },
]

function storedZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, data] of files) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, Buffer.from(name), content)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt32LE(content.length, 20)
    entry.writeUInt32LE(content.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, Buffer.from(name))
    offset += 30 + name.length + content.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

// The same container, but with every entry deflated: what a real release ships, and what a
// decompression bomb needs in order to be small on the wire and enormous when unpacked.
function deflatedZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, data] of files) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data)
    const packed = deflateRawSync(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, Buffer.from(name), packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(content.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, Buffer.from(name))
    offset += 30 + name.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}

function response(body, init = {}) {
  // A real Response always has a body stream; a double without one is read through arrayBuffer,
  // so JSON bodies are handed over as their bytes.
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    headers: init.headers || {},
    body: init.body,
    json: async () => body,
    arrayBuffer: async () => bytes,
  }
}

test("release assets are chosen for the host OS and CPU", () => {
  assert.equal(pickReleaseAsset(assets, "win32", "x64")?.name, assets[0].name)
  assert.equal(pickReleaseAsset(assets, "linux", "x64")?.name, assets[1].name)
  assert.equal(pickReleaseAsset(assets, "darwin", "arm64")?.name, assets[2].name)
  assert.equal(pickReleaseAsset(assets, "linux", "arm64"), null)
  assert.equal(pickReleaseAsset([], "win32", "x64"), null)
})

test("downloads are accepted only with their pinned sha256", () => {
  const data = Buffer.from("archive")
  const sha = APOSTATE_PIN.assets["win32-x64"].sha256
  assert.equal(verifySha256(data, sha), false)
  assert.equal(verifySha256(data, "not-a-hash"), false)
  assert.equal(verifySha256(data, ""), false)
})

test("a release file name is only ever a plain name inside the download folder", () => {
  // What the pin and the real releases announce passes through unchanged.
  assert.equal(releaseFileName(APOSTATE_PIN.assets["win32-x64"].name), APOSTATE_PIN.assets["win32-x64"].name)
  assert.equal(releaseFileName("apostate-0.5.1-linux-x64.tar.zst"), "apostate-0.5.1-linux-x64.tar.zst")
  // Remote text cannot climb out of the download folder or reach a drive.
  assert.equal(releaseFileName("../../engine.key"), "engine.key")
  assert.equal(releaseFileName("..\\..\\accounts.json"), "accounts.json")
  assert.equal(releaseFileName("/etc/passwd"), "passwd")
  assert.equal(releaseFileName("C:\\Windows\\System32\\evil.zip"), "evil.zip")
  assert.equal(releaseFileName("sub/dir/payload.zip"), "payload.zip")
  // Nothing usable in the name: the URL's own file name is tried next, then a neutral one.
  assert.equal(releaseFileName("..", "https://example/apostate-linux-x64.tar.zst?token=1"), "apostate-linux-x64.tar.zst")
  assert.equal(releaseFileName("", "https://example/download"), "download")
  assert.equal(releaseFileName(""), "download")
  assert.equal(releaseFileName(null, "not a url"), "download")
})

test("a local fingerprint browser is reused without touching the network", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-local-"))
  mkdirSync(path.join(dir, "apostate"), { recursive: true })
  const exe = path.join(dir, "apostate", "chrome.exe")
  writeFileSync(exe, "browser")
  const env = { MUSE_WEB_FINGERPRINT_BROWSER: exe, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: dir }
  let fetched = 0
  const picked = await ensureFingerprintBrowser({ dir, env, platform: "win32", arch: "x64", fetchImpl: async () => fetched++, exists: (p) => p === exe })
  assert.equal(fetched, 0)
  assert.equal(picked.executable, exe)
  assert.equal(picked.source, "configured")
  assert.deepEqual(picked.extraArgs, fingerprintArgs({ seed: picked.extraArgs[0].split("=")[1], platform: "win32" }))
  const found = findFingerprintBrowser(env, "win32", (p) => p === exe)
  assert.equal(found, exe)
  rmSync(dir, { recursive: true, force: true })
})

// A Donut Browser install keeps its kernels under <data>/binaries/wayfern/<version>/.
function wayfernTree(root, version) {
  const dir = path.join(root, "binaries", "wayfern", version)
  mkdirSync(dir, { recursive: true })
  const exe = path.join(dir, "chrome.exe")
  writeFileSync(exe, "kernel")
  return exe
}

test("Donut Browser's Wayfern kernel is reused before Apostate is downloaded", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mw-fp-donut-"))
  const scoop = path.join(home, "scoop")
  const exe = wayfernTree(path.join(scoop, "apps", "donutbrowser", "current", "data"), "156.0.8078.86")
  const dir = path.join(home, "data")
  mkdirSync(dir, { recursive: true })
  const env = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "empty"),
    APPDATA: path.join(home, "empty"),
    SCOOP: scoop,
  }
  let fetched = 0
  const picked = await ensureFingerprintBrowser({
    dir,
    env,
    platform: "win32",
    arch: "x64",
    fetchImpl: async () => { fetched++; throw new Error("no network") },
    log: () => {},
  })
  assert.equal(fetched, 0)
  assert.equal(picked.executable, exe)
  assert.equal(picked.source, "donut")
  // Wayfern is an ordinary Chromium at the command line: the --fingerprint flags stay off.
  assert.deepEqual(picked.extraArgs, [])
  rmSync(home, { recursive: true, force: true })
})

test("the newest Wayfern kernel wins when Donut keeps several versions", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mw-fp-wayfern-"))
  const data = path.join(home, "DonutBrowser")
  wayfernTree(data, "155.0.8059.31")
  const newest = wayfernTree(data, "156.0.8078.86")
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: home }
  assert.equal(findWayfernBrowser(env, "win32"), newest)
  assert.equal(donutDataRoots(env, "win32")[0], data)
  rmSync(home, { recursive: true, force: true })
})

test("MUSE_WEB_DONUT_BROWSER names a Donut folder or the kernel, and off disables Donut", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mw-fp-donut-env-"))
  const data = path.join(home, "donut-data")
  const exe = wayfernTree(data, "156.0.8078.86")
  const base = { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "empty") }
  assert.equal(findWayfernBrowser({ ...base, MUSE_WEB_DONUT_BROWSER: data }, "win32"), exe)
  assert.equal(findWayfernBrowser({ ...base, MUSE_WEB_DONUT_BROWSER: exe }, "win32"), exe)
  assert.equal(findWayfernBrowser({ ...base, MUSE_WEB_DONUT_BROWSER: "off" }, "win32"), null)
  rmSync(home, { recursive: true, force: true })
})

// Wayfern is Donut's own Chromium fork, so the kernel keeps a different name per OS. Linux ships a
// plain binary and macOS an app bundle; both have to be found by the name Wayfern actually uses.
test("the Wayfern kernel is found by its own name on macOS and Linux", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mw-fp-wayfern-posix-"))
  const linux = path.join(home, "linux")
  const linuxDir = path.join(linux, "binaries", "wayfern", "156.0.8078.86")
  mkdirSync(linuxDir, { recursive: true })
  const linuxExe = path.join(linuxDir, "wayfern")
  writeFileSync(linuxExe, "kernel")
  const mac = path.join(home, "mac")
  const macDir = path.join(mac, "binaries", "wayfern", "156.0.8078.86", "Wayfern.app", "Contents", "MacOS")
  mkdirSync(macDir, { recursive: true })
  const macExe = path.join(macDir, "Wayfern")
  writeFileSync(macExe, "kernel")
  assert.equal(findWayfernBrowser({ MUSE_WEB_DONUT_BROWSER: linux }, "linux"), linuxExe)
  assert.equal(findWayfernBrowser({ MUSE_WEB_DONUT_BROWSER: mac }, "darwin"), macExe)
  rmSync(home, { recursive: true, force: true })
})

test("a missing fingerprint browser is downloaded, verified and installed", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-dl-"))
  const archive = storedZip([["apostate/chrome.exe", "browser"], ["apostate/manifest.json", "{}"]])
  const sha = createHash("sha256").update(archive).digest("hex")
  const version = "0.5.1-test"
  const name = `apostate-${version}-windows-x64.zip`
  const downloadUrl = `https://example/${name}`
  const fetchImpl = async (url) => {
    if (url === "https://api.github.com/repos/heretic-tech/apostate/releases/tags/v0.5.1-test") return response({ assets: [{ name, browser_download_url: downloadUrl, size: archive.length }] })
    if (url === `${downloadUrl}.manifest.json`) return response({ sha256: sha })
    if (url === downloadUrl) return response(archive)
    throw new Error(`unexpected fetch ${url}`)
  }
  const env = {
    HOME: dir,
    USERPROFILE: dir,
    LOCALAPPDATA: path.join(dir, "empty"),
    APPDATA: path.join(dir, "empty"),
    MUSE_WEB_FINGERPRINT_VERSION: version,
  }
  const picked = await ensureFingerprintBrowser({ dir, env, platform: "win32", arch: "x64", fetchImpl, exists: (p) => !p.startsWith(path.join(dir, "empty")), log: () => {} })
  assert.equal(picked.source, "downloaded")
  assert.equal(picked.version, version)
  assert.match(picked.executable.replace(/^.*[\\/]browsers/, "browsers"), /^browsers[\\/]apostate[\\/]current[\\/].*[\\/]chrome\.exe$/)
  assert.equal(readFileSync(picked.executable, "utf8"), "browser")
  assert.equal(readFileSync(path.join(dir, "browsers", "apostate", "install.json"), "utf8").includes(`"sha256": "${sha}"`), true)
  rmSync(dir, { recursive: true, force: true })
})

test("a release that announces a climbing file name still writes inside the install root", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-name-"))
  const archive = storedZip([["apostate/chrome.exe", "browser"]])
  const sha = createHash("sha256").update(archive).digest("hex")
  const version = "0.5.1-name"
  const downloadUrl = "https://example/apostate-windows-x64.zip"
  // The name still carries the tokens the release picker looks for, so this asset is the one
  // chosen; the climbing part is what must not survive into a file name.
  const announced = "../../apostate-windows-x64.zip"
  const fetchImpl = async (url) => {
    if (url === `https://api.github.com/repos/heretic-tech/apostate/releases/tags/v${version}`) return response({ assets: [{ name: announced, browser_download_url: downloadUrl, size: archive.length }] })
    if (url === `${downloadUrl}.manifest.json`) return response({ sha256: sha })
    if (url === downloadUrl) return response(archive)
    throw new Error(`unexpected fetch ${url}`)
  }
  const env = { HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, "empty"), APPDATA: path.join(dir, "empty"), MUSE_WEB_FINGERPRINT_VERSION: version }
  const picked = await ensureFingerprintBrowser({ dir, env, platform: "win32", arch: "x64", fetchImpl, exists: (p) => !p.startsWith(path.join(dir, "empty")), log: () => {} })
  assert.equal(picked.source, "downloaded")
  assert.equal(readFileSync(picked.executable, "utf8"), "browser")
  // Nothing was written above the install root: no "<dir>/apostate-windows-x64.zip", no leftover
  // download, and the data directory still holds nothing but the browser tree.
  assert.equal(existsSync(path.join(dir, "apostate-windows-x64.zip")), false)
  assert.equal(existsSync(path.join(dir, "..", "apostate-windows-x64.zip")), false)
  assert.deepEqual(readdirSync(dir).filter((n) => n !== "browsers" && n !== "fingerprint.json"), [])
  const leftover = path.join(dir, "browsers", "apostate", "download")
  assert.equal(existsSync(leftover) ? readdirSync(leftover).length : 0, 0)
  const install = JSON.parse(readFileSync(path.join(dir, "browsers", "apostate", "install.json"), "utf8"))
  assert.equal(install.asset, "apostate-windows-x64.zip")
  rmSync(dir, { recursive: true, force: true })
})

test("a corrupt download falls back instead of installing the wrong browser", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-bad-"))
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return response({ assets: [] })
    if (url.endsWith("windows-x64.zip")) return response(Buffer.from("not a zip"))
    throw new Error(`unexpected fetch ${url}`)
  }
  const env = { HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, "empty"), APPDATA: path.join(dir, "empty") }
  const picked = await ensureFingerprintBrowser({ dir, env, platform: "win32", arch: "x64", fetchImpl, exists: () => false, log: () => {} })
  assert.equal(picked, null)
  // The rejected archive is dropped so the next start does not keep a corrupt download around.
  const download = path.join(dir, "browsers", "apostate", "download")
  assert.equal(existsSync(download) ? readdirSync(download).length : 0, 0)
  rmSync(dir, { recursive: true, force: true })
})

test("an unusable old install is swapped out without leaving partial trees", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-swap-"))
  const installRoot = path.join(dir, "browsers", "apostate")
  // A broken earlier attempt: a "current" directory with no executable in it.
  mkdirSync(path.join(installRoot, "current", "apostate"), { recursive: true })
  writeFileSync(path.join(installRoot, "current", "apostate", "leftover.txt"), "junk")
  const archive = storedZip([["apostate/chrome.exe", "browser"]])
  const sha = createHash("sha256").update(archive).digest("hex")
  const version = "0.5.1-swap"
  const name = `apostate-${version}-windows-x64.zip`
  const downloadUrl = `https://example/${name}`
  const fetchImpl = async (url) => {
    if (url === `https://api.github.com/repos/heretic-tech/apostate/releases/tags/v${version}`) return response({ assets: [{ name, browser_download_url: downloadUrl, size: archive.length }] })
    if (url === `${downloadUrl}.manifest.json`) return response({ sha256: sha })
    if (url === downloadUrl) return response(archive)
    throw new Error(`unexpected fetch ${url}`)
  }
  const env = { HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, "empty"), APPDATA: path.join(dir, "empty"), MUSE_WEB_FINGERPRINT_VERSION: version }
  const picked = await ensureFingerprintBrowser({ dir, env, platform: "win32", arch: "x64", fetchImpl, exists: (p) => !p.startsWith(path.join(dir, "empty")), log: () => {} })
  assert.equal(picked.source, "downloaded")
  assert.equal(readFileSync(picked.executable, "utf8"), "browser")
  assert.equal(readdirSync(path.join(installRoot, "current", "apostate")).includes("leftover.txt"), false)
  assert.deepEqual(readdirSync(installRoot).filter((n) => n.startsWith("previous-") || n.startsWith("staging-")), [])
  rmSync(dir, { recursive: true, force: true })
})

test("the built-in zip reader writes stored entries inside the destination", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-zip-"))
  const made = extractZip(storedZip([["top/chrome.exe", "exe"], ["../escape", "bad"]]), dir)
  assert.equal(made, 1)
  assert.equal(readFileSync(path.join(dir, "top", "chrome.exe"), "utf8"), "exe")
  assert.equal(rmSync !== undefined, true)
  rmSync(dir, { recursive: true, force: true })
})

test("a download that announces more than the ceiling is refused before a byte is written", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-big-"))
  const file = path.join(dir, "download", "apostate.zip")
  const fetchImpl = async () =>
    response(Buffer.from("small body"), { headers: { "content-length": String(8 * 1024 * 1024 * 1024) } })
  await assert.rejects(() => downloadTo(fetchImpl, "https://example/apostate.zip", file), /上限/)
  // The refusal happens before the file is opened, so nothing is left on disk.
  assert.equal(existsSync(file), false)
  rmSync(dir, { recursive: true, force: true })
})

test("a download that never ends is stopped at the ceiling instead of filling the disk", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-stream-"))
  const file = path.join(dir, "download", "apostate.zip")
  const chunk = Buffer.alloc(1024, 7)
  let pulled = 0
  const body = new ReadableStream({
    pull(controller) {
      pulled++
      controller.enqueue(chunk)
    },
  })
  const fetchImpl = async () => response(Buffer.alloc(0), { body })
  await assert.rejects(() => downloadTo(fetchImpl, "https://example/apostate.zip", file, 8192), /上限/)
  // Writing stopped at the ceiling, and the endless body was cancelled rather than drained.
  assert.equal(existsSync(file) ? readFileSync(file).length <= 8192 : true, true)
  assert.equal(pulled < 10_000, true)
  rmSync(dir, { recursive: true, force: true })
})

test("a remote JSON body is parsed only under its own ceiling", async () => {
  const small = await boundedJson(response({ sha256: "a".repeat(64) }), "校验清单")
  assert.equal(small.sha256, "a".repeat(64))
  const huge = Buffer.alloc(2 * 1024 * 1024, 0x20)
  await assert.rejects(() => boundedJson(response(huge), "校验清单"), /上限/)
  // A body within the ceiling but not JSON is refused with its own reason.
  await assert.rejects(() => boundedJson(response(Buffer.from("not json")), "校验清单"), /不是合法的 JSON/)
})

test("a release that announces an enormous archive falls back instead of downloading it", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-huge-"))
  const version = "0.5.1-huge"
  const name = `apostate-${version}-windows-x64.zip`
  const downloadUrl = `https://example/${name}`
  const fetchImpl = async (url) => {
    if (url === `https://api.github.com/repos/heretic-tech/apostate/releases/tags/v${version}`)
      return response({ assets: [{ name, browser_download_url: downloadUrl, size: 8 * 1024 * 1024 * 1024 }] })
    if (url === `${downloadUrl}.manifest.json`) return response({ sha256: "b".repeat(64) })
    if (url === downloadUrl)
      return response(Buffer.from("x"), { headers: { "content-length": String(8 * 1024 * 1024 * 1024) } })
    throw new Error(`unexpected fetch ${url}`)
  }
  const env = { HOME: dir, USERPROFILE: dir, LOCALAPPDATA: path.join(dir, "empty"), APPDATA: path.join(dir, "empty"), MUSE_WEB_FINGERPRINT_VERSION: version }
  const picked = await ensureFingerprintBrowser({ dir, env, platform: "win32", arch: "x64", fetchImpl, exists: () => false, log: () => {} })
  assert.equal(picked, null)
  const download = path.join(dir, "browsers", "apostate", "download")
  assert.equal(existsSync(download) ? readdirSync(download).length : 0, 0)
  rmSync(dir, { recursive: true, force: true })
})

test("an archive that inflates past the ceiling is refused instead of filling memory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-bomb-"))
  // 16 MiB of zeros is a few kilobytes on the wire and far past the budget below, so the entry
  // has to be stopped by its expanded size rather than by what arrived.
  const bomb = deflatedZip([["apostate/chrome.exe", Buffer.alloc(16 * 1024 * 1024)]])
  assert.throws(() => extractZip(bomb, dir, () => {}, { maxBytes: 1024 * 1024 }), /上限/)
  assert.equal(existsSync(path.join(dir, "apostate", "chrome.exe")), false)
  // The same archive unpacks once the budget allows it: the ceiling is the only difference.
  assert.equal(extractZip(bomb, dir, () => {}, { maxBytes: 32 * 1024 * 1024 }), 1)
  assert.equal(readFileSync(path.join(dir, "apostate", "chrome.exe")).length, 16 * 1024 * 1024)
  rmSync(dir, { recursive: true, force: true })
})

test("a central directory that claims too many entries is refused", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-many-"))
  const zip = deflatedZip([["a.txt", "a"], ["b.txt", "b"], ["c.txt", "c"]])
  assert.throws(() => extractZip(zip, dir, () => {}, { maxEntries: 2 }), /上限/)
  assert.equal(extractZip(zip, dir, () => {}, { maxEntries: 3 }), 3)
  rmSync(dir, { recursive: true, force: true })
})

test("extractArchive drops a tree that expands past the ceiling", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-bomb-file-"))
  const file = path.join(dir, "apostate.zip")
  writeFileSync(file, deflatedZip([["apostate/chrome.exe", Buffer.alloc(8 * 1024 * 1024)]]))
  assert.equal(extractArchive(file, path.join(dir, "out"), () => {}, { maxBytes: 1024 * 1024 }), false)
  rmSync(dir, { recursive: true, force: true })
})

test("a tar.zst that inflates past the ceiling is refused before it is written out", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mw-fp-zst-"))
  const file = path.join(dir, "apostate.tar.zst")
  writeFileSync(file, zstdCompressSync(Buffer.alloc(8 * 1024 * 1024)))
  assert.equal(extractArchive(file, path.join(dir, "out"), () => {}, { maxBytes: 1024 * 1024 }), false)
  // The intermediate .tar is never written, so nothing large is left behind either.
  assert.equal(existsSync(path.join(dir, "apostate.tar")), false)
  rmSync(dir, { recursive: true, force: true })
})
