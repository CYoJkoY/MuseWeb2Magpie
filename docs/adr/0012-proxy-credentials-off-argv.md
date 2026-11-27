# ADR 0012: Proxy credentials stay off the browser's command line

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

One proxy decision feeds both paths (`engine/net.ts`, `resolveProxy`): the engine's own requests and
the browser it launches. A proxy URL may carry credentials — `http://user:password@proxy:8080` —
from `MUSE_WEB_PROXY`, from `HTTPS_PROXY` and friends, or from the operating system's proxy
settings.

The browser receives that URL as `--proxy-server=<url>`. Command-line arguments are not private:
on macOS and Linux any local user can read another user's arguments with `ps`, so a proxy password
put there is readable by everyone on the machine for as long as the browser runs. Chrome itself
parses `--proxy-server` as scheme, host and port, and does not use the userinfo it is given, so the
password in that argument buys nothing.

The engine's own requests are different: Bun's `proxy` per-request option does accept credentials,
and an authenticated proxy works there today.

## Decision

- **Two views of one value.** `proxyForBrowser()` returns `scheme://host:port` — no userinfo, no
  trailing slash (Chrome rejects a path with `ERR_NO_SUPPORTED_PROXIES`). The full URL still goes
  to `proxiedFetch()`. `browserArgs()` uses the stripped form; nothing else changes.
- **A scheme Chrome cannot use is left as typed.** The predicate only rewrites URLs whose scheme
  is http, https, socks4, socks4a, socks5 or socks5h; anything else is passed through unchanged so
  the browser reports the proxy it cannot use rather than the engine silently substituting one.
- **Say it once.** The driver logs one line when the resolved proxy carries credentials, so a
  person whose proxy demands a password learns that the browser's requests do not carry it,
  instead of debugging a page that quietly fails.
- **Delete a misleading helper.** The Go binary carried `masked()`, a proxy-credential mask that no
  code called. A function that looks like a protection and is never applied is worse than none, so
  it is gone.

## Consequences

- The proxy password no longer appears in `ps` output on macOS or Linux while the browser runs.
- An authenticated proxy keeps working for the engine's own API calls; browsers behind one that
  requires authentication will show the proxy's own error, and the startup log says why.
- Behaviour for proxies without credentials is unchanged, including the trailing-slash fix for
  environment variables.
- `test/engine.test.ts` pins the stripped argument, the retained full URL for engine requests, the
  scheme pass-through and the trailing-slash handling.
