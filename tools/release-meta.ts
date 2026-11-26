import { readFileSync } from "node:fs"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const tag = String(process.argv[2] || "").trim()
const expected = `v${pkg.version}`

if (tag !== expected) {
  console.error(`tag ${tag || "(empty)"} does not match package.json version ${expected}`)
  process.exit(1)
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split(/\r?\n/)
const start = lines.findIndex((line) => /^##\s/.test(line) && line.includes(pkg.version))
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${pkg.version}`)
  process.exit(1)
}
const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line))
const section = lines.slice(start, next === -1 ? lines.length : next).join("\n").trim()

if (!section) {
  console.error(`CHANGELOG.md section for ${pkg.version} is empty`)
  process.exit(1)
}

process.stdout.write(`${section}\n`)
