# Cold start and driver protocol

This note records how the cold-start and driver-protocol work in `0.11.0` was measured, what the
numbers were, and where the hot paths are. It is upkeep notes, not a promise about any particular
machine or network.

## What was optimized

- Cold start runs the usage reads that follow warming in a bounded pool of three accounts on both
  the Go engine and the TypeScript driver, instead of one after another.
- Cookie injection places every cookie in one `Storage.setCookies`, with a per-cookie fallback.
- Sending a message focuses, scrolls and measures the composer in one page evaluation.
- The delayed usage refresh after an answer checks the account's busy flag before opening a tab.

See `docs/adr/0002-cold-start-and-driver-protocol.md` for why each was chosen.

## How to measure

Local protocol costs are plain Go benchmarks; no browser, network, or account is involved:

```sh
npm run bench
# or
go -C engine-go test -run '^$' -bench . -benchmem -count 3 ./...
```

The cold-start and end-to-end paths need a real browser and are covered by `npm test`, which drives
a headless Chrome/Edge against a loopback fake muse.ai:

```sh
npm test
```

The timing lines in the engine log are the field measurement: `prewarm accounts=N warm=Xms
total=Yms` on cold start, `warm done accounts=N Xms` in the driver, and `first=…ms` on the first
chat.

## Measured protocol cost

`go1.27.4`, `windows/amd64`, Intel Core i5-13500H. Three runs each; the table shows the median.

| Benchmark | ns/op | B/op | allocs/op |
| :--- | ---: | ---: | ---: |
| `BenchmarkEventDecodeDelta` (one streamed line) | ~840 | 416 | 1 |
| `BenchmarkEventDecodeFinal` (last line, with a tool call) | ~2,790 | 600 | 8 |
| `BenchmarkRequestEncodeChat` (chat request) | ~4,170 | 833 | 19 |
| `BenchmarkStoreGet` (account lookup) | ~320 | 592 | 4 |

Reading the numbers:

- A delta decode is under a microsecond, so per-token decoding is not the cost of a chat; the
  model's own latency is.
- The account lookup allocates because `store.Get` returns a copy, so a caller mutating the result
  cannot change the store. That copy is deliberate; the cost is hundreds of nanoseconds.
- These are the local pipe costs. Real chats are dominated by the browser and muse.ai, which is why
  the changes above target round trips rather than CPU.

## CPU profile

The benchmarks above show per-operation cost; the CPU profile shows where that time goes. Point
`-cpuprofile` at a scratch path; `*.prof` is ignored so a stray profile cannot be committed.

```sh
go -C engine-go test -run '^$' -bench . -benchtime 2s -cpuprofile cpu.prof ./...
go -C engine-go tool pprof -top -nodecount=14 cpu.prof
```

`-benchtime 2s` matters: the default 300 ms per benchmark is too short for the sampler to collect
enough ticks, and a run at that length produced zero samples.

One run on the machine above collected 17,270 ms of samples over 13.5 s. The top flat nodes:

| Node | flat% | cum% |
| :--- | ---: | ---: |
| `unicode/utf8.decodeRuneSlow` | 4.34 | 4.34 |
| `runtime.preemptM` | 3.47 | 4.11 |
| `runtime.sysUnusedOS` | 2.95 | 2.95 |
| `jsonwire.ConsumeStringResumable` | 2.72 | 7.53 |
| `runtime.scanObject` | 2.55 | 6.14 |
| `runtime.typePointers.next` | 2.08 | 2.32 |
| `runtime.scanblock` | 1.97 | 2.37 |
| `jsonwire.ConsumeWhitespace` | 1.91 | 1.91 |
| `jsonwire.AppendQuote` | 1.68 | 2.49 |

Reading the profile:

- No single function owns the time. The largest flat node is 4.34%, and the whole `encoding/json`
  path (`ConsumeStringResumable`, `ConsumeWhitespace`, `AppendQuote`, `AppendUnquote`) accumulates
  most of its share through the struct codec, which is 30.8% cumulative. That is the cost of
  turning every streamed line into an `event` and every request into JSON.
- The next cluster is garbage collection and scheduling (`scanObject`, `scanblock`,
  `typePointers.next`, `preemptM`, `sysUnusedOS`). The benchmarks allocate 1–19 objects per
  operation, so the collector has steady work; this is the price of the copy-on-read store and the
  per-line decode, not a leak.
- `utf8.decodeRuneSlow` is the slow path for non-ASCII runes. It appears because chat payloads are
  Chinese, so most characters take the multi-byte branch instead of the fast ASCII one.
- The absence of a hot user function is the point: local protocol work is spread thin, and a real
  chat spends its time in the browser and muse.ai. Optimizing this profile further would shave
  microseconds off a path already measured in microseconds.

## Hot paths

- **Engine → driver:** each operation is one JSON object written by `driver.send` (`json.Marshal`)
  and one line on stdin. A chat is one `chat_stream` request; its answer arrives as a stream of
  `delta` lines plus a `final`.
- **Driver → engine:** `driver.readLoop` unmarshals every line into `event` and hands it to
  `dispatch`, which routes it to the waiting call or treats it as an unsolicited `cookies`, `lost`
  or `log`.
- **Per HTTP request:** `authorize` checks the bearer key, `account` decides which account answers,
  and `store.Get` returns that account's copy.
- **Cold start:** warm all accounts in parallel, then read usage in the pool of three. The two
  phases are logged separately.
- **A chat:** `acquire` marks the account busy, `chat_stream` streams deltas, and 1.5 s after the
  answer a usage refresh runs unless a new chat already owns the account.
