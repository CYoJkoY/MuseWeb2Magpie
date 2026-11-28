// The progress page a person sees after opening the local login URL. It has no script and no
// external request: the engine refreshes it while the driver reports the state.

function escapeHTML(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function loginPage(raw: unknown): string {
  let state: any = null
  if (raw && typeof raw === "object") state = raw
  else if (typeof raw === "string") {
    try { state = JSON.parse(raw) } catch {}
  }
  const done = state?.status === "done"
  const failed = !state || state.status === "failed"
  let title = "请到另一个浏览器窗口登录 muse.ai"
  let note = ""
  if (done) {
    title = "登录完成"
    // A sign-in can succeed while the test message that confirms it could not be sent: the account
    // is saved either way, and the first conversation tries again, so say what is unconfirmed
    // instead of a clean "done" that hides it.
    note = state?.warning
      ? `${String(state.warning)}。可以关掉这个页面，回到 Magpie。`
      : "可以关掉这个页面，回到 Magpie。"
  } else if (failed) {
    title = "登录没有完成"
    note = state?.error || "找不到这次登录，请回到 Magpie 重新发起。"
  } else {
    note = "这个页面只显示进度，这里不能登录。请在引擎另外打开的开源指纹浏览器 Apostate（或 Chrome、Edge、Chromium、Brave）窗口里完成登录。" + String(state.step || "")
    if (state.note) note += `（上一次出错：${state.note}）`
    note += "。登录成功后那个窗口会自动关闭，这个页面也会更新。"
  }
  const color = done ? "#2f9e44" : failed ? "#e03131" : "#f59f00"
  const refresh = done || failed ? "" : '<meta http-equiv="refresh" content="2">'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>muse-web 登录</title>
${refresh}<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:30rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}
p{margin:0;opacity:.75}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.5rem;vertical-align:middle;background:${color}}
</style></head><body><main><h1><span class="dot"></span>${escapeHTML(title)}</h1><p>${escapeHTML(note)}</p></main></body></html>`
}
