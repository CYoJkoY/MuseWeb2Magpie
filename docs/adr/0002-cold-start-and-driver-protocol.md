# ADR 0002: Bounded cold start and a leaner driver protocol

> Note (`0.12.0`): the engine is TypeScript now; the `engine-go/*` paths below name the pre-`0.12.0` Go engine. See [ADR 0016](0016-typescript-engine.md).

## Status

Accepted for `0.11.0`.

## Context

A saved account set is warmed in parallel when the engine starts and after every sign-in. Warming
each account means opening its muse.ai page, so the parallel phase is intentionally unbounded in
account count but bounded by the browser's own tab handling. The step that follows it — reading
each account's usage — was serial, so with many accounts the last card could lag the first by the
full sum of every reading. A reading opens its own tab and waits on muse.ai, so the fixed cost per
account is the browser round trip, not local CPU.

Two protocol paths also cost more round trips than they need. Placing cookies sent one
`Storage.setCookies` call per cookie per domain; sending a message focused and scrolled the
composer, then measured it in a second evaluation before dispatching the click.

The engine is a local process whose only external dependency is the browser. The useful question
is not throughput but how quickly a first request becomes possible while a large saved set warms,
and how little work a chat does that muse.ai does not need.

## Decision

- **Usage reads run in a bounded pool of three.** `engine-go/main.go` and `engine/driver.ts` both
  cap concurrent usage reads at `3`. Each read opens one tab; the pool keeps a large saved set from
  flooding the browser with tabs while finishing well ahead of a serial loop. Go drains the pool
  through a channel of accounts and a fixed set of workers, so cancellation closes the workers
  without leaking goroutines. Both sides log the phase totals (`prewarm accounts=N warm=Xms
  total=Yms`, `warm done accounts=N Xms`).
- **Cookie injection is one call, with a per-cookie fallback.** `Muse.setCookies` builds every
  cookie spec for both the host and its dot-domain and sends them in a single
  `Storage.setCookies`. Only if the browser rejects the batch does it fall back to placing them one
  at a time, so a single malformed cookie cannot cost the whole sign-in.
- **Sending a message measures the composer in the same evaluation that focuses it.**
  `Muse.send` no longer spends one evaluation focusing and scrolling and a second reading the
  bounding rect; it does both in one page evaluation and throws if the composer is absent.
- **Post-answer usage defers to a new chat.** The delayed usage refresh re-checks the account's busy
  flag before reading, so a reading that would merely queue behind a fresh conversation is dropped.
- **Benchmarks cover the protocol hot paths.** `engine-go/driver_bench_test.go` measures decoding a
  streamed line, decoding the final line, encoding the chat request, and the account lookup; the
  numbers are recorded in `docs/perf.md`.

`WriteTimeout` on the HTTP server stays unset on purpose: streaming responses run as long as the
model takes, and a fixed write deadline would cut a slow answer mid-stream.

## Alternatives considered

- **Leave usage reads serial.** Simplest, but a large saved set pays the sum of every reading before
  the last card updates.
- **Make usage reads fully concurrent.** Rejected: one tab per account at once is exactly the
  browser-tab flood the pool avoids, and the win past three is small because muse.ai's per-reading
  latency dominates.
- **Add a fixed write timeout to the HTTP server.** Rejected: it would truncate long streamed
  answers.
- **Keep the two-evaluation send path.** Rejected: the second evaluation carries no new state and
  only adds a CDP round trip to the slowest part of a chat.

## Consequences

- Cold start with many accounts finishes sooner, and the log shows the warm phase and the total
  separately.
- Cookie writes and message sends each use one round trip in the common case; the fallbacks trade a
  little code for resilience.
- `npm run bench` and the recorded numbers make protocol regressions visible.
- The pool size is a constant, not a knob: it is chosen for the browser, not for the host CPU.
- Nothing here imitates human behavior or targets site abuse detection; it is cold-start and
  round-trip work on a local process.
