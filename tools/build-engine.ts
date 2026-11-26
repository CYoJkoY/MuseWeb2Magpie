import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const goos = process.env.GOOS || ({ win32: "windows", darwin: "darwin", linux: "linux" } as Record<string, string>)[process.platform] || process.platform
const goarch = process.env.GOARCH || ({ x64: "amd64", arm64: "arm64", arm: "arm", ia32: "386" } as Record<string, string>)[process.arch] || process.arch
const suffix = goos === "windows" ? ".exe" : ""
const output = path.join(root, "engine-go", "bin", `${goos}-${goarch}`, `muse-web-engine${suffix}`)

mkdirSync(path.dirname(output), { recursive: true })
execFileSync(process.env.GO || "go", ["build", "-trimpath", "-ldflags=-s -w", "-o", output, "."], {
  cwd: path.join(root, "engine-go"),
  stdio: "inherit",
  env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
})
console.log(`built ${output}`)
