# ADR 0016: One TypeScript engine instead of a Go binary

## Status

Accepted for `0.12.0`. Supersedes [ADR 0001](0001-go-http-ts-driver.md).

## Context

ADR 0001 put the loopback HTTP engine in Go so it could ship as a small static binary. In practice
that split cost more than it bought:

- **Two toolchains, two test runners.** Every release had to build six native binaries, install a
  Go toolchain in CI and in the Linux test image, and keep a separate `go test` suite beside the
  TypeScript one. A single change to the protocol touched both languages.
- **A fourth language.** The wider project is Dart (the Flutter app), Zig, and TypeScript. Go was
  the one language with no other owner, kept alive only for this engine.
- **The binary was not in the git install.** `engine-go/bin/` was git-ignored, so a plugin installed
  from source (Magpie's `magpie plugin add github:…`) had no `muse-web-engine.exe` at all and
  failed with "未找到 muse-web engine 二进制文件". The prebuilt path only worked for the npm
  tarball, which the README already says is stale.
- **Zig does not fit either.** Zig has no standard-library HTTP server, JSON codec, or SSE story
  that matches what the engine needs, so "move it to Zig" would have meant writing all of that.

Node 22.18 and later strip TypeScript type annotations by default (`--experimental-strip-types` is
on by default since 23.6 and backported), so the engine can run from `.ts` source with no build
step and no extra toolchain.

## Decision

The engine is TypeScript, under `engine/`:

- `engine/main.ts` — entry point, loopback listener, parent-process watchdog, prewarm/keepalive
  scheduling.
- `engine/server.ts` — route table, auth, SSE, error mapping, admission budgets.
- `engine/store.ts`, `engine/accounts.ts` — the private account store.
- `engine/bridge.ts` — driver supervision over NDJSON (formerly `driver.go`).
- `engine/log.ts`, `engine/login-page.ts`, `engine/redact.ts` — logging, the progress page, and
  redaction.

`engine/driver.ts` and the rest of the browser automation are unchanged. `index.ts` starts the
engine with `process.execPath` on `engine/main.ts`; `MUSE_WEB_ENGINE_BIN` still points at a
different entry when someone wants one. `engine-go/`, `tools/build-engine.ts`, and the Go CI
steps are removed.

The language set is now Dart (Flutter app) + Zig + TypeScript, with this plugin entirely TypeScript.

## Alternatives considered

- **Keep Go and commit the binary.** Fixes the reported error but keeps the fourth language and a
  committed binary that has to be rebuilt on every change.
- **Port the engine to Zig.** No stdlib HTTP/JSON/SSE; the port would be larger and less legible
  than the TypeScript it replaces, and Zig would still be a second runtime next to Node.
- **Port the engine to Dart.** Would tie the plugin to the Flutter app's toolchain and ship a Dart
  runtime with a Magpie plugin that already runs on Node.

## Consequences

- One runtime (Node) runs the engine and the driver; one test runner (`node --test`) covers both.
- No native binaries are built, packaged, or committed; the git install and the tarball install
  behave the same.
- The engine now depends on the host's Node version (`>=22.18`), which the plugin already required
  for the driver.
- Go-specific implementation notes in ADRs 0001–0012 describe the pre-`0.12.0` engine; each carries
  a note pointing here.
