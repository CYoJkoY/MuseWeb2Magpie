// @ts-nocheck
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  APOSTATE_PIN,
  donutDataRoots,
  ensureFingerprintBrowser,
  extractZip,
  findFingerprintBrowser,
  findWayfernBrowser,
  fingerprintArgs,
  pickReleaseAsset,
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

function response(body, init = {}) {
  return { ok: init.status === undefined || init.status < 400, status: init.status ?? 200, json: async () => body, arrayBuffer: async () => body }
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
