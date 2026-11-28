# ADR 0018: Run the page in a browser that can be driven

## Status

Accepted

## Context

A sign-in that finished in Donut Browser's Wayfern kernel left the progress page stuck on "已领到
会话，正在发一条测试消息确认账号能回答", and the saved account then disappeared. The cookies were
read correctly and `/api/session` accepted them, so the session itself was fine.

Connecting to that browser's debugging port showed why. The kernel opens a window and serves CDP,
and it answers `Runtime.enable`, `Page.enable`, `Storage.getCookies` and `Target.*`. It refuses
`Runtime.evaluate`:

```
Runtime.evaluate: Browser automation requires a paid Donut Browser plan.
```

Every page operation in this engine is a `Runtime.evaluate` call, so the chat page could never
become ready. The sign-in window only reads cookies and navigates — it never evaluates page
script — so it looked like a success. The failure surfaced later as `openTab()`'s 30-second
`readyBy()` timeout, three times over, and the message said only "muse.ai 页面加载超时（没出现聊天
输入框）". The engine treats that as a bad account and deletes it, even though the sign-in worked.

## Decision

Ask a just-started browser whether it will run page script, and treat the answer as a capability of
the browser rather than of the account.

- `engine/browser.ts` gains `AUTOMATION_REFUSED` / `automationRefused()` (the kernel's own wording
  is the only proof this is a licence limit, not a broken install), `pageRefusal()` (one
  `Runtime.evaluate`; an empty answer means "drivable", and any other error is also "drivable", so a
  page still loading is never mistaken for a refusal), and `launchRefusal()` (find the launched
  browser's first page target on its own port and probe it).
- `engine/muse.ts` probes after each launch. A refusing browser is closed at once, recorded, and
  replaced by `this.executable` — the system browser `findBrowser()` chose, which the driver passes
  in. If there is no other browser, or it refuses too, the error names the fix: install Chrome, Edge
  or Chromium, or set `MUSE_WEB_CHROME`. Refusals are remembered in memory (`Muse.refused`), so a
  restart goes straight to the spare instead of paying the refused kernel's timeouts again.
- `engine/driver.ts` remembers the refusal and answers the *sign-in window* with the system browser
  too, instead of opening a window a person can sign into but the engine can never drive.
- A finished sign-in is no longer discarded because a test message failed. The cookies came from
  muse.ai and `/api/session` accepted them, so only `AuthError` (muse.ai saying the session is
  gone) removes the account. Any other failure keeps it and returns a warning, which the progress
  page shows: signed in and saved, but not yet confirmed, and the first conversation tries again.

## Consequences

- Signing in with the free Wayfern kernel now ends in an account that actually works, on the system
  browser; the fingerprint persona is lost for that account, which is the honest trade — an account
  that cannot be driven is worth less than one without a persona.
- A machine with only a browser that refuses automation gets one actionable sentence instead of a
  two-minute "page load timeout".
- The probe is one extra `Runtime.evaluate` per browser start (once per engine lifetime on a healthy
  machine); it runs before any account work, so nothing downstream sees an undrivable page.
- A sign-in that saved but could not be confirmed is reported, not hidden: the progress page says
  so, and the row exists so the first message can retry.
- Tests: `test/browser-refusal.test.ts`, covering the recognition, the three `pageRefusal()` answers,
  the fallback in `Muse.start()` with an injected launch, and the progress-page warning.
