# ADR 0019: Name the unlinked workspace instead of a timeout

## Status

Accepted

## Context

Sign-in and chat failed on one account with three different messages, none of them true: 「找不到
聊天输入框」, 「设置菜单没有打开」, and after two minutes 「等待助手首字响应超时」. `warm` reported
success (`warm … 1597ms`) on the same account. A probe that polled the page every three seconds
showed what actually happens:

- at `t+3s` the composer exists (`TEXTAREA`), the trace policy is `hatch.login`-free, and the page
  is `hydrated`;
- from about `t+6s` on it is never ready again: the composer is gone and the body reads
  「Muse已解除关联 / 为保护你的信息，我们已解除关联Muse。请提交反馈工单来重新关联。 / 提交工单」.

The client swaps the whole chat for that screen a few seconds after the first paint, without
navigating and without signing out. `/api/session` agrees: `200`, `vm_state: "DISABLED"`,
`cvm_eligibility.state: "NOT_ELIGIBLE"`, and `/api/hatch/vm/wake` answers `409`. Signing in again
does not bring it back; only pressing 「提交工单」 on muse.ai, or using another account, does.

## Decision

Read that state wherever the engine would otherwise blame the page, and say what it is.

1. `renewSession()` still asks the VM to wake when `vm_state` is `DISABLED`, and treats a `409` on
   a `DISABLED` VM as proof of an unlinked workspace, throwing `AccountUnlinkedError` (carrying the
   rotated cookies, so the caller can still save them).
2. `openTab()` waits for the composer to *stay* (`settleMs`, default 3 s) before it counts a page
   as open, so `warm` cannot succeed on a page that is about to be replaced; when it is not open, a
   body matching the unlinked screen is reported as `AccountUnlinkedError` before the sign-out and
   timeout paths.
3. `poll()` carries an `unlinked` flag (unlinked text present *and* no composer); the first-token
   and answer waits exit on it instead of running to their deadlines. `send()` and `openUsage()`
   read the same text when their element is missing.
4. The driver reports it as kind `account_unlinked` and does not retry `verify`; the gateway maps
   it to `account_unlinked` (503, `Retry-After: 3600`).

## Consequences

- A person is told the truth and the one thing only they can do, in seconds rather than after a
  120-second wait; the status card stops claiming a warming VM that will never come up.
- No account is deleted and no retry is wasted on a state that cannot change by retrying.
- A wrong guess is cheap: if the wake succeeds or the state is not `DISABLED`, nothing changes, and
  a page without the unlinked text keeps its existing messages.
- Residual: reading `/api/session` is still an unbounded `res.json()` (the site's own answer, not
  the local debugging port, which is bounded); bounding it is a separate change.
