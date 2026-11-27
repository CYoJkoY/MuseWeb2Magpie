# ADR 0008: The open page does no work, and every route runs under a fixed in-flight budget

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

Two of the engine's rows answer without the key: `GET /v1/health` and `GET /login/{id}`. Being
unauthenticated makes them the cheapest way for any local user — or any program that can reach
`127.0.0.1:18611` — to make the engine spend resources. Two properties of the old code made that
worse than it needed to be.

First, the progress page did work before deciding there was nothing to show. `handleLoginPage`
called `loginState`, which asks the driver, and the driver's `ensure()` starts the Node/browser
process on first use. So a GET for a login id that never existed — no valid id required, only the
shape `non-empty and no slash` — could spawn a browser-driving process and then discard the
result. Every such request also registered a fresh driver stream (`make(chan event, 256)`, about
100 KB of buffered channel) for the duration of the call.

Second, nothing bounded concurrency. Chats had a per-account lock, so a second chat for the same
account answered 429, but usage reads, refreshes, login starts and the open page itself had no
ceiling at all. A loop of requests to the open page, or a loop of keyed reads, grew goroutines and
memory for as long as it ran.

## Decision

- **The shape of a login id is checked in the route's matcher.** `validLoginID` accepts 8–32
  characters of `[A-Za-z0-9_-]`, which is what `login_start` hands out (9 random bytes in
  base64url, 12 characters) and nothing else. Both login rows share the rule, so a made-up path is
  a plain 404 and never reaches a handler.
- **The page answers without the driver when nothing is running.** `handleLoginPage` reads
  `driver.Running()` — a mutex and a boolean, no side effects — and renders the "no such sign-in"
  page when it is false. `ensure()` is never reached from an unauthenticated request, so the open
  surface cannot launch a process, and the common case for a stranger's request is a static string.
- **Admission comes after authorization and before the handler.** Two fixed budgets live on the
  engine: `openInFlight = 4` for rows that need no key, `keyedInFlight = 64` for rows that do. A
  request takes a token without waiting; if the budget is spent it gets `503 engine_busy` with
  `Retry-After: 1`. Authorization runs first, so a caller guessing keys spends constant time and
  never holds a token — a flood of wrong keys cannot crowd out a caller that has the right one.
- **`/v1/health` is exempt.** It is the row the plugin uses to answer "is an engine up, and which
  version?", and its answer is a few bytes with no driver work and no account state. Refusing it
  would make a busy engine look like a dead one, which is exactly the wrong signal during an
  incident.
- **The numbers are fixed, not adaptive.** Four open pages is more than a person opens at once;
  64 keyed requests is far above what Magpie issues (one chat per account, one usage read per
  account) while still being a ceiling a runaway loop hits quickly. Adapting to load would need a
  policy for what "load" means and would behave differently on every machine.

## Consequences

- An unauthenticated caller can no longer make the engine start a process, and can no longer make
  it hold more than four open-surface requests at a time.
- A flood on the open surface is answered with 503 rather than by queueing: the answer is honest
  and cheap, and it does not park goroutines inside the handler.
- The keyed surface now has a ceiling that a buggy client can reach. `Retry-After: 1` tells it to
  come back; the plugin passes engine headers through unchanged, so a host that honours that header
  recovers on its own.
- A login id shorter than 8 characters would stop matching. The generator produces 12, and
  widening the rule later is a one-line change in `validLoginID`.
- `TestUnauthenticatedLoginPageStartsNoProcess` proves the property the hard way: it points
  `MUSE_WEB_NODE` at the test binary itself, so any spawn writes a marker file, asserts the marker
  is absent after a page GET, and asserts it appears after a keyed login start through the same
  runtime. `TestOpenSurfaceRefusesWhenItsBudgetIsSpent`,
  `TestKeyedSurfaceRefusesWhenItsBudgetIsSpent`, `TestWrongKeySpendsNoBudget` and the extended
  `TestWrongLoginIDFormatStaysNotFound` pin the rest.
