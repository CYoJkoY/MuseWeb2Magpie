// engine.log is a tail someone reads to find out what happened, so its one rule — one record per
// line — is pinned here, together with the bounds that keep a chatty child from growing a buffer
// or swallowing the file.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { LineWriter, LOG_LINE_LIMIT, Logger, MAX_DRIVER_LINE, oneLine } from "../engine/log.ts"

const tmp = (prefix: string) => mkdtempSync(path.join(os.tmpdir(), prefix))

describe("oneLine", () => {
  test("strips what a forged record needs and keeps what a reader needs", () => {
    const table: Array<[string, string]> = [
      ["plain", "500 GET /v1/health 12ms"],
      ["empty", ""],
      ["newline", "a b"],
      ["crlf", "a  b"],
      ["tab", "a b"],
      ["nul", "a b"],
      ["escape sequence", "a [2Jb"],
      ["delete", "a b"],
      ["line separator", "a b"],
      ["paragraph separator", "a b"],
      ["keeps text", "登录完成 account=muse-abc123"],
    ]
    const inputs: Record<string, string> = {
      plain: "500 GET /v1/health 12ms",
      empty: "",
      newline: "a\nb",
      crlf: "a\r\nb",
      tab: "a\tb",
      nul: "a\x00b",
      "escape sequence": "a\x1b[2Jb",
      delete: "a\x7fb",
      "line separator": "a\u2028b",
      "paragraph separator": "a\u2029b",
      "keeps text": "登录完成 account=muse-abc123",
    }
    for (const [name, want] of table) {
      assert.equal(oneLine(inputs[name]), want, name)
    }
  })

  test("bounds one record and says it was cut", () => {
    const got = oneLine("x".repeat(10 * LOG_LINE_LIMIT))
    assert.ok(Buffer.byteLength(got) <= LOG_LINE_LIMIT + 8, `oneLine kept ${Buffer.byteLength(got)} bytes`)
    assert.ok(got.endsWith("..."), "a truncated record does not say it was truncated")
  })

  test("counts bytes, so a rune is not mistaken for one", () => {
    // Three bytes per character: a limit counted in characters would keep three times the file.
    const got = oneLine("字".repeat(10 * LOG_LINE_LIMIT))
    assert.ok(Buffer.byteLength(got) <= LOG_LINE_LIMIT + 8, `oneLine kept ${Buffer.byteLength(got)} bytes`)
  })
})

describe("the driver's log writer", () => {
  test("bounds an unfinished line, drops it, and keeps the next real one", () => {
    const dir = tmp("mw-log-")
    const writer = new LineWriter(new Logger(dir, null))
    const chunk = Buffer.alloc(8 << 10, "x")
    for (let i = 0; i < 64; i++) writer.write(chunk)

    // Ends whatever partial line is still buffered, then sends a real one.
    writer.write(Buffer.from("\nbrowser: ready\n"))

    const log = readFileSync(path.join(dir, "engine.log"), "utf8")
    assert.ok(log.includes("dropped"), `log does not say the unfinished line was dropped:\n${log}`)
    const lines = log.replace(/\n+$/, "").split("\n")
    assert.equal(lines[lines.length - 1], "browser: ready", "the log lost the line that followed")
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line) <= LOG_LINE_LIMIT + 8, `record of ${Buffer.byteLength(line)} bytes exceeds the limit`)
    }
  })

  test("keeps the buffer under the driver's line limit while the child never ends a line", () => {
    const dir = tmp("mw-log-")
    const writer = new LineWriter(new Logger(dir, null))
    const chunk = Buffer.alloc(8 << 10, "x")
    for (let i = 0; i < 64; i++) {
      writer.write(chunk)
      assert.ok((writer as any).buf.length <= MAX_DRIVER_LINE, `buffer holds ${(writer as any).buf.length} bytes`)
    }
  })

  test("splits several records arriving in one chunk", () => {
    const dir = tmp("mw-log-")
    const writer = new LineWriter(new Logger(dir, null))
    writer.write(Buffer.from("one\ntwo\r\n\nthree"))
    writer.write(Buffer.from("\n"))
    const lines = readFileSync(path.join(dir, "engine.log"), "utf8").replace(/\n+$/, "").split("\n")
    assert.deepEqual(lines, ["one", "two", "three"])
  })
})
