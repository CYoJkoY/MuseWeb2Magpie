# ADR 0010: The configured site follows the credential transport rule

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

ADR 0006 established that credentials — `engine.key` and account handles — travel in the clear
only to loopback, and only over https anywhere else. But the engine holds a second credential that
that rule never reached: the muse.ai session cookie itself. `MUSE_WEB_SITE` decides which origin
receives it — the browser carries it on every page, and every API call in `muse.ts` sends it to the
same origin. The value was never checked: `MUSE_WEB_SITE=http://mirror.example.test` would have
sent real session cookies to an arbitrary machine in clear text, while `MUSE_WEB_ENGINE` with the
same shape was refused outright.

The value was also where a typo went to die. `MUSE_WEB_SITE=muse.ai` (no scheme) parsed as a
browser command-line argument far from its source, and the failure surfaced as a browser that
would not load a page rather than as a message about the site.

The Go binary carried `cfg.site` but no Go code read it: the site belongs to the driver, which
owns the browser and the page. Keeping the field made it look like a second place a site could be
set from — one that did nothing.

## Decision

- **One predicate, both callers.** `engine/site.ts` exports `siteProblem()`: null when the value
  may be used, otherwise a sentence saying why not. The plugin calls it before spawning an engine
  (`index.ts`, `ensureEngine()`), so the reason appears on the usage card in Magpie instead of a
  running engine. The driver calls it once at startup (`engine/driver.ts`) and refuses every
  operation that would touch the site until it is fixed, which covers an engine started by hand.
  The two `stop` operations keep working so the engine can be shut down cleanly despite the bad
  value.
- **The rule matches ADR 0006 for the credential it protects.** http is allowed only to loopback
  (`127.0.0.1`, `localhost`, `[::1]` — the same set `isLoopbackUrl` already answers for the engine
  address); https is allowed anywhere; anything else, including credentials in the URL, is
  refused. The default (`https://muse.ai`) is unaffected.
- **No work happens for a bad site.** The driver logs the reason, answers every non-stop op with
  it (`kind: invalid_request`), and skips `prepareBrowser()` — which could otherwise download the
  fingerprint browser for requests that will never be served.
- **The Go binary no longer declares a site.** `cfg.site` is deleted; there is exactly one place
  a site is read from, the driver.

## Consequences

- A mirror or test server on loopback keeps working (`http://127.0.0.1:3000`), and the real site
  needs no configuration. A mirror over plain http on another machine is refused before an engine
  starts, with the reason on the card; the same value over https is accepted.
- A typo in the value no longer reaches a browser: the error names `MUSE_WEB_SITE` and the rule.
- The plugin and driver agree by construction — same predicate, same wording — and the driver
  check stands even when the engine is started by hand, bypassing the plugin.
- `test/site.test.ts` pins the accepted and refused sets, the default handling, and the plugin's
  refusal; `test/go-engine.test.ts` already ran the engine against a loopback fake, which the rule
  now makes explicit.
