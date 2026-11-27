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
