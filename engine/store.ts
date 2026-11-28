// Accounts kept by the engine: handle → {cookies, cookies_exp}. Cookies never leave this file
// except into that account's own browser context and muse.ai requests.
import { readFileSync } from "node:fs"
import { expiryMs } from "./accounts.ts"
import { randomHex, writePrivate } from "./paths.ts"
import type { Account, Cookies, ExpiryMap, SavedAccount, StoredAccount } from "./types.ts"

export class Store {
  // Public so a test can point a save at a path that cannot be written.
  file: string
  private all: Record<string, StoredAccount> = {}

  constructor(file: string) {
    this.file = file
    let raw = ""
    try {
      raw = readFileSync(file, "utf8")
    } catch (err: any) {
      if (err?.code === "ENOENT") return
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err: any) {
      throw new Error(`accounts.json: ${err?.message || err}`)
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.all = parsed as Record<string, StoredAccount>
  }

  // The store's view of one account, or null when it is missing or carries no cookies. Both maps
  // are copies: a caller that mutates what it was handed must not edit the file's contents.
  get(handle: string): Account | null {
    const item = this.all[handle]
    if (!item || !item.cookies || Object.keys(item.cookies).length === 0) return null
    return {
      id: handle,
      label: item.label || "",
      cookies: { ...item.cookies },
      cookies_exp: { ...(item.cookies_exp || {}) },
    }
  }

  handles(): string[] {
    return Object.keys(this.all).sort()
  }

  count(): number {
    return Object.keys(this.all).length
  }

  private saveLocked(next: Record<string, StoredAccount>): void {
    writePrivate(this.file, JSON.stringify(next, null, 2) + "\n")
    this.all = next
  }

  // Stores a fresh sign-in. vm is muse.ai's id for the account's VM, one per account: signing in
  // again to an account already here renews that one, under its handle and name, instead of
  // adding another. label is what Magpie shows; the sign-in time when muse.ai names no one.
  // identity is muse.ai's own `/api/falco` id for the account: it names the account when muse.ai
  // sends no readable name, and recognises the same account when the VM id is not at hand.
  add(cookies: Cookies, exp: ExpiryMap, label: string, vm: string, identity = ""): SavedAccount {
    const cleanCookies = { ...(cookies || {}) }
    const cleanExp = { ...(exp || {}) }
    const stable = cleanIdentity(identity)
    const next: Record<string, StoredAccount> = { ...this.all }
    if (vm || stable) {
      for (const handle of Object.keys(this.all)) {
        const item = this.all[handle]
        if (!(vm && item.vm === vm) && !(stable && item.identity === stable)) continue
        const renewed: StoredAccount = { ...item, cookies: cleanCookies, cookies_exp: cleanExp }
        if (stable) renewed.identity = stable
        if (vm && !renewed.vm) renewed.vm = vm
        const name = stableName(renewed.label || "", stable)
        if (name) renewed.label = name
        next[handle] = renewed
        this.saveLocked(next)
        const accountId = accountIdOf(renewed.label || "")
        return {
          handle,
          expires: expiryMs(cleanExp),
          label: renewed.label || "",
          ...(accountId ? { accountId } : {}),
          again: true,
          account: { id: handle, label: renewed.label || "", cookies: { ...cleanCookies }, cookies_exp: { ...cleanExp } },
        }
      }
    }
    const handle = "muse-" + randomHex(6)
    const created = new Date()
    const name = stableName(label, stable) || `muse.ai ${stamp(created)} 登录`
    const record: StoredAccount = { cookies: cleanCookies, cookies_exp: cleanExp, label: name, created: created.getTime() }
    if (vm) record.vm = vm
    if (stable) record.identity = stable
    next[handle] = record
    this.saveLocked(next)
    const accountId = accountIdOf(name)
    return {
      handle,
      expires: expiryMs(cleanExp),
      label: name,
      ...(accountId ? { accountId } : {}),
      account: { id: handle, label: name, cookies: { ...cleanCookies }, cookies_exp: { ...cleanExp } },
    }
  }

  update(handle: string, cookies: Cookies | null | undefined, exp: ExpiryMap | null | undefined, vm: string): void {
    const item = this.all[handle]
    if (!item) return
    const nextItem: StoredAccount = { ...item }
    if (cookies != null) nextItem.cookies = { ...cookies }
    if (exp != null) nextItem.cookies_exp = { ...exp }
    if (vm) nextItem.vm = vm
    const next: Record<string, StoredAccount> = { ...this.all }
    next[handle] = nextItem
    this.saveLocked(next)
  }

  remove(handle: string): void {
    if (!(handle in this.all)) return
    const next: Record<string, StoredAccount> = { ...this.all }
    delete next[handle]
    this.saveLocked(next)
  }
}

function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

// A sign-in time is a name only until the next sign-in: it must be replaced by muse.ai's own id
// as soon as that is known, so Magpie keeps one account instead of a look-alike per login.
const SIGN_IN_STAMP = /^muse\.ai \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? 登录$/

function cleanIdentity(identity: string): string {
  const id = String(identity || "").trim()
  return id.length > 0 && id.length <= 128 ? id : ""
}

// What the account is called: muse.ai's readable name when it sent one, else its own id.
function stableName(label: string, identity: string): string {
  if (!identity) return label
  if (!label || SIGN_IN_STAMP.test(label)) return `muse.ai #${identity}`
  return label
}

// The name to key the account by in Magpie: never a sign-in time.
function accountIdOf(name: string): string | undefined {
  return name && !SIGN_IN_STAMP.test(name) ? name : undefined
}
