// What "signed in" means, and when that ends. Both the page driver and the engine's HTTP surface
// need the same answer, so the two definitions live here rather than in either of them.
import type { ExpiryMap } from "./types.ts"

// Cookies a sign-in must have before it counts. muse.ai used to add hatch_gw and hatch_vml
// when the chat page opened; it no longer sends either (#2, #3). Saved when a response
// sets them, never waited for.
export const ESSENTIAL = ["hatch_sess", "hatch_native_auth_device"]

// The session cookie that decides expiry, in milliseconds; null when unknown.
export function expiryMs(exp: ExpiryMap = {}): number | null {
  const pos = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)
  if (pos(exp?.hatch_vml)) return pos(exp.hatch_vml) * 1000
  const vals = ESSENTIAL.map((n) => pos(exp?.[n])).filter(Boolean)
  return vals.length ? Math.min(...vals) * 1000 : null
}
