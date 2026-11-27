# ADR 0004: A health challenge that proves the port before it gets the key

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

`/v1/health` is unauthenticated on purpose: before deciding to start, replace or talk to an engine,
the plugin must ask "is an engine up, and which version?" without having a key yet. The catch is
that whoever binds the port first can answer in the engine's name. When the plugin then sent
`engine.key` — on `/v1/shutdown`, `/v1/usage`, `/v1/login` or chat — that key went to whatever held
the port, which in the worst case is a squatter, and in the ordinary case is an engine left running
from before an upgrade. Either way the port receives a credential it may not deserve.

The port is fixed (`MUSE_WEB_ENGINE_PORT`, default `18611`) because the provider URL is written
into Magpie's configuration when the plugin loads; falling back to a random port per start would
leave the configured URL pointing at a dead address.

## Decision

- **The engine can prove it holds `engine.key` without sending it.** A caller sends
  `x-muse-challenge: <nonce>`; the engine answers `/v1/health` with
  `proof = hex(HMAC-SHA256(engine.key, "muse-web-health:" + nonce))`. The prefix keeps the answer
  from doubling as a signature over anything else, the nonce is validated (8–64 chars of
  `[0-9A-Za-z_-]`) so the endpoint is not a MAC oracle over arbitrary input, and the key itself
  never travels. `engine-go/config.go`'s `healthProof` and `engine/health.ts`'s `healthProof` are
  byte-for-byte identical, pinned by shared test vectors in `engine-go/health_test.go`.
- **Only a proven port receives the key.** `index.ts`'s `inspect()` sends a fresh nonce with every
  health check and compares the proof with `timingSafeEqual`. A port that answers in the engine's
  name but cannot prove itself (`trouble`) is never given `engine.key` or an account handle: chat,
  usage, refresh, sign-in and shutdown all go through the same `ours()` gate, and `loader.fetch`
  refuses outright.
- **A stray port fails fast with a message a person can act on.** `ensureEngine()` does not spawn
  (the port is taken) and does not wait; it reports "端口已被占用，且无法证明持有 engine.key
  （常见于升级后仍在运行的旧版引擎），请重启 Magpie 或结束该进程". The old engine is killed by the
  parent-PID watchdog when Magpie restarts, and exits after 60 minutes of idleness regardless.
- **A provable old engine is still retired.** An engine older than this plugin but holding the
  same key proves itself, receives the key on `/v1/shutdown`, and is replaced — preserving the
  existing upgrade semantics.
- **Same check in the Go engine's own startup.** `sameEngine(port, key)` now sends a challenge too,
  so the Go engine also refuses to treat an unproven squatter as "another engine already serving".

## Alternatives considered

- **Pick a free port at start and write it somewhere for the plugin to read.** Rejected: the
  provider's `api` URL is fixed when Magpie's provider configuration is written, so the configured
  URL would point at a port that is no longer ours. It also turns the file that would carry the
  port into a new trust question.
- **Authenticate `/v1/health` outright.** Rejected: the bootstrap question — "is anything there,
  and which version?" — is asked before the plugin has a key, and a 401-to-everything port would
  look identical to an engine that has lost its key file.
- **Send the key over the challenge response.** Rejected: the response travels unauthenticated; the
  whole point is to prove identity without ever sending the credential to the prover.

## Consequences

A port that cannot prove it holds `engine.key` is never handed it, closing the "port squatter
receives the key" path recorded as a residual risk in ADR 0003 and `SECURITY.md`. The behavior
change is visible: after upgrading, an engine left over from the previous version makes the plugin
report the port as occupied and ask for a Magpie restart, instead of silently replacing it. The
check costs one round trip per health probe and is covered by `test/engine-identity.test.ts` (no
key without proof; a proven old engine is retired with the key), the challenge assertions in
`test/go-engine.test.ts`, and the real-browser path in `test/bundled.test.ts`, whose fake legacy
engine now proves itself like a real one.
