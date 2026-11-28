# ADR 0020: Hand the unlinked screen to a person, in the window that can fix it

## Status

Accepted

## Context

0.12.8 taught the engine to recognise the 「Muse已解除关联」 screen and name it in chat, warm and the
driver (ADR 0019). Sign-in, however, still ended on a message nobody could act on:

```
browser: …不允许自动化…改用系统中的 Chromium
cookies account=muse-761877fc49ef (8)
verify account=muse-761877fc49ef failed reason=找不到聊天输入框
```

`/api/session` keeps answering `200` for a workspace muse.ai has already unlinked, so once the
essential cookies are there the sign-in loop considers the browser finished with: it closed the
window, then let `onDone` verify the account in a headless browser, where only the unlinked screen
could appear. The one window in which the account could be re-linked was therefore the one the
engine closed — and the account screen offers exactly one way back, the 「提交工单」 button, which
opens an in-site 「提交反馈」 form (contact, topic 「账户访问与登录」, description, screenshot). There
is no external URL to hand out and no API that re-links a workspace.

## Decision

Read the sign-in window before closing it, and keep it open when only a person can act.

1. `Logins.launch()` reaches the window through the port it wrote (`/json/list` + CDP, the same
   `chatTarget` rules as everywhere else) and reads `document.body.innerText` plus whether a
   composer exists (`SCREEN_JS`), polling up to `screenMs` (15 s) and stopping at the first of two
   answers: a composer, or the unlinked screen.
2. `screenNeedsPerson()` is `!composer && UNLINKED` — the same rule `poll()` uses, so a page that is
   still painting, or one that has not decided yet, is waited out and then treated exactly as
   before this change.
3. When the screen needs a person, `hold()` marks the run `failed` with `handOffProblem()`: it names
   the window still on screen, the 「提交工单」 button in it, the 「提交反馈」 form and its topic, and
   says the window stays until it is closed or the engine stops. Nothing is closed and the temp
   profile is kept, because the form needs it. Closing the window by hand, or `stop`, still cleans
   up as before.
4. When the unlinked screen only shows up later, in the test message, the `AccountUnlinkedError`
   message gains one sentence: sign in again, the window will stop on that page, and the ticket can
   be filed there.
5. A composer still means a usable account: the window is closed and verified exactly as in 0.12.8,
   so a healthy sign-in pays one page read (typically well under a second) and nothing else.

## Consequences

- The instruction a person is given can be carried out: it refers to a window that is still there,
  with the button on it. Before, the same instruction pointed at a window the engine had closed.
- Sign-in still never deletes an account for this reason, and never retries a state that cannot
  change.
- A wrong guess costs one extra page read and at most `screenMs`, and only when the window has
  finished its part; headless logins (tests, `MUSE_WEB_HEADLESS`) skip the read entirely.
- A held run keeps a browser process and a temp profile alive until the person closes the window
  or stops the engine. This is deliberate — the form lives there — and is stated on the progress
  page rather than left implicit.
- Residual: the verifier still cannot re-link an account by itself. muse.ai decides that, and the
  ticket is theirs to answer.
