// muse.ai can cut an account's Muse workspace loose on its own side: the page then shows a
// 「Muse已解除关联」 screen with no composer, and the VM is DISABLED and refuses to wake. These
// tests cover the two places that decision is read without a browser — the session/wake exchange
// over HTTP, and the failure code the gateway maps to. The page-side detection is exercised by the
// driver tests through the fake muse.ai.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { AccountUnlinkedError, renewSession, unlinkedProblem } from "../engine/muse.ts"
import { generationCode } from "../engine/server.ts"

// A fetch stand-in whose /api/session answer and /api/hatch/vm/wake status are set per test.
function fakeSite(session: any, wakeStatus: number) {
  const calls: string[] = []
  const fetchImpl = async (url: string) => {
    calls.push(url)
    if (String(url).endsWith("/api/session")) {
      return { status: 200, headers: { getSetCookie: () => [] }, json: async () => session }
    }
    if (String(url).endsWith("/api/hatch/vm/wake")) {
      return { status: wakeStatus, headers: { getSetCookie: () => [] }, json: async () => ({}) }
    }
    throw new Error(`unexpected ${url}`)
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls }
}

describe("the unlinked workspace", () => {
  test("the message names the screen and what only a person can do", () => {
    const said = unlinkedProblem("DISABLED")
    assert.match(said, /提交工单/)
    assert.match(said, /DISABLED/)
    // Without a state it still explains itself rather than naming an empty VM state.
    assert.doesNotMatch(unlinkedProblem(""), /VM 状态/)
  })

  test("a DISABLED workspace whose wake is refused is reported as unlinked, not as a session error", async () => {
    const { fetchImpl, calls } = fakeSite({ status: "assigned", vm_id: "vm-1", vm_state: "DISABLED" }, 409)
    await assert.rejects(
      renewSession("https://muse.ai", { hatch_sess: "s" }, {}, { fetchImpl }),
      (err: any) => {
        assert.ok(err instanceof AccountUnlinkedError, "expected AccountUnlinkedError")
        assert.match(err.message, /解除关联/)
        // The rotated cookies ride along so the caller can still save them.
        assert.equal((err as any).cookies.hatch_sess, "s")
        return true
      },
    )
    assert.ok(calls.some((u) => u.endsWith("/api/hatch/vm/wake")), "the wake was attempted")
  })

  test("a DISABLED workspace that still wakes is not declared unlinked", async () => {
    const { fetchImpl } = fakeSite({ status: "assigned", vm_id: "vm-1", vm_state: "DISABLED" }, 200)
    const r = await renewSession("https://muse.ai", { hatch_sess: "s" }, {}, { fetchImpl })
    assert.equal(r.vm, "vm-1")
    assert.equal(r.vmState, "DISABLED")
  })

  test("a refused wake on a workspace that is not DISABLED is a plain session, not unlinked", async () => {
    const { fetchImpl } = fakeSite({ status: "assigned", vm_id: "vm-1", vm_state: "STOPPED" }, 409)
    const r = await renewSession("https://muse.ai", { hatch_sess: "s" }, {}, { fetchImpl })
    assert.equal(r.vm, "vm-1")
  })

  test("the gateway maps the unlinked account to its own code and a long retry", () => {
    // The words the page actually shows, and the message this module builds around them.
    assert.deepEqual(generationCode("Muse已解除关联"), ["account_unlinked", 3600])
    assert.deepEqual(generationCode(unlinkedProblem("DISABLED")), ["account_unlinked", 3600])
    assert.deepEqual(generationCode("the workspace was unlinked"), ["account_unlinked", 3600])
  })
})
