# ADR 0001: Keep the HTTP engine in Go and page automation in TypeScript

## Status

Accepted for `0.10.0`.

## Context

The plugin needs a local HTTP service for account storage, bearer-key authorization, SSE responses, login progress, refresh, usage, and parent-process shutdown. Those responsibilities do not need a browser JavaScript runtime and benefit from a small native process with fast startup and predictable concurrency.

The browser boundary is different. Muse's page is controlled through Chrome DevTools Protocol, and the existing implementation evaluates selectors, composer events, rendered reply bubbles, media, login flows, and page-specific recovery code in the browser's JavaScript context. Moving that boundary to Go would duplicate or weaken the page automation layer.

## Decision

`engine-go/` owns the loopback HTTP surface, account store, private engine key, login progress page, lifecycle supervision, and driver process supervision. `engine/driver.ts` owns browser startup, CDP calls, page evaluation, prompt construction, tool parsing, login, and Muse session state.

The two processes communicate with newline-delimited JSON over standard input and output. The Go process authenticates and validates client requests; the TypeScript driver receives only the operation payload it needs and reports deltas, results, errors, callbacks, cookies, and lifecycle events.

The package ships native engine binaries for the supported platform and architecture. Source development requires Go and Node.js `>=22.18`; normal package use does not require a separate Go installation.

## Alternatives considered

- **Keep the HTTP server in TypeScript:** simpler short term, but keeps the long-lived network and storage process tied to the host runtime and gives slower native packaging.
- **Move the browser driver to Go:** rejected because CDP transport alone does not replace the page JavaScript evaluation and browser-specific DOM recovery already required by Muse.
- **Use Zig for the whole backend:** rejected for this release because Go provides the required HTTP, process, concurrency, and cross-compilation library support with less new code and lower migration risk.

## Consequences

- HTTP and storage tests run as ordinary Go tests; the native process also has an HTTP integration suite driven by a fake TypeScript driver.
- Browser behavior remains in one TypeScript boundary, so web-page changes do not require changing the Go protocol server.
- Releases must build and package the matching native binary for each supported platform and architecture.
- The boundary is a reliability and packaging decision. It does not attempt to imitate human behavior or bypass site abuse-detection systems.
