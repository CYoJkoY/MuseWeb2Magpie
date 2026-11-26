// The progress page a person who did not run the engine sees in a browser. It reads the login
// runner's own state: green when the sign-in saved, red when it failed, amber while waiting.
package main

import (
	"bytes"
	"encoding/json"
	"html/template"
)

type loginState struct {
	Status string
	Step   string
	Note   string
	Error  string
}

// loginPage renders the shared sign-in progress page. All of state's dynamic text goes through
// template escaping, so an error from a browser or proxy cannot inject markup.
func loginPage(raw json.RawMessage) string {
	var state *loginState
	_ = json.Unmarshal(raw, &state)
	done := state != nil && state.Status == "done"
	failed := state == nil || state.Status == "failed"
	title := "请到另一个浏览器窗口登录 muse.ai"
	note := ""
	switch {
	case done:
		title = "登录完成"
		note = "可以关掉这个页面，回到 Magpie。"
	case failed:
		title = "登录没有完成"
		note = "找不到这次登录，请回到 Magpie 重新发起。"
		if state != nil && state.Error != "" {
			note = state.Error
		}
	default:
		note = "这个页面只显示进度，这里不能登录。请在引擎另外打开的开源指纹浏览器 Apostate（或 Chrome、Edge、Chromium、Brave）窗口里完成登录。" + state.Step
		if state.Note != "" {
			note += "（上一次出错：" + state.Note + "）"
		}
		note += "。登录成功后那个窗口会自动关闭，这个页面也会更新。"
	}
	color := "#f59f00"
	refresh := false
	if done {
		color = "#2f9e44"
	} else if failed {
		color = "#e03131"
	} else {
		refresh = true
	}
	page := template.Must(template.New("login").Parse(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>muse-web 登录</title>
{{if .Refresh}}<meta http-equiv="refresh" content="2">{{end}}<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:30rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}
p{margin:0;opacity:.75}
.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;margin-right:.5rem;vertical-align:middle;background:{{.Color}}}
</style></head><body><main><h1><span class="dot"></span>{{.Title}}</h1><p>{{.Note}}</p></main></body></html>`))
	var rendered bytes.Buffer
	_ = page.Execute(&rendered, struct {
		Refresh     bool
		Color       template.CSS
		Title, Note string
	}{refresh, template.CSS(color), title, note})
	return rendered.String()
}
