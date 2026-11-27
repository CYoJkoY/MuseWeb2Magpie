# ADR 0014: What arrives is bounded, and so is what it expands to

## Status

Accepted for `0.12.0`.

## Context

ADR 0013 put a ceiling on the bytes the browser installer downloads. That bounded the *compressed*
size, which is not the same thing as the size on disk.

`extractZip()` decompressed each entry with `inflateRawSync(comp)`, `extractArchive()` expanded a
`.tar.zst` with `zstdDecompressSync(...)`, and the system `tar` ran as a subprocess with no ceiling
at all. A 512 MiB archive of zeros inflates to hundreds of gigabytes; the built-in reader would
hold every byte of that in memory before writing it, and the tar path would write it to disk until
the volume filled. The download ceiling made the bomb *cheaper to ship*, not safer to open.

## Decision

- **Two more limits, named once.** `MAX_EXTRACT_BYTES` (2 GiB) is the total a release may unpack
  to; a real Chromium build is well under one gigabyte, so there is room for a bigger build and
  none for a bomb. `MAX_ARCHIVE_ENTRIES` (100,000) bounds how many files a small archive may name.
- **The budget is spent as entries are written.** `extractZip()` keeps a running total, refuses a
  stored entry larger than what is left, and hands the remainder to `inflateRawSync` as
  `maxOutputLength`. zlib stops producing output at that point instead of after the fact, and its
  `ERR_BUFFER_TOO_LARGE` becomes the same "超过 … 上限" reason as everywhere else. A central
  directory that claims more entries than the limit is refused before the loop starts.
- **zstd gets the same treatment.** `zstdDecompressSync` accepts `maxOutputLength`, so a `.tar.zst`
  that would expand past the budget fails before the intermediate `.tar` is ever written.
- **The system tar is measured afterwards.** bsdtar has no ceiling to give it, so `treeBytes()`
  sums what a finished extraction actually produced and `extractArchive()` reports failure when it
  is over budget. The caller's existing cleanup then drops the staging directory instead of
  swapping a bomb in as the browser.

## Consequences

- A decompression bomb can no longer exhaust memory through the built-in reader, and a `.tar.zst`
  bomb is stopped before it touches the disk.
- The tar path still writes its output before the tree is measured, so a hostile archive can fill
  the volume and then be rejected. It cannot be installed, and it cannot escape the staging
  directory by size alone; a genuinely pre-emptive bound there would mean replacing bsdtar with an
  in-process reader, which is not worth the surface for an archive we already hash.
- Normal installs are unchanged: the same tree is written, `findExecutable()` picks the same
  binary, and nothing is measured differently for a real Chromium build.
- `test/fingerprint.test.ts` pins the inflate refusal with no file left behind, the entry-count
  refusal, an `extractArchive()` that rejects an oversized tree, and a `.tar.zst` refused before
  its intermediate file exists.
