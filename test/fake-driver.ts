import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import readline from "node:readline"

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function textOf(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  return messages.map((message: any) => {
    if (typeof message?.content === "string") return message.content
    if (Array.isArray(message?.content)) return message.content.map((item: any) => item?.text || "").join("")
    return ""
  }).join("\n")
}

function requiredChoice(choice: any): boolean {
  return choice === "required" || Boolean(choice && typeof choice === "object" && choice.type === "function")
}

function chosenName(choice: any): string {
  return typeof choice === "object" && choice?.function?.name ? String(choice.function.name) : ""
}

function callsFor(prompt: string, params: any): any[] {
  const tools = Array.isArray(params.tools) ? params.tools : []
  if (!tools.length) return []
  const name = tools[0]?.function?.name || "shell"
  if (/BARETOOL/.test(prompt)) return [{ name, arguments: '{"command":"pwd && ls -la"}' }]
  if (/PAUSE(?:STOP)?TOOL/.test(prompt)) return [{ name, arguments: '{"command":"ls"}' }]
  if (/没有按格式调用工具/.test(prompt) || requiredChoice(params.tool_choice)) return [{ name: chosenName(params.tool_choice) || name, arguments: '{"command":"ls -la"}' }]
  if (/TOOLCALL/.test(prompt)) return [{ name, arguments: '{"command":"ls -la"}' }]
  return []
}

function answer(params: any): { text: string; calls: any[]; content?: string } {
  const prompt = textOf(params.messages)
  if (/REPLY:/.test(prompt)) return { text: prompt.match(/REPLY:([^\s]+)/)?.[1] || "", calls: [] }
  if (/IMAGE:/.test(prompt)) return { text: "生成好了，这次戴上帽子了\n\n![](https://cdn.example/penguin.png)", calls: [] }
  if (/RESTYLE:/.test(prompt)) return { text: "清单：\n苹果\n香蕉", calls: [] }
  if (/SUGGEST:/.test(prompt)) return { text: "这个项目用的是 Vitest。", calls: [] }
  // A required tool that the text pass ignores is what the real driver repairs; emulate the result.
  if (/TOOLTEXT:/.test(prompt)) {
    const calls = callsFor(prompt, params)
    return calls.length ? { text: "", calls, content: "好的，我来看一下。" } : { text: "我先用文字解释一下，不调用工具。", calls: [] }
  }
  if (/TOOLCALL|BARETOOL|PAUSETOOL|PAUSESTOP|没有按格式调用工具/.test(prompt)) {
    const calls = callsFor(prompt, params)
    return { text: calls.length ? "好的，我来看一下。" : "", calls, content: "好的，我来看一下。" }
  }
  return { text: "收到", calls: [] }
}

async function operation(message: any) {
  const params = message.params || {}
  const account = params.account || {}
  if (message.op === "chat_stream") {
    if (account.id === "expired") throw { kind: "auth", message: "session expired" }
    const prompt = textOf(params.messages)
    if (process.env.MUSE_WEB_HOME) {
      mkdirSync(process.env.MUSE_WEB_HOME, { recursive: true })
      appendFileSync(path.join(process.env.MUSE_WEB_HOME, "driver-prompts.log"), `${JSON.stringify({ messages: params.messages, tools: params.tools, tool_choice: params.tool_choice })}\n`)
    }
    if (/QUOTA:/.test(prompt)) throw { kind: "quota", message: "额度用完" }
    const delay = Number(prompt.match(/DELAY:(\d+)/)?.[1] || 0)
    if (delay) await sleep(delay)
    const result = answer(params)
    send({ id: message.id, ev: "delta", text: result.text })
    send({ id: message.id, ev: "meta", how: "fake", sent: "full", tabMs: 1, firstMs: 1 })
    send({ id: message.id, ev: "final", text: result.text, content: result.content || result.text, calls: result.calls, tools: result.calls.length ? "1→shell" : "" })
    return
  }
  if (message.op === "usage" || message.op === "read_usage") {
    send({ id: message.id, ev: "result", value: { ready: true, usage: { plan: "免费版", windows: [{ name: "每周", used: 37, resetsAt: "2026-12-01T00:00:00.000Z" }, { name: "额外额度", used: 0, display: "剩余 10 亿个词元" }] } } })
    return
  }
  if (message.op === "keep_alive") { send({ id: message.id, ev: "result", value: { vmState: "RUNNING" } }); return }
  if (message.op === "refresh") {
    if (account.id === "expired") throw { kind: "auth", message: "session expired" }
    send({ id: message.id, ev: "result", value: { cookies: { hatch_sess: "good-hatch_sess", hatch_native_auth_device: "good-hatch_native_auth_device", hatch_vml: "renewed" }, cookies_exp: { hatch_vml: Math.floor(Date.now() / 1000) + 86_400 } } })
    return
  }
  if (message.op === "state") { send({ id: message.id, ev: "result", value: { ready: true } }); return }
  if (message.op === "login_start") { send({ id: message.id, ev: "result", value: { id: "fake-login" } }); return }
  if (message.op === "login_status") { send({ id: message.id, ev: "result", value: { state: { status: "done", handle: "good-account", label: "fake 登录" } } }); return }
  send({ id: message.id, ev: "result", value: {} })
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
  let message: any
  try { message = JSON.parse(line) } catch { return }
  if (message.op === "abort") return
  operation(message).catch((error: any) => send({ id: message.id, ev: "error", kind: error.kind || "generation", message: error.message || String(error) }))
})
send({ ev: "ready", version: "test" })
