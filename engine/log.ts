// engine.log is a tail for diagnosis, and its one rule is that every record is one line. A request
// path arrives percent-decoded, so a path can carry a "\n"; an error text from a proxy or a page
// can carry anything at all. Without the rule below, an unauthenticated request could append a
// record of its own — a line reading "200 GET /v1/accounts account=muse-…" that never happened —
// and whoever reads the log could not tell it from a real one.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import path from "node:path"

export const ENGINE_NAME = "muse-web"
export const MODEL_NAME = "muse-spark"

// engine.log is rolled over once when it passes this size; it is a tail, not an archive.
export const LOG_LIMIT = 5 << 20
// Bounds one record. Browser and driver messages can be long; a single record never needs more.
export const LOG_LINE_LIMIT = 2048
// Bounds how much of a child's message is held before its newline arrives. A child that keeps
// writing without one would otherwise grow that buffer for as long as it runs.
export const MAX_DRIVER_LINE = 64 << 10

export function timeString(now = new Date()): string {
  return now.toTimeString().slice(0, 8)
}

// The shape JSON clients expect from a millisecond timestamp.
export function isoMillis(ms: number): string {
  return new Date(ms).toISOString()
}

export function oneLine(text: string): string {
  let out = ""
  let bytes = 0
  for (const ch of text) {
    // The limit is counted in bytes, because the file is bytes: a rune may be three of them.
    if (bytes >= LOG_LINE_LIMIT) {
      out += "..."
      break
    }
    const code = ch.codePointAt(0) as number
    let next = ch
    // A tab would still be one line, but it moves the columns a reader aligns on. \r and \n are
    // what a forged record needs; the rest of C0 and DEL are what a terminal escape sequence
    // starts with. The line separators JSON and JavaScript also count as newlines.
    if (ch === "\t" || code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) next = " "
    out += next
    bytes += Buffer.byteLength(next)
  }
  return out
}

export type LogSink = { write(chunk: string): unknown }

// Writes to the terminal and to engine.log, rolling the file over once past its limit.
export class Logger {
  file: string
  out: LogSink | null

  constructor(dir: string, out: LogSink | null = null) {
    this.file = dir ? path.join(dir, "engine.log") : ""
    this.out = out
  }

  log(message: string): void {
    // Every record goes through oneLine here, so the rule holds for request lines, driver messages
    // and a child process's stderr alike — there is no other path into the file.
    const line = oneLine(message)
    if (this.out) {
      try {
        this.out.write(line + "\n")
      } catch {}
    }
    if (!this.file) return
    try {
      if (statSync(this.file).size > LOG_LIMIT) renameSync(this.file, this.file + ".1")
    } catch {}
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      appendFileSync(this.file, line + "\n", { mode: 0o600 })
    } catch {}
  }
}

// Turns a child process's stderr into log lines of their own.
export class LineWriter {
  private log: Logger
  private buf: Buffer = Buffer.alloc(0)

  constructor(log: Logger) {
    this.log = log
  }

  write(chunk: Buffer): number {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      const at = this.buf.indexOf(0x0a)
      if (at < 0) break
      const line = this.buf.subarray(0, at).toString("utf8").replace(/\r+$/, "")
      this.buf = this.buf.subarray(at + 1)
      if (line !== "") this.log.log(line)
    }
    // A child that writes without ever sending a newline would otherwise grow this buffer for as
    // long as it runs. The partial line is worthless for diagnosis, so it is dropped, not kept.
    if (this.buf.length > MAX_DRIVER_LINE) {
      this.log.log(`${timeString()} driver: dropped ${this.buf.length} bytes of an unfinished line`)
      this.buf = Buffer.alloc(0)
    }
    return chunk.length
  }
}
