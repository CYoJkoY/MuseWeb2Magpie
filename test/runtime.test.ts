import { test } from "node:test"
import assert from "node:assert/strict"
import { runsTypeScript, runtimeLabel } from "../engine/runtime.ts"

test("Node runs TypeScript from 22.18 on", () => {
  assert.equal(runsTypeScript({ node: "20.11.1" }), false)
  assert.equal(runsTypeScript({ node: "22.17.0" }), false)
  assert.equal(runsTypeScript({ node: "22.18.0" }), true)
  assert.equal(runsTypeScript({ node: "22.18.1" }), true)
  assert.equal(runsTypeScript({ node: "23.0.0" }), true)
  assert.equal(runsTypeScript({ node: "26.13.1" }), true)
})

test("Bun runs TypeScript whatever Node version it emulates", () => {
  // Magpie runs plugins with Bun. Bun executes .ts itself and reports an emulated Node version that
  // has nothing to do with Node's release that added the feature: 1.4.5 says node 26.3.0, and a Bun
  // that said 22.6 would still run these files. Judging it by the Node rule would refuse to start.
  assert.equal(runsTypeScript({ node: "22.6.0", bun: "1.1.0" }), true)
  assert.equal(runsTypeScript({ node: "18.0.0", bun: "1.4.5" }), true)
  assert.equal(runsTypeScript({ node: "26.3.0", bun: "1.4.5" }), true)
})

test("a runtime that reports no usable Node version does not start the engine", () => {
  assert.equal(runsTypeScript({}), false)
  assert.equal(runsTypeScript({ node: "" }), false)
  assert.equal(runsTypeScript({ node: "garbage" }), false)
})

test("the message names the runtime that actually failed", () => {
  assert.equal(runtimeLabel({ node: "26.3.0", bun: "1.4.5" }), "Bun 1.4.5")
  assert.equal(runtimeLabel({ node: "20.11.1" }), "Node 20.11.1")
})
