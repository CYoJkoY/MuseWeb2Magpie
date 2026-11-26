import { execFileSync } from "node:child_process"

const files = execFileSync("git", ["ls-files", "-z", "--", "*.js", "*.mjs"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)

if (files.length) {
  console.error(`JavaScript source files are not allowed:\n${files.join("\n")}`)
  process.exitCode = 1
}
