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
