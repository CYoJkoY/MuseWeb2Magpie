// The engine is TypeScript source, so it only starts on a runtime that runs TypeScript. Node does
// that from 22.18 on, where stripping type annotations stopped being opt-in; an older Node ends the
// engine at its first type-only import. Bun runs TypeScript natively and only emulates a Node
// version number for compatibility, so that number says nothing about what Bun can execute — Bun
// 1.4.5 reports node 26.3.0 today, and a Bun reporting 22.6 would still run these files.

export type Versions = { node?: string; bun?: string }

// runsTypeScript answers whether the host can load the engine's .ts entry as it is.
export function runsTypeScript(versions: Versions = process.versions): boolean {
  if (versions.bun) return true
  const [major, minor] = String(versions.node ?? "").split(".").map(Number)
  if (!Number.isFinite(major)) return false
  return major > 22 || (major === 22 && (minor || 0) >= 18)
}

// runtimeLabel names the runtime as it names itself, so a message about the engine not starting
// says which one it was instead of reporting Bun's emulated Node version as if it were Node.
export function runtimeLabel(versions: Versions = process.versions): string {
  return versions.bun ? `Bun ${versions.bun}` : `Node ${versions.node}`
}
