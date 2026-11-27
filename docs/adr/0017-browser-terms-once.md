# ADR 0017: Accept Wayfern terms once before retrying a browser start

## Status

Accepted

## Context

The Wayfern kernel shipped with Donut Browser exits before opening DevTools on its first run. Its
stderr tells the user to run `--accept-terms-and-conditions`, so the plugin's normal browser start
reports an exit code 1 and the sign-in never reaches a browser window.

The engine already owns the executable path and starts it directly. It can therefore perform the
one-time acknowledgement itself, while still leaving an explicit opt-out for people who want to
make that decision manually.

## Decision

When a browser start exits and its complete stderr contains `--accept-terms-and-conditions`, the
engine runs that executable once with exactly that flag, using `spawnSync()` without a shell. If it
exits successfully, the engine retries the normal start once. `MUSE_WEB_ACCEPT_TERMS=0`, `off`,
`no`, or `false` disables this behavior. A failed acknowledgement reports the executable path and
the exact command needed to continue.

The full stderr is attached to the start error because the existing human-facing tail keeps only
the last three lines, while the Wayfern message spans three lines and may be followed by more
diagnostics. The acknowledgement does not receive the browser profile, proxy, URL, or account
data; it only receives the executable and the fixed flag.

## Consequences

- A new Donut Browser installation can reach the login window without manual shell work.
- The engine makes at most one acknowledgement attempt and one normal retry.
- People who require manual acceptance can set `MUSE_WEB_ACCEPT_TERMS=0` and receive an actionable
  error.
- The shell-script integration test runs on POSIX hosts; Windows runs the platform-independent
  recognition and error tests.
