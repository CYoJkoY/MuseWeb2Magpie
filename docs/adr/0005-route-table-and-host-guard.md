# ADR 0005: A route table that declares auth, and a Host guard against DNS rebinding

> Note (`0.12.0`): the engine is TypeScript now; the `engine-go/*` paths below name the pre-`0.12.0` Go engine. See [ADR 0016](0016-typescript-engine.md).

## Status

Accepted for `0.12.0`.

## Context

The loopback surface grew one endpoint at a time. `route()` had become a ~120-line `switch` in
which every protected branch had to remember to call `authorize()` itself — seven hand-written
calls, one per branch. The invariant "every `/v1/*` requires the key" was true only because each
author remembered it. Adding the ninth endpoint would be another place to forget, and nothing in
the code made the set of unauthenticated endpoints visible at a glance.

Separately, every answer — including the two unauthenticated GETs (`/v1/health` and the login
progress page) — was served to whoever reached the port, regardless of the `Host` header. On a
machine where a page can resolve a domain to `127.0.0.1` (classic DNS rebinding), that page could
read the health answer and the login page. Both are harmless-looking today, but each is one new
"harmless" GET away from carrying something worth stealing.

## Decision

- **Routes are declared, not remembered.** `routes()` builds a table once per engine: each row
  is a method, a pattern, whether it needs the key, and its handler. `route()` walks the table,
  authorizes before the handler runs when the row says so, and dispatches. Adding an endpoint
  means adding a row; whether it is open is a deliberate `auth: false` in review, not an omitted
  function call.
- **The tests read the same table.** `engine-go/server_test.go` walks `e.table` and proves (a)
  every row with `auth` answers 401 before any handler runs, and (b) the set of `auth: false`
  rows is exactly `GET /v1/health` and `GET /login/{id}`. A new open endpoint fails the test
  until someone consciously updates the expected set.
- **Host must name loopback.** `ServeHTTP` checks `Host` before routing. Only `127.0.0.1`,
  `localhost`, `[::1]` / `::1` and `0.0.0.0` — with or without a port — are accepted; anything
  else gets 403 `host_not_allowed`. A rebinding page's requests still carry its own domain, so
  even the unauthenticated answers stay out of its reach.

## Alternatives considered

- **A middleware that authorizes everything by default.** Rejected: `/v1/health` and the login
  progress page must stay open, so the middleware would need its own exceptions — the same list,
  one layer further from the route it describes. The table keeps method, path, openness and
  handler on one line each.
- **Method mismatch returns 405.** Rejected for now: the plugin and OpenAI-compatible clients see
  a plain 404 today, and changing the external shape for a stricter RFC reading buys nothing on a
  loopback port that already answers only to proven callers.
- **Reject `0.0.0.0` as a Host too.** Kept accepted: `httptest` and some clients use it as "this
  machine", it names no remote origin, and the port itself still binds `127.0.0.1` only.

## Consequences

The security invariant moves from "each author remembers to call authorize()" to a declared
property of the route table, checked by tests that fail on the next forgotten row. DNS rebinding
loses even the unauthenticated GETs. The behavior change is visible to anyone pointing a non-
loopback name at the port — which the engine never advertised and the plugin never does — and the
`host_not_allowed` code joins the error-code table in `README.md`.
