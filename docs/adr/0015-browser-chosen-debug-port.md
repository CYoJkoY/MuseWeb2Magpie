# ADR 0015: The browser picks its own debugging port

## Status

Accepted for `0.12.0`.

## Context

The engine starts Chromium with `--remote-debugging-port=<port>` and then talks CDP to whatever
answers on that port. The port came from `freePort()`: bind `127.0.0.1:0`, read the port the OS
handed out, close the socket, and give that number to the browser.

Those two steps are not one step. Between the close and the browser's own `listen`, any local
process can bind the same port. The engine then polls `/json/version` on it and connects to the
`webSocketDebuggerUrl` it is told — and that CDP session speaks inside the engine's profile, with
the signed-in muse.ai cookies attached. A squatter that wins the race answers the probe with its
own WebSocket address, receives the session, and can drive or read the account's tab.

The engine's other defenses do not cover this. The `/v1/health` HMAC challenge protects
`engine.key`, and the transport rule keeps credentials off plain-http addresses, but the CDP
connection carries no key: the connection *is* the credential. A port that answers first is
trusted.

## Decision

- **The browser chooses.** `launchBrowser()` passes `--remote-debugging-port=0` and reads the port
  the browser actually bound from `<profileDir>/DevToolsActivePort`, the file Chromium writes once
  its own listener is up. There is no window between "this port is free" and "the browser owns it",
  because the engine never names the port.
- **A stale file is not an answer.** The profile directory may still hold a `DevToolsActivePort`
  from an earlier browser, naming a port this one does not own. `launchBrowser()` removes it before
  spawning, so the only file that can be read is the one this browser writes.
- **The file is parsed narrowly.** `readActivePort()` gives up on anything over 4096 bytes, on a
  first line that is not a port in `1..65535`, and on a second line that does not start with
  `/devtools/browser/`. A file that does not look like Chromium's is treated as no answer at all,
  and the wait loop keeps polling.
- **The answer must point back at the same port.** `debuggerUrl()` accepts only a `ws:`/`wss:` URL
  whose port equals the port from the file, whose host is loopback (`127.0.0.1`, `::1`,
  `localhost`), and whose path is under `/devtools/browser/`. The browser is started with
  `--remote-debugging-address=127.0.0.1`, so anything else on that port is a different listener.
- **No port override.** `LaunchOptions.port` is gone; the browser's own choice is the only source,
  so a caller cannot reintroduce the guess.

## Consequences

- A local process that grabs a port can no longer be handed a CDP session for the account. It
  cannot guess the browser's port either: the port exists only after the browser binds it, and the
  file that names it lives in a directory only this user can write (`mkdtempSync` creates `0700`
  on macOS and Linux; Windows temp lives under the user's profile).
- A second launch on a profile that a live browser already holds now times out instead of
  connecting to the wrong port. That is the honest answer: this launch did not get a browser.
- Startup costs one small file read per 250 ms poll. Nothing else about the launch changes: the
  same arguments, the same stderr capture, the same exit reporting, and the same `Launched.port`
  for callers such as the sign-in page's `/json/list` lookup.
- `test/browser-recovery.test.ts` pins the parse matrix (valid file, CRLF, missing second line,
  port 0, non-numeric, out of range, oversized), the address check (right port, wrong port, not
  loopback, page target, plain http, junk), and that the engine asks for port 0. The existing
  recovery test starts a real Chromium through the new path.

## Revision: the page target follows the same rule (`0.12.2`)

The decision above covers the answer `/json/version` gives. The engine also asks that port for
`/json/list`, from the sign-in poll, and it used to connect to whatever `webSocketDebuggerUrl`
the first page target named. That is the same squatter one step later: the sign-in window is open
for minutes, so the browser can be gone when the poll asks, and whoever binds the port next
answers the list. The engine would then open a CDP session to an address of that process's
choosing and send `Page.navigate` down it.

- `endpointUrl()` now holds the one check - `ws:`/`wss:`, loopback host, the exact port, and a path
  prefix. `debuggerUrl()` is that check with `/devtools/browser/`, the new `pageUrl()` with
  `/devtools/page/`.
- `chatTarget()` in `engine/login.ts` picks the target: a page whose address passes `pageUrl()` for
  this port, preferring the tab on the configured site, and `openChat()` connects only to that.
  A list with no such page sends nothing and leaves a note on the sign-in run, so a taken port
  reads as an explanation instead of a timeout.
- `test/login-target.test.ts` pins the hijacked list (other port, LAN host, browser endpoint, plain
  http, junk, no address), the site preference, non-page targets, and answers that are not lists.
  `test/browser-recovery.test.ts` pins the `pageUrl()` matrix next to the `debuggerUrl()` one.

Nothing changes for a healthy browser: it answers `ws://127.0.0.1:<port>/devtools/page/<id>`,
which passes unchanged.

## Revision: the answers on that port are bounded (`0.12.3`)

Both answers the engine takes from the port were still read with `res.json()`, and the checks
above only see a parsed answer. That left the cheapest version of the same attack: a process that
takes the port does not have to impersonate CDP at all — it only has to answer with a body that
never ends. Loopback hands over hundreds of megabytes in the seconds before the timeout fires, and
the engine dies before any address rule runs. A timeout bounds the wait, not the bytes.

- The read rule now lives in `engine/bounded.ts` (`declaredLength()`, `readBounded()`,
  `boundedJson()`), shared by the fingerprint-browser installer and the CDP client. It was already
  written for the installer (ADR 0013); a second copy in the protocol layer would have been a
  second place to forget the ceiling.
- `engine/cdp.ts` `httpJSON()` reads through `boundedJson()` with `MAX_DEVTOOLS_BYTES` (1 MiB — a
  real `/json/list` for a normal window is a few KB), so a declared size past the ceiling is
  refused before a byte is buffered, and a stream is cancelled the moment it crosses it.
- `engine/login.ts` `openChat()` uses that same `httpJSON()` instead of its own
  `anyFetch(...).then((r) => r.json())`, so the launch probe and the sign-in poll cannot drift
  apart again.
- `test/devtools-bounded.test.ts` stands a real listener on loopback in the browser's place: an
  announced 8 GiB body is refused from the announcement, an endless body is cut off at the ceiling
  with the reader cancelled, a body within the ceiling that is not JSON gets its own reason, a
  normal answer still parses, and `openChat()` is bounded by the same rule.

## Revision: a start that never opens its port says why (`0.12.4`)

The wait for `DevToolsActivePort` was 30 s, and its failure was one sentence: `browser did not open
its debugging port: ${last?.message ?? "timeout"}`. The `test` workflow failed twice on that same
sentence for the same commit — `timeout` on windows-latest (no usable file for 30 s, process still
alive) and `The operation was aborted` on ubuntu-latest (file present, every 1.5 s probe cut) —
while the other two platforms were green and the same test finishes in 1.7 s locally. The launch
that failed is the first real one of the whole job, which is the slowest launch there is.

- The default budget is `START_BUDGET_MS` (60 s), and `MUSE_WEB_START_MS` raises it for a machine
  slower still. A value that is not a usable number of milliseconds leaves the default alone.
- Each `/json/version` probe gets what is left of the budget rather than a fixed 1.5 s, so `waitMs`
  is the ceiling it claims to be: the old 30 s budget could run to 33 s before giving up.
- `startTimeout()` builds the failure from the facts that separate the cases — how long the engine
  waited, whether `DevToolsActivePort` is still missing or what it holds (200 bytes at most), the
  last probe's answer, and the browser's last three stderr lines. `startFailure()` shares that
  stderr tail, so both ways a start can fail report the same way.
- The failure is built before the temporary profile is closed. Closing removes that directory, so
  the other order reports a port file that was there all along as one that never arrived — which
  is exactly the case the message exists to separate.
- `test/browser-start.test.ts` pins the message matrix, the budget rules, and a POSIX-only stall
  (a fake browser that writes a port file nobody can use and stays alive) so the loop is exercised
  without a browser, including the order above. The real-browser recovery test's deadline follows
  the budget to 180 s.

A retry inside the test would have made the run green without saying anything about the cause; the
budget and the message are what make the next occurrence either not happen or explain itself.
