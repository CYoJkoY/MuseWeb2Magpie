import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"

export const DEFAULT_PORT = 18611

export function dataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = os.homedir()): string {
  if (env.MUSE_WEB_HOME) return env.MUSE_WEB_HOME
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", "muse-web")
  if (platform === "win32") return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "muse-web")
  return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, ".local", "share"), "muse-web")
}

export function enginePort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MUSE_WEB_ENGINE_PORT)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

// Windows refuses the replace while something else holds the destination for a moment -- a virus
// scanner opening the file a sign-in just wrote, the search indexer, a backup agent. The same
// rename lands a few milliseconds later, so a transient refusal is retried instead of turning a
// successful sign-in into an error. Every other failure, and a refusal that outlasts the retries,
// is the caller's to see.
function replaceFile(tmp: string, file: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      return
    } catch (err: any) {
      const code = err?.code
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY"
      if (!transient || attempt >= 5) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1))
    }
  }
}

// Owner-only where the platform has modes; Windows keeps the user profile's own ACL.
export function writePrivate(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch {}
  try {
    replaceFile(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
}

export function engineKey(dir: string): string {
  const file = path.join(dir, "engine.key")
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 20; i++) {
    if (existsSync(file)) {
      const key = readFileSync(file, "utf8").trim()
      if (key) return key
      // Another engine created the file and has not written its key yet; give it a moment.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      continue
    }
    try {
      const key = randomBytes(24).toString("hex")
      // "wx" makes creation exclusive: two engines starting together cannot each install a key.
      const fd = openSync(file, "wx", 0o600)
      writeSync(fd, key + "\n")
      closeSync(fd)
      try { chmodSync(file, 0o600) } catch {}
      return key
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err
    }
  }
  // The file is there but empty (a crash between create and write): replace it atomically.
  const key = randomBytes(24).toString("hex")
  writePrivate(file, key + "\n")
  return key
}

// Hex, not base64url: the shapes that carry it (handles, login ids, chat ids) are read by people
// in logs and URLs, and hex never needs escaping.
export function randomHex(n: number): string {
  return randomBytes(n).toString("hex")
}
