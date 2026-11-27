# ADR 0006: Credentials ride only loopback or https, and the listener gets a read deadline

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

The plugin's own engine listens on `127.0.0.1`, where plain http is fine: the bytes never leave the
machine. But `MUSE_WEB_ENGINE` (and the `engine` option) let a person point the plugin at an engine
run elsewhere, and nothing stopped that address from being a plain-http LAN or domain name. On that
path `engine.key` and every account handle — both credentials — crossed the network in the clear,
readable by anyone on the path. The address can be typed by a person or dropped into the
environment by an agent, and it was accepted either way.

Separately, the listener set `ReadHeaderTimeout` and `MaxHeaderBytes` but no deadline on the request
body. Any local user can reach the port; a request that sends headers promptly and then trickles
body bytes could hold the connection and its goroutine far longer than any real chat request needs,
since chat bodies are a few KB of JSON.

## Decision

- **A credential is safe only where the carrier is.** `engine/local-fetch.ts` adds
  `credentialSafeUrl(value)`: true for a loopback URL, otherwise true only when the scheme is
  `https:`. `index.ts` computes `originTrouble()` for a named engine and refuses before probing when
  the origin is neither: `inspect()` returns "answered: false" without a network call, `ours()`
  returns false, and both `usage` and `loader.fetch` report a message that names the rule (https or
  `127.0.0.1`). The connection to a refused origin is never opened, so no byte of `engine.key` or an
  account handle is offered.
- **The rule is a whitelist, not a blocklist.** Only loopback or `https:` passes; everything else —
  public IPs, bare domain names, lookalike hostnames like `127.0.0.1.evil.test`, `file:` URLs,
  empty or malformed strings — is refused. A blocklist would leak the next scheme someone invents.
- **The listener bounds the request.** `engine-go/main.go` builds the `http.Server` in one place,
  `newHTTPServer()`, with `ReadHeaderTimeout`, `ReadTimeout` (headers and body together) and
  `MaxHeaderBytes`, and deliberately no `WriteTimeout`, which would cut a streaming SSE answer
  short. The body is rejected for want of the key before it is read, so the deadline mainly bounds
  a connection that never finishes arriving.
- **The unauthenticated health answer stays thin.** `/v1/health` is still open so the plugin can ask
  "is an engine up, and which version?", but it no longer reports the account count. Whoever can
  reach the port can ask, and how many accounts sit in the data directory is not their business;
  the count stays behind the key at `/v1/accounts`.

## Alternatives considered

- **Require https for the loopback engine too.** Rejected: that would mean shipping and trusting a
  local certificate for a service that only ever talks to itself over `127.0.0.1`. Plain http on
  loopback never leaves the machine, so it is already as private as the file permissions that hold
  the key.
- **Allow plain http but warn.** Rejected: a warning is read once and then ignored, while the key
  keeps crossing the wire unencrypted on every chat. Refusing the origin is the only outcome that
  keeps the credential off the wire; a person who really means to use another host can put it behind
  https.
- **Set a `WriteTimeout` as well.** Rejected: it is measured from the end of the request headers and
  would abort long, slow streamed answers. `ReadTimeout` already covers the direction an attacker
  controls — slow inbound bytes.

## Consequences

A plain-http external engine on another host no longer works; the plugin reports the transport rule
and asks for https or `127.0.0.1`. This is a visible behavior change for anyone who pointed
`MUSE_WEB_ENGINE` at a LAN address, noted in `CHANGELOG.md`. The loopback default and its fixed
port are unchanged, so the common case — the plugin's own engine — is untouched. Covered by
`test/engine-origin.test.ts` (allowed and refused origins, and that a refused origin receives no
key), `TestHTTPServerSetsItsLimits` and `TestHealthDoesNotCountAccounts` in
`engine-go/server_test.go`, and the updated account-count assertion in `test/go-engine.test.ts`.
The `SECURITY.md` invariants grow to fourteen, on top of the route table and Host guard from
ADR 0005.
