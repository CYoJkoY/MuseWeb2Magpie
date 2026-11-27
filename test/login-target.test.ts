// The sign-in window is sent to the chat page over CDP. The address comes from /json/list on the
// port the browser wrote into DevToolsActivePort; these tests pin what the engine is willing to
// connect to when that answer is not the browser's own.
import { test } from "node:test"
import assert from "node:assert/strict"
import { chatTarget } from "../engine/login.ts"

const site = "https://muse.ai"
const page = (url: string, ws: string, type = "page") => ({ type, url, webSocketDebuggerUrl: ws })
const mine = (id: string, url = site) => page(url, `ws://127.0.0.1:9333/devtools/page/${id}`)

test("the sign-in window's own tab is the one navigated", () => {
  const list = [
    page("chrome://newtab/", "ws://127.0.0.1:9333/devtools/page/NEW"),
    mine("SITE"),
  ]
  assert.equal(chatTarget(list, 9333, site), "ws://127.0.0.1:9333/devtools/page/SITE")
})

test("a window with one page is used even when the site has not loaded yet", () => {
  const list = [page("about:blank", "ws://127.0.0.1:9333/devtools/page/ONE")]
  assert.equal(chatTarget(list, 9333, site), "ws://127.0.0.1:9333/devtools/page/ONE")
})

test("a page served by another listener is refused, not navigated", () => {
  // The browser that owned 9333 is gone; whatever holds the port now answers with its own socket.
  const list = [page(site, "ws://127.0.0.1:9334/devtools/page/OTHER")]
  assert.equal(chatTarget(list, 9333, site), null)
  assert.equal(chatTarget([page(site, "ws://10.0.0.5:9333/devtools/page/LAN")], 9333, site), null)
  // A page path is not the browser endpoint, and plain http is not a debugger address.
  assert.equal(chatTarget([page(site, "ws://127.0.0.1:9333/devtools/browser/B")], 9333, site), null)
  assert.equal(chatTarget([page(site, "http://127.0.0.1:9333/devtools/page/P")], 9333, site), null)
  assert.equal(chatTarget([page(site, "not a url")], 9333, site), null)
  assert.equal(chatTarget([page(site, undefined)], 9333, site), null)
})

test("targets that are not pages are skipped", () => {
  const list = [
    page("https://muse.ai/sw.js", "ws://127.0.0.1:9333/devtools/page/SW", "service_worker"),
    mine("REAL"),
  ]
  assert.equal(chatTarget(list, 9333, site), "ws://127.0.0.1:9333/devtools/page/REAL")
})

test("an answer that is not a list of pages sends nothing", () => {
  assert.equal(chatTarget(null, 9333, site), null)
  assert.equal(chatTarget({}, 9333, site), null)
  assert.equal(chatTarget("[]", 9333, site), null)
  assert.equal(chatTarget([], 9333, site), null)
  assert.equal(chatTarget([null, 7, "page"], 9333, site), null)
})

test("the site's own tab wins over a page that only validates", () => {
  const list = [
    page("https://example.com/", "ws://127.0.0.1:9333/devtools/page/OTHER_SITE"),
    mine("MUSE"),
  ]
  assert.equal(chatTarget(list, 9333, site), "ws://127.0.0.1:9333/devtools/page/MUSE")
})
