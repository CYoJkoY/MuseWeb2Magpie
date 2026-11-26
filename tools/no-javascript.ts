import { execFileSync } from "node:child_process"

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
const files = `${tracked}\0${untracked}`
  .split("\0")
  .filter((file) => /\.(?:cjs|js|mjs|jsx)$/i.test(file) && !file.startsWith("node_modules/") && !file.includes("/bin/"))

if (files.length) {
  console.error(`JavaScript source files are not allowed:\n${files.join("\n")}`)
  process.exitCode = 1
}
