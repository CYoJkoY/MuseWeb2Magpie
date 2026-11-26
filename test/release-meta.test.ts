import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const tool = path.join(root, "tools", "release-meta.ts")
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

test("release notes are the changelog section of the packaged version", () => {
  const run = spawnSync(process.execPath, [tool, `v${version}`], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, new RegExp(`^## ${version.replace(/\./g, "\\.")} `))
  assert.equal(run.stdout.includes("## 0.7.0 "), false)
  assert.ok(run.stdout.trim().length > 100)
})

test("a tag that disagrees with package.json is refused", () => {
  const run = spawnSync(process.execPath, [tool, "v0.0.1"], { encoding: "utf8" })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /does not match/)
})
