// The pieces the engine decides from data alone: the account file, the data directory and port it
// starts on, the key that guards the port, and the small helpers the HTTP layer builds on.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { healthProof, validNonce } from "../engine/health.ts"
import { loginPage } from "../engine/login-page.ts"
import { sameEntryPath } from "../engine/main.ts"
import { dataDir, DEFAULT_PORT, engineKey, enginePort, writePrivate } from "../engine/paths.ts"
import { redact } from "../engine/redact.ts"
import { generationCode } from "../engine/server.ts"
import { Store } from "../engine/store.ts"

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix))
const POSIX = process.platform !== "win32"

describe("the account store", () => {
  test("keeps a sign-in, renews the same account, and reloads from disk", () => {
    const file = path.join(tmp("mw-store-"), "accounts.json")
    const store = new Store(file)

    const first = store.add({ hatch_sess: "a" }, { hatch_vml: 1_900_000_000 }, "", "vm-1")
    assert.match(first.label, /^muse\.ai /)
    assert.match(first.label, / 登录$/)
    assert.equal(first.expires, 1_900_000_000_000)

    // The same muse.ai VM signing in again renews its handle instead of adding a second one.
    const again = store.add({ hatch_sess: "b" }, {}, "new label", "vm-1")
    assert.equal(again.again, true)
    assert.equal(again.handle, first.handle)
    assert.equal(again.label, first.label)

    const second = store.add({ hatch_sess: "c" }, {}, "a@b.c", "vm-2")
    assert.notEqual(second.handle, first.handle)
    assert.equal(second.label, "a@b.c")
    assert.equal(store.count(), 2)

    const loaded = new Store(file)
    const account = loaded.get(first.handle)
    assert.ok(account)
    assert.equal(account.cookies.hatch_sess, "b")

    // What a caller is handed is a copy: editing it must not edit the file's contents.
    account.cookies.hatch_sess = "external mutation"
    assert.equal(loaded.get(first.handle)?.cookies.hatch_sess, "b")

    loaded.update(first.handle, { hatch_sess: "renewed" }, null, "")
    assert.equal(new Store(file).get(first.handle)?.cookies.hatch_sess, "renewed")

    loaded.remove(second.handle)
    assert.equal(loaded.count(), 1)
    assert.equal(new Store(file).count(), 1)

    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600)
  })

  test("an account with no cookies is not an account", () => {
    const file = path.join(tmp("mw-store-"), "accounts.json")
    writeFileSync(file, JSON.stringify({ empty: { cookies: {}, label: "empty" } }))
    const store = new Store(file)
    assert.equal(store.get("empty"), null)
    assert.equal(store.count(), 1)
  })

  test("a save that cannot be written leaves the store's memory untouched", () => {
    const dir = tmp("mw-store-")
    const store = new Store(path.join(dir, "accounts.json"))
    const first = store.add({ hatch_sess: "a" }, {}, "first", "vm")

    // A regular file where a directory would have to be: every write below fails on both
    // platforms, and no half-written accounts.json is left behind.
    const blocked = path.join(dir, "blocked")
    writeFileSync(blocked, "")
    store.file = path.join(blocked, "accounts.json")

    assert.throws(() => store.update(first.handle, { hatch_sess: "b" }, null, ""))
    assert.equal(store.get(first.handle)?.cookies.hatch_sess, "a", "a failed save changed memory")
    assert.throws(() => store.remove(first.handle))
    assert.equal(store.count(), 1, "a failed remove changed memory")
  })

  test("a corrupt accounts.json is refused rather than read as empty", () => {
    const file = path.join(tmp("mw-store-"), "accounts.json")
    writeFileSync(file, "{broken")
    assert.throws(() => new Store(file), /accounts\.json/)
  })

  test("twelve sign-ins are twelve accounts, and all of them survive a reload", () => {
    const file = path.join(tmp("mw-store-"), "accounts.json")
    const store = new Store(file)
    for (let i = 0; i < 12; i++) store.add({ hatch_sess: "a" }, {}, "", "")
    assert.equal(store.count(), 12)
    assert.equal(new Store(file).count(), 12)
  })

  test("a save that cannot land reports why and leaves no temporary file behind", () => {
    const dir = tmp("mw-store-")
    const file = path.join(dir, "accounts.json")
    // A directory in the file's place makes the replace fail the way a locked file does, and the
    // half-written temporary file must not survive the failure.
    mkdirSync(file)
    assert.throws(() => writePrivate(file, "{}\n"))
    assert.deepEqual(readdirSync(dir), ["accounts.json"])
  })
})

describe("the data directory and port", () => {
  test("dataDir follows each platform's own place", () => {
    const table: Array<{ platform: NodeJS.Platform; home: string; env: Record<string, string>; want: string }> = [
      { platform: "darwin", home: "/Users/a", env: {}, want: "/Users/a/Library/Application Support/muse-web" },
      { platform: "win32", home: "C:/Users/a", env: { APPDATA: "C:/roaming" }, want: "C:\\roaming\\muse-web" },
      { platform: "linux", home: "/home/a", env: {}, want: "/home/a/.local/share/muse-web" },
      { platform: "linux", home: "/home/a", env: { XDG_DATA_HOME: "/x" }, want: "/x/muse-web" },
      { platform: "linux", home: "/home/a", env: { MUSE_WEB_HOME: "/own" }, want: "/own" },
    ]
    for (const spec of table) {
      assert.equal(dataDir(spec.env, spec.platform, spec.home), spec.want, spec.platform)
    }
  })

  test("enginePort takes only a real port", () => {
    for (const value of ["", "0", "65536", "-1", "wat"]) {
      assert.equal(enginePort({ MUSE_WEB_ENGINE_PORT: value }), DEFAULT_PORT, JSON.stringify(value))
    }
    assert.equal(enginePort({ MUSE_WEB_ENGINE_PORT: " 12345 " }), 12345)
    assert.equal(enginePort({}), DEFAULT_PORT)
  })

  test("engineKey installs one 48-character key and keeps it", () => {
    const dir = tmp("mw-key-")
    const key = engineKey(dir)
    assert.equal(key.length, 48)
    assert.match(key, /^[0-9a-f]{48}$/)
    assert.equal(engineKey(dir), key, "a second engine installed a different key")
    assert.equal(readFileSync(path.join(dir, "engine.key"), "utf8").trim(), key)
    if (POSIX) assert.equal(statSync(path.join(dir, "engine.key")).mode & 0o777, 0o600)
  })

  test("engineKey replaces a key file that a crash left empty", () => {
    const dir = tmp("mw-key-")
    writeFileSync(path.join(dir, "engine.key"), "")
    const key = engineKey(dir)
    assert.equal(key.length, 48)
    assert.equal(engineKey(dir), key)
  })
})

describe("the small helpers", () => {
  test("generationCode names the failure a driver reported", () => {
    const table: Array<[string, string, number]> = [
      ["VM warming", "vm_warming", 10],
      ["页面没有加载", "page_unavailable", 10],
      ["TIMEOUT", "upstream_timeout", 5],
      ["没有发出去", "send_failed", 2],
      ["other", "engine_unavailable", 5],
    ]
    for (const [text, code, retry] of table) {
      assert.deepEqual(generationCode(text), [code, retry], text)
    }
  })

  test("redact removes every credential shape a log line can carry", () => {
    assert.equal(redact("Bearer test-token hatch_sess=private"), "Bearer *** hatch_sess=***")
    assert.equal(redact("GET /x?key=abc&token=d"), "GET /x?key=***&token=***")
    assert.equal(redact(null), "")
  })

  test("the login page escapes what the driver reported", () => {
    const state = JSON.stringify({ status: "failed", error: "<script>alert(1)</script>" })
    assert.ok(!loginPage(state).includes("<script>"), "unescaped login error")
    assert.ok(!loginPage({ status: "failed", error: "<script>x</script>" }).includes("<script>"))
    assert.ok(loginPage(null).includes("找不到这次登录"))
  })

  test("the engine recognises itself as the entry point however its path was typed", () => {
    // A Windows path is the same file in any case, so `node engine\MAIN.TS` has to start the
    // engine rather than do nothing and exit 0. Anywhere else the name is the file.
    assert.equal(sameEntryPath("E:\\repo\\engine\\MAIN.TS", "e:\\repo\\engine\\main.ts", "win32"), true)
    assert.equal(sameEntryPath("/repo/engine/MAIN.TS", "/repo/engine/main.ts", "linux"), false)
    assert.equal(sameEntryPath("/repo/engine/main.ts", "/repo/engine/main.ts", "linux"), true)
  })
})

describe("the health proof", () => {
  test("stays byte-for-byte the answer the plugin computes", () => {
    const table: Array<[string, string, string]> = [
      ["k", "abcdefgh", "bb528925cff297092538a0694382252e434faf0718293d42e083ee6fc506187a"],
      ["key123", "nonce-0123456789", "5f3cc3ead7acb81a22571114263c6d9f8cad7a5323d5bfd9b632db306bd6df50"],
    ]
    for (const [key, nonce, want] of table) {
      assert.equal(healthProof(key, nonce), want, `${key}/${nonce}`)
    }
    // A proof that ignored either input would prove nothing.
    assert.notEqual(healthProof("k", "abcdefgh"), healthProof("k2", "abcdefgh"))
    assert.notEqual(healthProof("k", "abcdefgh"), healthProof("k", "abcdefgi"))
  })

  test("validNonce bounds what an unauthenticated caller may feed the HMAC", () => {
    for (const nonce of ["abcdefgh", "ABCDEFGH0123456789-_", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]) {
      assert.equal(validNonce(nonce), true, nonce)
    }
    for (const nonce of ["", "abcdefg", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0", "abcdefg ", "abc/defg", "abc.defg", 42, null]) {
      assert.equal(validNonce(nonce), false, String(nonce))
    }
  })
})
