// MUSE_WEB_SITE points the engine at a muse.ai mirror or a local test server. Whatever it names
// receives the account's session cookies — the browser carries them on every page, and every API
// call in muse.ts sends them to the same origin. A session cookie is a credential, so the address
// follows the rule engine.key already follows (ADR 0006): clear http only to this machine,
// https anywhere else. It is also the one place where a typo used to fail much later, inside a
// browser that would not load a page, instead of at the moment the name was set.
import { isLoopbackUrl } from "./local-fetch.ts"

// siteProblem says why MUSE_WEB_SITE cannot be used, or null when it can (including unset, which
// means the default https://muse.ai).
export function siteProblem(raw: unknown): string | null {
  const typed = String(raw ?? "").trim()
  if (!typed) return null
  let url: URL
  try {
    url = new URL(typed)
  } catch {
    return `MUSE_WEB_SITE 不是完整的网址，要写成 https://muse.ai 这样（带 http:// 或 https://）：${typed}`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `MUSE_WEB_SITE 只支持 http 或 https：${typed}`
  }
  // Credentials in the URL would be replayed on every request and land in any proxy's log.
  if (url.username || url.password) {
    return `MUSE_WEB_SITE 不要带用户名或密码：${typed}`
  }
  if (url.protocol === "http:" && !isLoopbackUrl(url)) {
    return `MUSE_WEB_SITE 用 http 时只能是本机地址（127.0.0.1、localhost 或 [::1]），否则账号 cookie 会在网络上明文传输：${typed}`
  }
  return null
}

// siteOrDefault is the site the engine talks to: the configured one, or muse.ai itself. Only call
// it once siteProblem() has accepted the value; the default keeps the driver constructible so it
// can still answer with the reason instead of dying at startup.
export function siteOrDefault(raw: unknown): string {
  return (String(raw ?? "").trim() || "https://muse.ai").replace(/\/+$/, "")
}
