# ADR 0003: The local engine's security posture

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

The engine holds live muse.ai sessions and speaks a simple HTTP surface on the local machine. Its
trust boundary is unusual: the operator is trusted, the network and any page the engine's own
browser loads are not, and the operating system is the only thing separating one user from another.
`0.11.0` already defaulted to loopback-only listening, a bearer key, private files and redaction;
what was missing was a written model plus two concrete gaps found in an audit:

- `browserArgs()` passed `--remote-allow-origins=*` to every engine browser. With it, any page
  loaded in that browser could open a DevTools WebSocket to the same process — the port is
  random and loopback-only, but a page the profile visits (or an ad inside muse.ai) can read the
  port from the page URL/`chrome://` surface it is running under and drive CDP: read cookies,
  evaluate scripts, control the session.
- Responses carried no `nosniff`, no default `no-store`, and the sign-in progress page had neither a
  CSP nor frame/referrer controls, even though it is opened by a person in their own browser.

## Decision

- **Never allow a web origin to reach CDP.** `engine/browser.ts` keeps
  `--remote-debugging-address=127.0.0.1` and the random port, and drops
  `--remote-allow-origins=*`. Chrome/Chromium then refuses a DevTools WebSocket handshake that
  carries an `Origin` header, which is exactly what a page sends and what our client (Node's
  `WebSocket`, no `Origin`) does not. `test/engine.test.ts` asserts the flag is absent and the
  address is present; the real-browser tests in `test/bundled.test.ts` keep the whole path honest,
  and a Wayfern-kernel smoke run confirmed a bare handshake goes through while an
  `Origin: http://evil.test` handshake is answered `403 Forbidden`.
- **Harden every response in one place.** `response.header()` in `engine-go/server.go` now sets
  `x-content-type-options: nosniff` and defaults `cache-control: no-store` unless the caller set its
  own (the SSE stream keeps `no-cache`). The `/login/<id>` page additionally gets
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`, `x-frame-options: DENY` and
  `referrer-policy: no-referrer`.
- **Write the model down.** `SECURITY.md` states the invariants (loopback-only, bearer with
  constant-time compare, `0700`/`0600` files and atomic writes, redaction, omitting the CDP origin
  wildcard, an 8 MB body cap with header timeouts, `nosniff`/`no-store`, an escaped minimal sign-in
  page with a strict CSP, verified downloads and a traversal-safe zip reader, no reuse of the daily
  browser profile), the trust boundary, and the residual risks the project accepts.

## Alternatives considered

- **Keep `--remote-allow-origins=*` and rely on the random port.** Rejected: the port is not a
  secret to a page in the same browser, and the flag throws away a check Chrome already provides
  for free.
- **Pass an explicit allowlist instead of omitting the flag.** Rejected as unnecessary: our client
  sends no `Origin`, so an empty allowlist (the default) already admits it while keeping pages out.
  An allowlist would only help a browser-based debugger, which this engine does not use.
- **Centralize headers in a middleware on `http.Server`.** Equivalent, but `response.header()` is
  the single funnel every route already flows through, and it keeps the SSE and HTML exceptions
  next to the code that needs them.
- **Add a keyed challenge to `/v1/health` now.** Deferred: it needs a coordinated Go + TypeScript
  change plus a version-negotiation path for an older engine, and the exposure is limited to the
  same user. `SECURITY.md` records it as a planned improvement.

## Consequences

A page inside the engine profile can no longer drive DevTools, and every answer is harder to
misinterpret or cache. The engine's own CDP client is unaffected because it never sends an
`Origin`, and the change is covered by both unit and real-browser tests. `SECURITY.md` becomes the
place to update when a boundary changes, and the deferred `/v1/health` challenge is tracked there
rather than silently dropped.
