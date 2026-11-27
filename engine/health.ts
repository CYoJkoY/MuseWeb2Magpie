// Proving a loopback port is really our engine without handing over engine.key.
//
// `/v1/health` is unauthenticated on purpose: the plugin has to ask "is an engine up, and which
// version?" before it decides to start, replace or talk to one. The catch is that anyone who binds
// the port first could answer in the engine's name and be handed the key. So the caller sends a
// nonce and the engine answers with an HMAC only a holder of engine.key can compute; the key
// itself never travels, and a caller that cannot produce a proof is never sent a key.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const CHALLENGE_HEADER = "x-muse-challenge"
const PREFIX = "muse-web-health:"

// A fresh nonce per question, so a recorded answer cannot be replayed.
export function healthChallenge(): string {
  return randomBytes(16).toString("hex")
}

// Kept byte-for-byte with engine-go's healthProof.
export function healthProof(key: string, nonce: string): string {
  return createHmac("sha256", key).update(PREFIX + nonce).digest("hex")
}

export function provesHealth(body: any, key: string, nonce: string): boolean {
  const got = typeof body?.proof === "string" ? body.proof.trim().toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(got)) return false
  const want = healthProof(key, nonce)
  return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"))
}
