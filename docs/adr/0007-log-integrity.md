# ADR 0007: One log record is one line, and no caller can add one

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

`engine.log` is what a person reads when a chat fails, and it is the only record of which account
served which request. Every request line is written by `ServeHTTP` after the answer, and it
includes the request path:

```go
line := fmt.Sprintf("%s %d %s %s", timeString(), res.status, r.Method, r.URL.Path)
```

`r.URL.Path` is percent-decoded. A request for `/v1/health%0A2026-11-27T00:00:00 200 GET
/v1/accounts account=muse-forged` therefore reached the log with a newline in the middle of it, and
`engine.log` gained a second record that looked exactly like a real one. The sender needs no key:
the path is logged before any answer, and the "not found" case is the easiest one to reach.

The same hole existed for text the engine itself does not author: a proxy error, a page-side
message, a driver line. None of them can be trusted to hold one line.

Separately, `lineWriter` — the driver's stderr — buffered bytes until it found a newline, with no
ceiling. A child that writes continuously without one (a wedged runtime printing a progress bar, a
bug in the driver) grew that buffer for as long as it ran.

## Decision

- **One exit, one rule.** `logger.Log()` is the only place that writes a record, to the terminal and
  to `engine.log` alike. It runs the formatted line through `oneLine()` first, so the rule cannot be
  forgotten by a new caller.
- **`oneLine()` is a whitelist of harmless characters, not a list of banned ones.** `\r`, `\n`,
  `\t`, the rest of C0, DEL, and the two Unicode line separators U+2028 / U+2029 each become a
  space; everything else is kept, including Chinese text and account handles. A blocklist would
  have to anticipate every terminal escape and every future line break.
- **A record is bounded.** `oneLine()` stops at `logLineLimit` (2048 bytes) and appends `...`, so a
  single message cannot push the rest of the log out of view.
- **The driver's unfinished line is bounded too.** `lineWriter` drops a partial line once it passes
  `maxDriverLine` (64 KB) and logs that it did, so a misbehaving child costs one record, not the
  process's memory.
- **Redaction stays where it was.** `redact()` still runs at the call sites that handle credentials;
  `oneLine()` is about record shape, not about what may be said, and doing both in one place would
  hide which rule failed.

## Consequences

- A record in `engine.log` can be trusted to be one line, so `grep`, `tail` and a diff of two logs
  mean what they look like. A forged line would now need the key and a real endpoint.
- A path that contains a newline is still visible in the log — with a space where the newline was —
  so the attempt is recorded rather than silently dropped.
- Very long records are truncated. For the one case that matters, an upstream error text, the first
  2 KB is where the status line and the message are; the rest was never read by a person anyway.
- `TestUnauthenticatedRequestCannotForgeALogRecord`, `TestOneLineStripsWhatAForgedRecordNeeds`,
  `TestOneLineBoundsOneRecord` and `TestDriverLogWriterBoundsUnfinishedLine` pin the rule from the
  HTTP surface, the function, and the child-process writer.
