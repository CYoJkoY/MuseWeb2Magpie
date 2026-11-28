// A workspace muse.ai has unlinked still answers /api/session, so a sign-in can look finished while
// the page it would open is the 「Muse已解除关联」 screen. These tests hold the two decisions that
// keep that from closing the only window in which the 提交工单 form exists.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { handOffProblem, screenNeedsPerson } from "../engine/login.ts"

describe("the unlinked screen in the sign-in window", () => {
  test("a window showing the screen with no composer is handed to the person", () => {
    const zh = "Muse已解除关联\n为保护你的信息，我们已解除关联Muse。请提交反馈工单来重新关联。\n提交工单"
    assert.equal(screenNeedsPerson({ text: zh, composer: false }), true)
    // The English build says it in its own words.
    assert.equal(screenNeedsPerson({ text: "This workspace was unlinked", composer: false }), true)
  })

  test("a window with a composer is a usable account, whatever else it says", () => {
    assert.equal(screenNeedsPerson({ text: "Muse已解除关联", composer: true }), false)
  })

  test("a page that has not decided yet is not the screen", () => {
    // The 5 s snapshot of a real load: the shell painting, no composer, nothing that says unlinked.
    assert.equal(screenNeedsPerson({ text: "  \n  \n  \n如需再次使用 Muse\n", composer: false }), false)
    assert.equal(screenNeedsPerson({ text: "", composer: false }), false)
  })

  test("the message names the window, the button and the form only that window has", () => {
    const said = handOffProblem()
    assert.match(said, /Muse已解除关联/)
    assert.match(said, /提交工单/)
    assert.match(said, /提交反馈/)
    assert.match(said, /登录窗口/)
    assert.match(said, /关掉它/)
    // Nothing that could be read as "wait and it will come back on its own".
    assert.doesNotMatch(said, /重试|稍后|会自动恢复/)
  })
})