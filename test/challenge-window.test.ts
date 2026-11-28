// muse.ai can put a verification wall in front of the sign-in instead of the form. Only the person
// sitting at that window can pass it, so the run must read it as such and leave the window alone.
// These tests hold that reading and the words the run shows while it waits.
import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { screenChallenged } from "../engine/login.ts"

describe("the verification wall in the sign-in window", () => {
  test("each way muse.ai and its challenge vendors word the wall is recognised", () => {
    for (const text of [
      "Verify you are human\nmuse.ai needs to review the security of your connection",
      "Just a moment...",
      "Checking your browser before accessing muse.ai",
      "Please complete the security check to access muse.ai",
      "请完成验证",
      "人机验证",
      "安全验证",
      "确认您是真人",
    ]) {
      assert.equal(screenChallenged({ text, composer: false }), true, text)
    }
  })

  test("a visible challenge widget counts even when the page says nothing", () => {
    // The DOM half of the reading: the SCREEN_JS probe reports the widget itself, holding no text
    // of its own because it is an iframe.
    assert.equal(screenChallenged({ text: "", composer: false, challenge: true }), true)
  })

  test("a composer wins over everything: an account that can take a message is usable", () => {
    assert.equal(screenChallenged({ text: "Verify you are human", composer: true }), false)
    assert.equal(screenChallenged({ text: "请完成验证", composer: true, challenge: true }), false)
  })

  test("a page still painting, or an empty one, is not the wall", () => {
    assert.equal(screenChallenged({ text: "", composer: false }), false)
    assert.equal(screenChallenged({ text: "  \n  \n如需再次使用 Muse\n", composer: false }), false)
    assert.equal(screenChallenged({ text: "Muse已解除关联\n提交工单", composer: false }), false)
  })
})
