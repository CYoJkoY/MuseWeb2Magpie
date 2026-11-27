# ADR 0011: A release file name is only ever a plain name

## Status

Accepted for `0.12.0`.

## Context

The fingerprint browser is downloaded once from a GitHub release. The release answers with a list
of assets, each carrying a `name`, and that name decided the file written under
`<data>/browsers/apostate/download`: `path.join(installRoot, "download", asset.name)`.

Everything else in that path already treats remote text with suspicion. `safeJoin()` refuses
archive entries that are absolute or carry a `..` segment, `extractZip()` logs and skips them, and
the extracted tree is swapped in from a staging directory. The download file name was the one
place where the release's own text went straight into a path. A name such as
`../../engine.key` would have written outside the install root — over a file the engine itself
trusts — before any hash check had a chance to run, and `writeFileSync` would have created the
parent directories for it.

The window is narrow (it needs a compromised or spoofed release response), but the rule that the
rest of the installer follows is the point: no remote string decides a path.

## Decision

- **One function, applied where the asset is resolved.** `releaseFileName(name, url)` keeps only
  the last path segment of the announced name, treats both `/` and `\` as separators, drops
  leading dots, and replaces anything outside `[A-Za-z0-9._+-]` with `_`. Absolute paths, drive
  letters and `..` segments cannot survive it.
- **The suffix survives.** `extractArchive()` picks the format by suffix (`.zip`, `.tar.zst`,
  `.tar.gz`), so a sanitized name keeps it; a name with nothing usable falls back to the URL's own
  last segment, and finally to the neutral `download`.
- **The pin still matches on the announced name.** The sha256 from `APOSTATE_PIN` is chosen by
  comparing the release's announced name, before sanitizing. If sanitizing changed the name, the
  pin no longer applies and the download must bring its own `.manifest.json` hash; without one the
  existing check refuses it and the engine falls back to the system Chromium. Refusing is the safe
  direction: an unverifiable browser is not installed.
- **`install.json` records the name that was actually written**, so a later diagnosis can tell a
  rewritten name from a normal one.

## Consequences

- A release that announces an ordinary name (`apostate-155.0.8059.31-windows-x64.zip`) behaves
  exactly as before — same file, same pin, same verification.
- A release that announces a climbing name installs into `download/<last segment>` or not at all;
  nothing is written outside `<data>/browsers/apostate`.
- `test/fingerprint.test.ts` pins the name matrix and runs the installer against a release that
  announces `../../apostate-windows-x64.zip`, checking that the data directory gains nothing but
  the browser tree and the seed file.
