# ADR 0013: Remote responses are read under a ceiling

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

`engine/fingerprint.ts` reads three things off the network while an engine starts: the GitHub
release document, a release's `.manifest.json`, and the browser archive itself. All three were read
whole. The JSON reads called `res.json()`, and the download called
`Buffer.from(await res.arrayBuffer())` and only then wrote the file.

The size of a response is decided by whoever answers, not by us. A server that never ends its body,
or one that is simply broken, therefore had two ways to hurt the host: the JSON path would grow
memory until the process died, and the archive path would hold the entire body in memory *and* then
write it, so a body larger than free memory failed late, after the work was done.

The engine installs this browser on its own, without a person watching, and a failed install is
supposed to fall back to the system Chromium — not to take the engine down first.

## Decision

- **Two ceilings, named once.** `MAX_ARCHIVE_BYTES` (512 MiB) covers the archive; a real Chromium
  build is around 150 MB, so the limit leaves room for a bigger build without leaving room for a
  hostile one. `MAX_JSON_BYTES` (1 MiB) covers the release document and the manifest.
- **One reader for both.** `readBounded(res, limit, what)` reads a body under a ceiling. When the
  response has a stream — every real `fetch` response does — it reads chunk by chunk and counts as
  the bytes arrive, cancelling the reader the moment the total passes the limit, so memory stays
  flat. A double that only offers `arrayBuffer` is read in one piece and measured afterwards.
  `boundedJson()` is that reader plus `JSON.parse`, and refuses a body that is not JSON with its own
  reason.
- **The announced size is checked first.** `declaredLength()` reads `content-length` from a real
  `Headers` object or from the plain object a test double returns. A response that already says it
  is too large is refused before anything is allocated or opened.
- **The archive is written as it arrives.** `downloadTo()` opens the file `0600` and `writeSync`es
  each chunk, closing it in `finally`. Memory no longer tracks the archive size, and an endless
  body becomes a refusal with a reason instead of a full disk. The bytes on disk stop at the
  ceiling, and the caller's existing cleanup removes the partial file.

## Consequences

- A hostile or broken server can no longer exhaust memory or disk through the installer; the worst
  case is a refused download and a fallback to the system browser, which is the path a corrupt
  archive already took.
- A legitimate archive larger than 512 MiB would be refused; that is a deliberate trade, and the
  number is a single exported constant if it ever needs to move.
- Progress is unchanged for the normal case: the same file lands in
  `<data>/browsers/apostate/download`, is verified by sha256 and extracted as before.
- `test/fingerprint.test.ts` pins the declared-size refusal (no file left), an endless stream
  stopped at the ceiling, the JSON ceiling and its non-JSON reason, and a release that announces
  an 8 GiB archive falling back with an empty download folder.
