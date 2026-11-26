import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const svg = readFileSync(`${root}icon.svg`)
const png = readFileSync(`${root}assets/icon.png`)
const ico = readFileSync(`${root}assets/icon.ico`)
const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"))

test("assets keep the source SVG and package a usable PNG and ICO", () => {
  assert.equal(svg.equals(readFileSync(`${root}assets/icon.svg`)), true)
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG")
  assert.equal(png.readUInt32BE(16), 512)
  assert.equal(png.readUInt32BE(20), 512)
  assert.equal(ico.readUInt16LE(0), 0)
  const images = ico.readUInt16LE(4)
  assert.ok(images >= 7, "ICO has small, medium and large sizes")
  const sizes = new Set()
  for (let i = 0; i < images; i++) sizes.add(ico.readUInt8(6 + i * 16))
  assert.equal(sizes.has(0), true, "ICO has a 256 px entry")
  assert.deepEqual(pkg.files.filter((f) => f === "assets/" || f === "icon.svg"), ["assets/", "icon.svg"])
})
