# ADR 0009: A typed browser path must be an absolute path to a regular file

## Status

Accepted for the release after `0.11.0` (see `CHANGELOG.md`, "未发布").

## Context

The sign-in choices are built from browsers the engine finds itself, so until the manual
entry existed, every path the engine launched came from its own scan or from an environment
variable an operator set. The manual entry changed that: a person can now type any path into a
text box, and the engine will pass it to `spawn`. That makes the typed path the one place where a
string from a human decides which executable runs.

The check that existed was `existsSync`. It answered "is there something at this path", which is
the wrong question in two ways.

First, it accepted a relative path. A relative path is resolved against the engine's working
directory, which is a detail of how the engine was started, not something the person typing
`chrome.exe` can see. Depending on where it landed it either failed for no visible reason, or
started a program that happened to share the name — not the browser anyone pointed at.

Second, it accepted a directory or a device. Those exist, so `existsSync` was happy, and the
failure arrived later, inside the launch, as "the browser would not start" — a message about the
browser rather than about the path.

## Decision

- **One predicate, both callers.** `engine/browser.ts` exports `browserPathProblem(file)`: null
  when the path can be launched, otherwise a sentence saying why not. The plugin
  (`index.ts`, `browserLogin()`) calls it before it asks the engine to start a sign-in, so the
  answer is immediate and appears where the path was typed. The engine
  (`engine/login.ts`, `Logins.start()`) calls the same function before it spawns, because the
  engine is what actually launches the executable and must not depend on a caller having checked.
- **Absolute, and a regular file.** `path.isAbsolute`, then `statSync`, then `info.isFile()`.
  An absolute path is the only kind whose meaning the person can predict; a regular file is the
  only kind `spawn` can run. A missing path keeps its own message ("不存在") because that is the
  common typo and deserves its own wording.
- **Quotes are trimmed, a lone quote is not.** People paste paths with surrounding quotes often
  enough that rejecting them would be pedantic, so `normalizeBrowserPath()` strips whitespace and
  a matching pair of `"` or `'`. An unbalanced quote is left exactly as typed and fails the
  existence check, which is honest: it is not a path anyone meant.
- **The engine's answer is a run state, not a crash.** On failure `Logins.start()` marks the run
  failed with the message and returns the id, so the sign-in window shows the reason instead of
  reporting a browser that would not open.

## Consequences

- A typed relative path, directory or device can no longer reach `spawn`; the message names the
  path and the reason.
- The plugin and the engine agree by construction: same function, same wording, and the engine
  check stands even when a caller other than the plugin starts a sign-in over HTTP.
- A path that is a symlink to a regular file passes, because `statSync` follows links. That is
  intended: the file that would be executed is the real one, and portable-browser installs
  commonly use links.
- Windows paths are only judged as absolute on Windows. On POSIX `C:\…` is a relative name, and
  the test that pins the Windows shape is skipped elsewhere rather than pretending otherwise.
- `test/browser-path.test.ts` pins normalization, each rejection message and the Windows case;
  `contract.test.ts` asserts the same refusals over the real engine's `/v1/login` path.

## Amendment: the configured path follows the same rule

`MUSE_WEB_CHROME` was left behind by the original decision. It is the same promise as a typed
path — it names the executable the engine will spawn — but `findBrowser()` only asked
`existsSync`, so `MUSE_WEB_CHROME=chrome.exe` resolved against the engine's own working
directory. That is the exact hole this ADR closed for the manual entry: either a failure nobody
can explain, or a different program than the one that was meant. `browserOptions()` had the same
shape, so a configured value that would not launch was still offered as a sign-in choice.

- `findBrowser()` and `browserOptions()` now run the configured value through
  `normalizeBrowserPath()` and `browserPathProblem()`, the same predicate the prompt and
  `Logins.start()` use.
- A value that fails the rule is treated as no answer at all, not as a reason to scan: a stale
  setting is reported rather than silently overridden by whichever browser happens to be
  installed. `engine/driver.ts` logs the reason once at startup, so a browser that does not start
  is explainable from `engine.log`.
- `browserPathProblem()` takes the platform and `stat` as parameters, defaulting to the host, so
  the Windows shape can be judged on a Windows engine and the tests can supply their own file
  table. The rule itself is unchanged.
