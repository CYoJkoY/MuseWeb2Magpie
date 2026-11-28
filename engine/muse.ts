// Drives muse.ai's web chat for one named account at a time per page.
// The page logic is ported from muse2api's MuseEngine chat path (MIT, MUSE2API Authors):
// renew_session_http, _apply_cookies, _wait_ws_ready, reset_thread, ensure_page, _send,
// _poll_chat and chat_stream. Selectors and timings are kept as muse2api has them, except the
// first-token wait, raised from 40 s to 90 s after cold starts were measured at 30–47 s.
import { randomUUID } from "node:crypto"
import { CDP } from "./cdp.ts"
import { launchBrowser, launchRefusal } from "./browser.ts"
import { ESSENTIAL, expiryMs } from "./accounts.ts"
import { redact } from "./redact.ts"
import type { Account, Cookies, ExpiryMap, Meter, UsageCard, UsageReading } from "./types.ts"

declare const document: any

// Re-exported so the page driver, the sign-in runner and the engine keep one definition each.
export { ESSENTIAL, expiryMs }
export { redact }

// /api/session's words for a workspace that is there, and for one that is not. muse.ai used to
// say only "assigned"; current builds also report "active", "ready", a running state, or nest
// the answer under "session", so the live words are matched rather than the one old value.
const SESSION_LIVE = new Set(["assigned", "active", "ready", "provisioned", "running", "ok", "connected"])
const SESSION_BLOCKED = /unavailable|expired|error|refused|denied|forbidden|suspended|banned/

export class AuthError extends Error {}
export class GenerationError extends Error {}
// muse.ai says the account has used up its allowance: another account should answer.
export class QuotaError extends GenerationError {}
// The page refused the message as too long before it answered; retry with a smaller history.
export class PromptTooLongError extends GenerationError {}
// muse.ai cut this account's Muse workspace loose on its own side: the VM is DISABLED, refuses to
// be woken, and the site replaces the chat with a "Muse 已解除关联" screen. Signing in again does
// not bring it back, so the fix is a person's on muse.ai, not a retry.
export class AccountUnlinkedError extends GenerationError {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"

export function cookieHeader(cookies: Cookies = {}) {
  return Object.entries(cookies || {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ")
}

// Set-Cookie lines → {cookies, exp} with exp in unix seconds.
export function parseSetCookies(lines: string[] = [], now = Date.now()): { cookies: Cookies; exp: ExpiryMap } {
  const cookies: Cookies = {}
  const exp: ExpiryMap = {}
  for (const line of lines || []) {
    const [pair, ...attrs] = String(line).split(";")
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const name = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (value) cookies[name] = value
    for (const attr of attrs) {
      const [k, ...rest] = attr.split("=")
      const key = k.trim().toLowerCase()
      const v = rest.join("=").trim()
      if (key === "max-age" && /^-?\d+$/.test(v)) exp[name] = Math.floor(now / 1000) + Number(v)
      else if (key === "expires" && !(name in exp)) {
        const t = Date.parse(v)
        if (Number.isFinite(t)) exp[name] = Math.floor(t / 1000)
      }
    }
  }
  return { cookies, exp }
}

// One Storage.setCookies entry: a cookie placed under both the host and its dot-domain, which is
// what muse.ai accepts for either form. The whole list goes in one call, so creating a context or
// renewing a session costs a single CDP round trip instead of two per cookie.
export interface CookieSpec {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  expires: number
}

export function cookieSpecs(host: string, secure: boolean, cookies: Cookies = {}, expires: ExpiryMap = {}, nowMs = Date.now()): CookieSpec[] {
  const now = nowMs / 1000
  const out: CookieSpec[] = []
  for (const [name, value] of Object.entries(cookies || {})) {
    if (!value) continue
    const e = Number(expires?.[name])
    const at = Number.isFinite(e) && e > now + 3600 ? e : now + 7 * 86400
    for (const domain of [`.${host}`, host]) out.push({ name, value, domain, path: "/", secure, expires: at })
  }
  return out
}

// A readable name for the account from /api/session, when muse.ai sends one. Never a cookie.
export function labelOf(body: any): string {
  for (const src of [body, body?.user, body?.account, body?.profile]) {
    if (!src || typeof src !== "object") continue
    for (const k of ["email", "user_email", "username", "display_name", "name"]) {
      const v = src[k]
      if (typeof v === "string" && v.trim() && v.length <= 120) return v.trim()
    }
  }
  return ""
}

export async function renewSession(site: string, cookies: Cookies, expires: ExpiryMap, { fetchImpl = fetch, wakeVm = true }: { fetchImpl?: typeof fetch; wakeVm?: boolean } = {}): Promise<any> {
  let cur: Cookies = { ...(cookies || {}) }
  const exp: ExpiryMap = { ...(expires || {}) }
  const headers = {
    "user-agent": UA,
    origin: site,
    referer: `${site}/thread/new`,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    cookie: cookieHeader(cur),
  }
  let res
  try {
    res = await fetchImpl(`${site}/api/session`, { headers, redirect: "manual", signal: AbortSignal.timeout(12_000) })
  } catch (err) {
    throw new GenerationError(`/api/session 网络请求失败 (${err?.name || "Error"})；请检查网络或代理`)
  }
  // Muse may rotate session cookies on a successful response even when no workspace is assigned
  // (muse2api v1.6.11). Parse them before any status decision, so a refusal never leaves the
  // account on a revoked cookie. The error carries them so the caller can persist them.
  const set = parseSetCookies(typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [])
  cur = { ...cur, ...set.cookies }
  Object.assign(exp, set.exp)
  const failed = (err: any) => {
    err.cookies = cur
    err.cookies_exp = exp
    return err
  }
  if (res.status === 401) throw failed(new AuthError("会话认证失败 (/api/session HTTP 401)，需要重新登录"))
  if (res.status !== 200) {
    throw failed(new GenerationError(res.status === 403
      ? "/api/session HTTP 403：访问被拒绝，请检查出口地区或代理；不能据此判定登录失效"
      : `/api/session HTTP ${res.status}：上游请求未成功`))
  }
  let body
  try {
    body = await res.json()
  } catch {
    throw failed(new GenerationError("/api/session 返回的不是 JSON；会话状态未确认"))
  }
  // muse.ai answered "assigned" when this was written; newer builds also answer with the
  // session nested under "session" and use other words for a live workspace. Take any wording
  // that says a workspace is there, and keep refusing the ones that say it is not.
  const session = body?.session && typeof body.session === "object" ? body.session : {}
  const status = String(body?.status ?? session.status ?? session.state ?? "").trim().toLowerCase()
  const vmId = String(body?.vm_id || session.vm_id || "").trim()
  const vmState = String(body?.vm_state || session.vm_state || session.state || "").trim()
  if (!body || SESSION_BLOCKED.test(status) || !(SESSION_LIVE.has(status) || vmId)) {
    throw failed(new GenerationError(`/api/session 没有可用的会话（status=${status || "空"}）；请在官网检查账号状态`))
  }
  if (wakeVm && vmId) {
    // The wake is asked for even when the state says DISABLED: its refusal is the second piece of
    // proof that the workspace was unlinked rather than merely asleep, and one POST is cheaper than
    // a browser that spends a minute on a page which only ever shows 「Muse已解除关联」.
    let refused = false
    try {
      const woke = await fetchImpl(`${site}/api/hatch/vm/wake`, {
        method: "POST",
        headers: { ...headers, cookie: cookieHeader(cur), "content-type": "application/json" },
        body: JSON.stringify({ vm_id: vmId, retry_count: 0, connect_attempt_id: randomUUID() }),
        signal: AbortSignal.timeout(8000),
      })
      refused = woke.status === 409
    } catch {}
    if (refused && /^disabled$/i.test(vmState)) {
      throw failed(new AccountUnlinkedError(unlinkedProblem(vmState)))
    }
  }
  return {
    cookies: cur,
    cookies_exp: exp,
    label: labelOf(body),
    vm: vmId,
    vmState,
  }
}

// Settings → General → Usage, as the page draws it. Each meter is a progressbar whose
// aria-label names it and whose aria-valuenow is the percent used; the row beside it says when
// it resets or that it never expires, and what is left. Read by structure, not by language.
function usageOnPage(): Meter[] {
  const bars: any[] = [...document.querySelectorAll('[role="progressbar"][aria-valuenow]')]
  return bars.map((bar: any) => {
    const row = bar.parentElement
    const texts = row ? [...row.querySelectorAll('[data-slot="text"]')].map((e) => (e.innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean) : []
    return { name: bar.getAttribute("aria-label") || texts[0] || "", used: Number(bar.getAttribute("aria-valuenow")), texts }
  }).filter((m) => m.name && Number.isFinite(m.used))
}

// The settings button is the bottom one of the left rail, a menu that opens on a key press.
// The server's HTML already has it; it answers only once the page has hydrated.
function settingsButton(): boolean {
  const h = document.querySelector("[data-hatch-shell-hydration-state]")
  if (h && h.getAttribute("data-hatch-shell-hydration-state") !== "hydrated") return false
  const r = (e) => e.getBoundingClientRect()
  const rail = [...document.querySelectorAll("button, [role=button]")].filter((e) => e.offsetParent && r(e).left < 80 && r(e).width > 0)
  rail.sort((a, b) => r(b).top - r(a).top)
  if (!rail[0]) return false
  rail[0].focus()
  return true
}

// In that menu, Settings is the item with the "⌘," / "Ctrl+," shortcut, or the one labelled
// Settings / 设置 / 設定 when the shortcut is not part of the text.
export function settingsItem(): boolean {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const it = items.find((e) => /,\s*$/.test((e.innerText || "").trim())) || items.find((e) => /设置|設定|settings/i.test(e.innerText || ""))
  if (!it) return false
  it.focus()
  return true
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

// "每周限额将在 10月15日重置" / "Weekly limit resets Oct 15" → that day's local midnight, this
// year or the next; null when the line names no day.
export function resetDate(text: string, now = Date.now()): number | null {
  const s = String(text || "")
  let m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  let month, day
  if (m) [month, day] = [Number(m[1]) - 1, Number(m[2])]
  else if ((m = s.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\b/)) && MONTHS.includes(m[1].toLowerCase())) [month, day] = [MONTHS.indexOf(m[1].toLowerCase()), Number(m[2])]
  else if ((m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\b/)) && MONTHS.includes(m[2].toLowerCase())) [month, day] = [MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])]
  else return null
  const year = new Date(now).getFullYear()
  let at = new Date(year, month, day).getTime()
  if (at < now - 86_400_000) at = new Date(year + 1, month, day).getTime()
  return at
}

// The page's meters → Magpie's usage windows and plan name.
export function usageCard(meters: Meter[] = [], now = Date.now()): UsageCard {
  const windows: any[] = []
  let plan = ""
  for (const m of meters || []) {
    const [, note = "", detail = ""] = m.texts || []
    const resets = resetDate(note, now)
    const left = detail.match(/[（(]([^）)]+)[）)]/)?.[1] || ""
    const weekly = /每(?:周|週|星期)|weekly|\bweek\b/i.test(note)
    const daily = /每[日天]|daily|\bday\b/i.test(note) && !weekly
    const extra = !resets && (/额外|額外|extra|additional/i.test(m.name) || /不[过過]期|never/i.test(note))
    if (!plan && resets) plan = m.name
    windows.push({
      name: weekly ? "每周" : daily ? "每日" : extra ? "额外额度" : m.name,
      used: Math.max(0, Math.min(100, m.used)),
      ...(resets ? { resetsAt: new Date(resets).toISOString() } : {}),
      ...(left ? { display: left } : {}),
    })
  }
  return { plan, windows }
}

// The page's own words for a VM it is not connected to, in English and in its zh_CN strings.
const CONNECTING = /Connecting\.\.\.|正在连接/
const STUCK = /Still sending|仍在发送中|Connecting\.\.\.|正在连接/
// muse.ai has unlinked the account's Muse workspace and says so on the page. Its server picks this
// screen a few seconds after the composer first paints, so a page that was ready can still end up
// here: the check belongs wherever the composer is looked for, not only at load time.
// No backslash escapes: this one is also pasted into page script, where a template literal would
// eat them.
export const UNLINKED = /已解除关联|解除关联 Muse|解除关联Muse|unlinked/i
// What that screen means and what only a person can do about it.
export function unlinkedProblem(vmState = ""): string {
  const state = vmState ? `，VM 状态 ${vmState}` : ""
  return `muse.ai 已解除这个账号的 Muse 关联（页面原文「Muse已解除关联」${state}）：工作区的虚拟机停用，`
    + "重新登录也不会恢复。需要在 muse.ai 上按页面提示点「提交工单」重新关联 Muse，"
    + "关联成功后再在插件里重新登录这个账号；换一个没被解除关联的账号也能立刻继续用。"
}
// The page refused the message itself before any answer appeared.
const PROMPT_TOO_LONG = /(?:too long|message is too long|prompt is too long|exceeds? .{0,20}(?:limit|length)|maximum context|上下文.{0,10}(?:过长|太长|上限)|消息.{0,10}(?:过长|太长)|内容.{0,10}过长)/i

// The message box. muse.ai's live build draws a <textarea> (muse2api's tools/verify_engine_selectors.py
// still finds one); a rich-text build could draw a <div role="textbox"> instead, so both are
// accepted and the textarea path is tried first.
const COMPOSER_SEL = 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'
const EDITOR_SEL = '[contenteditable="true"][role="textbox"], [contenteditable="true"]'
// A conversation bubble. The live build calls it hatch-chat-groupable-bubble and marks the two
// sides hatch-agent-bubble-bg / chat-user-bubble; shorter renames and data-testid marks are also
// accepted so a restyle does not hide the whole conversation.
const BUBBLE_SEL = 'div[class*="hatch-chat-groupable-bubble"], div[class*="groupable-bubble"], [data-testid*="chat-bubble"], [data-hatch-chat-bubble]'
// The Stop control while a reply is streaming. Keep the testid search on buttons: a bare
// [data-testid*="stop"] could match a non-control elsewhere on the page.
const STOP_SEL = '[data-testid="hatch-composer-stop-button"], button[data-testid*="stop" i], button[aria-label*="Stop" i], button[aria-label*="停止"]'

const READY_JS = `(function(){
  if (document.readyState !== 'complete') return 'loading';
  var c = document.querySelector(${JSON.stringify(COMPOSER_SEL)});
  if (!c) return 'no-ta';
  if (c.tagName === 'TEXTAREA' && c.disabled) return 'input-disabled';
  // A hydration marker is not always rendered any more: only a marker that is there and says
  // something other than "hydrated" means the page is still coming up.
  var h = document.querySelector('[data-hatch-shell-hydration-state]');
  if (h && h.getAttribute('data-hatch-shell-hydration-state') !== 'hydrated') return 'hydrating';
  var b = document.body ? (document.body.innerText || '') : '';
  if (${CONNECTING}.test(b)) return 'connecting';
  return 'ready';
})()`

const STOP_JS = `(function(){
  var b = document.querySelector(${JSON.stringify(STOP_SEL)});
  if (b) b.click();
  return !!b;
})()`

const NEEDS_NAV_JS = (forChat) => `(function(forChat){
  var d = document.querySelector('[role="dialog"]');
  if (d) { var b = d.querySelector('button[aria-label*="close" i], button'); if (b) b.click(); }
  var scope = document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]') || document.body;
  var bubbleCount = scope ? scope.querySelectorAll(${JSON.stringify(BUBBLE_SEL)}).length : 0;
  var hasAtts = document.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]').length > 0;
  var hasStop = !!document.querySelector(${JSON.stringify(STOP_SEL)});
  var bodyTxt = document.body ? (document.body.innerText || '') : '';
  var hasStuck = ${STUCK}.test(bodyTxt);
  if (hasStop) return 'stop-button';
  if (hasStuck) return 'stuck';
  if (hasAtts) return 'attachments';
  if (forChat) return bubbleCount >= 24 ? 'long-thread' : '';
  return ((window.location.pathname !== '/thread/new') || bubbleCount > 0) ? 'not-new' : '';
})(${forChat ? "true" : "false"})`

const POLL_JS = `(function(){
  var scroller=document.querySelector('[class*="hatch-chat-scroll"],[class*="chat-scroll"]');
  if(scroller&&scroller.scrollHeight>scroller.clientHeight+40) scroller.scrollTop=scroller.scrollHeight;
  var scope=document.querySelector('main,[class*="chat-scroll"],[class*="hatch-chat-scroll"]')||document.body;
  // Who a bubble belongs to: the current build marks it on the class or the data-testid
  // ("…-user-…" / "…-agent-…"), and an assistant bubble also holds a .prose block. The old
  // build only had hatch-agent-bubble-bg / hatch-user-bubble-bg.
  function marks(b){return String(b.className&&b.className.baseVal!==undefined?b.className.baseVal:b.className||'')+' '+(b.getAttribute('data-testid')||'');}
  function isAgent(b){var m=marks(b);if(/user|human/i.test(m))return false;return /agent|assistant|bot/i.test(m)||!!b.querySelector('.prose');}
  var bs=[].slice.call(scope.querySelectorAll(${JSON.stringify(BUBBLE_SEL)})).filter(isAgent);
  // The reply text is .prose, so suggested-reply buttons beside it stay out. A generated picture's
  // caption can sit outside .prose; an empty prose falls back to the bubble text without buttons.
  function said(b){var p=b.querySelectorAll('.prose');
    var fromProse=(p.length?[].map.call(p,function(x){return x.innerText||'';}).join('\\n\\n'):'').trim();
    if(fromProse) return fromProse;
    var copy=b.cloneNode(true);
    copy.querySelectorAll('button,[role=button]').forEach(function(x){x.remove()});
    return (copy.innerText||'').trim();}
  function usable(src){return src && !/avatar|emoji|twemoji|favicon|icon/i.test(src)}
  function mediaOf(b){
    var out=[], seen={};
    [].slice.call(b.querySelectorAll('img,video')).forEach(function(m){
      var src=m.currentSrc||m.src||'';
      if(!usable(src)||seen[src]) return;
      var w=m.naturalWidth||m.videoWidth||0, h=m.naturalHeight||m.videoHeight||0;
      if(w && h && w<64 && h<64) return;
      seen[src]=1;
      out.push({src:src, kind:m.tagName==='VIDEO'?'video':'image', w:w, h:h});
    });
    return out;
  }
  function pendingOf(b){
    return [].slice.call(b.querySelectorAll('[data-testid^="hatch-chat-attachment-presentation-"]')).some(function(el){
      var m=el.querySelector('img,video')||(el.tagName==='IMG'||el.tagName==='VIDEO'?el:null);
      return !(m && usable(m.currentSrc||m.src||''));
    });
  }
  var last=bs.length?bs[bs.length-1]:null;
  var media=last?mediaOf(last):[];
  var pending=!!(last && pendingOf(last));
  var alive=bs.filter(function(b){return said(b).length>0 || mediaOf(b).length>0 || pendingOf(b);});
  var nonEmpty=bs.filter(function(b){return said(b).length>0;});
  var txt=nonEmpty.length?said(nonEmpty[nonEmpty.length-1]):'';
  var stop=!!document.querySelector(${JSON.stringify(STOP_SEL)});
  // muse.ai can replace the whole chat with the 「Muse已解除关联」 screen mid-answer; the composer
  // goes with it, so this is what tells the wait that no answer is coming.
  var bodyTxt=document.body?(document.body.innerText||''):'';
  var unlinked=${UNLINKED}.test(bodyTxt)&&!document.querySelector(${JSON.stringify(COMPOSER_SEL)});
  return JSON.stringify({cnt:alive.length,txt:txt,stop:stop,media:media,pending:pending,unlinked:unlinked});
})()`

// Typing into the composer. A textarea keeps its value behind a native setter that React reads;
// a contenteditable div takes the text through the selection and an input event the rich-text
// editor listens for. Returns the length the page now shows.
const SETTER_JS = (text) => `(function(t){
  var ta=document.querySelector('textarea');
  if(ta){
    ta.focus();
    var s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    s.call(ta,t);
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new Event('change',{bubbles:true}));
    return (ta.value||'').length;
  }
  var ed=document.querySelector(${JSON.stringify(EDITOR_SEL)});
  if(!ed) return 0;
  ed.focus();
  var sel=window.getSelection&&window.getSelection();
  if(sel){var r=document.createRange();r.selectNodeContents(ed);sel.removeAllRanges();sel.addRange(r);}
  var typed=false;
  try{typed=document.execCommand('insertText',false,t);}catch(e){typed=false;}
  if(!typed||!(ed.innerText||'').trim()){
    ed.textContent=t;
    try{ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:t}));}catch(e){ed.dispatchEvent(new Event('input',{bubbles:true}));}
  }
  ed.dispatchEvent(new Event('change',{bubbles:true}));
  return (ed.innerText||ed.textContent||'').length;
})(${JSON.stringify(text)})`

// The live build marks Send with data-testid="hatch-composer-send-button" and aria-label
// "Send message"; its text is just "Send". The label/testid must match whole (not a substring):
// a history item can say "Resend message" or "Send feedback", and clicking that sends nothing.
const SEND_BUTTON_JS = `(function(){
  var LABEL=/^(?:send(?:\\s+message)?|发送(?:消息)?|發送(?:訊息)?|傳送(?:訊息)?|送出)$/i;
  var TESTID=/^(?:hatch-composer-send-button|composer-send-button|composer-send|send-button)$/i;
  function visible(e){return e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden';}
  var c=document.querySelector('textarea');
  if(!c || !visible(c)){
    var eds=[].slice.call(document.querySelectorAll(${JSON.stringify(EDITOR_SEL)}));
    c=eds.find(visible);
  }
  if(!c) return 'no-ta';
  function isSend(b){
    if(!visible(b)) return false;
    // The Send button itself can carry a chat-user-bubble colour class; exclude message
    // containers and side rails, never the button by colour alone.
    if(b.closest('aside,nav,[role="navigation"],div[class*="chat-user-bubble"],div[class*="group/msg"],div[class*="hatch-chat-groupable-bubble"]')) return false;
    var l=(b.getAttribute('aria-label')||'').trim();
    var t=(b.getAttribute('data-testid')||'').trim();
    return LABEL.test(l)||TESTID.test(t)||LABEL.test((b.innerText||'').trim());
  }
  // Search the nearest composer first and stop before the page body: a history preview or a
  // feedback link outside the composer is not this message's Send.
  for(var r=c.parentElement; r && r!==document.body; r=r.parentElement){
    var b=[].slice.call(r.querySelectorAll('button,[role="button"]')).find(isSend);
    if(b) return (b.disabled||b.matches(':disabled')||b.getAttribute('aria-disabled')==='true') ? 'disabled' : (b.click(),'clicked');
    if(r.matches('form,main,[role="main"]')) break;
  }
  return 'no-button';
})()`

const SIGNED_OUT = /log in|sign in|create an account|登录|登入|use another account|hatch\.login/

// Whether the composer was cleared: the page took the message and sent it.
const COMPOSER_EMPTY_JS = `(function(){
  var ta=document.querySelector('textarea');
  if(ta) return !(ta.value||'').trim();
  var ed=document.querySelector(${JSON.stringify(EDITOR_SEL)});
  if(ed) return !((ed.innerText||ed.textContent||'').trim());
  return true;
})()`

// The page's own text outside the conversation's bubbles: what muse.ai says, not the model.
const NOTICE_JS = `(function(){
  var t = document.body ? (document.body.innerText || '') : '';
  document.querySelectorAll(${JSON.stringify(BUBBLE_SEL)}).forEach(function(b){
    var s = (b.innerText || '').trim(); if (s) t = t.split(s).join(' ');
  });
  return t.slice(-1500);
})()`
// muse.ai's own wording ("已用完使用额度" is its zh_CN string) and muse2api's list.
const QUOTA_SPENT = /已用完使用额度|额度不足|积分不足|达到上限|out of credits|usage limit|reached your (?:weekly )?limit|token limit/i
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g
// a line that is so far only a list marker, heading mark or fence: the page may restyle it away
const UNSETTLED_TAIL = /(^|\n)[ \t]*(?:[-*+>#]+|\d+[.)]|`{1,3})?[ \t]*$/

// Chat Completions has no image part here: a picture the page generated goes out as markdown,
// which is what Magpie and other clients already render. blob: URLs are converted before this.
export function mediaMarkdown(items: Array<{ kind?: string; url?: string; src?: string }> = []): string {
  return (items || []).flatMap((m) => {
    const url = String(m?.url || m?.src || "")
    if (!url) return []
    return [m.kind === "video" ? `[视频](${url})` : `![](${url})`]
  }).join("\n")
}

// The next piece of a reply to stream, given what has been sent and the bubble's text now. The
// page restyles text while it streams (a "-" becomes a list item), so a bubble that no longer
// starts with what was sent gives only what lies past their common start, and one that shrank
// gives nothing until it grows past it. final: the reply is done; nothing is held back.
export function settle(sent: string, txt: string, final = false): { delta: string; sent: string } {
  let t = txt.replace(ZERO_WIDTH, "")
  if (!final) {
    const m = t.match(UNSETTLED_TAIL)
    if (m) t = t.slice(0, m.index + m[1].length)
  }
  if (t.startsWith(sent)) return { delta: t.slice(sent.length), sent: t }
  if (t.length <= sent.length) return { delta: "", sent }
  let i = 0
  while (sent[i] === t[i]) i++
  return { delta: t.slice(i), sent: t }
}

const USAGE_RETRY_MS = 2 * 60_000
const VERIFY = "\u0000verify"
const VERIFY_PROMPT = "这是一条连通测试，请只回复：OK"

// A kernel that will not run page script is a browser this engine cannot use at all, and the
// kernel's own sentence is the only proof it is a licence limit rather than a broken install. Name
// the fix instead of leaving a person with "页面加载超时".
export function refusalProblem(executable: string, said: string): string {
  return `这个浏览器内核不允许自动化（${redact(said)}），引擎无法在它里面操作 muse.ai 页面。`
    + `请安装 Chrome、Edge 或 Chromium，或用 MUSE_WEB_CHROME 指定一个能自动化的浏览器`
    + (executable ? `（当前用的是 ${executable}）` : "")
}

export interface MuseOptions {
  site?: string
  executable?: string
  resolveExecutable?: () => Promise<any> | any
  profileDir: string
  headless?: boolean
  hidden?: boolean
  proxy?: string
  fetchImpl?: typeof fetch
  firstTokenMs?: number
  chatTimeoutMs?: number
  quietMs?: number
  shortQuietMs?: number
  stopQuietMs?: number
  loadMs?: number
  // How long the composer must keep showing before a page counts as open: muse.ai swaps in the
  // unlinked screen a few seconds after the first paint.
  settleMs?: number
  onCookies?: (id: string, cookies: Cookies, exp: ExpiryMap, vm: string) => void
  onLost?: (why: string) => void
  // Called once per browser that turns out to refuse page script, so the driver can stop choosing
  // it for the sign-in window too.
  onAutomationRefused?: (executable: string, said: string) => void
  // Which browser to start. Separated from the import so a test can watch a start without a
  // browser; the engine always uses launchBrowser.
  launch?: (options: any) => Promise<any>
  // Whether a started browser can run page script; empty means yes.
  probeAutomation?: (launched: any) => Promise<string>
}

export type ChatTiming = { how?: string; sent?: string; tabMs?: number; firstMs?: number; text?: string }

export class Muse {
  onLost: (why: string) => void
  site: string
  host: string
  executable: string | undefined
  resolveExecutable: (() => Promise<any> | any) | undefined
  opts: { profileDir: string; headless: boolean; hidden: boolean; proxy: string }
  fetchImpl: typeof fetch
  firstTokenMs: number
  chatTimeoutMs: number
  quietMs: number
  shortQuietMs: number
  stopQuietMs: number
  loadMs: number
  settleMs: number
  onCookies: (id: string, cookies: Cookies, exp: ExpiryMap, vm: string) => void
  onAutomationRefused: (executable: string, said: string) => void
  launch: (options: any) => Promise<any>
  probeAutomation: (launched: any) => Promise<string>
  // executable → the kernel's own reason. A capability of this machine, not of an account, so
  // drop() leaves it alone: a restart must not pay the refusal's timeouts again.
  refused: Map<string, string>
  accounts: Map<string, any>
  usage: Map<string, UsageReading>
  reading: Map<string, Promise<UsageReading | null> | Promise<never> | Promise<any>>
  usageFailed: Map<string, number>
  started: any

  constructor({
    site = "https://muse.ai",
    executable,
    resolveExecutable,
    profileDir,
    headless = true,
    hidden = false,
    proxy = "",
    fetchImpl = fetch,
    firstTokenMs = 90_000,
    chatTimeoutMs = 300_000,
    // A tool request can pause between its progress line and its tool call. Plain replies cannot,
    // so the long quiet applies only when the request carries tools.
    quietMs = 4_000,
    shortQuietMs = 500,
    stopQuietMs = 15_000,
    loadMs = 30_000,
    settleMs = 3_000,
    onCookies = () => {},
    onLost = () => {},
    onAutomationRefused = () => {},
    launch = launchBrowser,
    probeAutomation = (launched) => launchRefusal(launched.browser, launched.port),
  }: MuseOptions) {
    this.onLost = onLost
    this.site = site.replace(/\/+$/, "")
    this.host = new URL(this.site).hostname
    // The browser is chosen when it is first needed, not here: a fingerprint browser may still
    // have to be downloaded, and the engine must answer requests while that happens.
    this.executable = executable
    this.resolveExecutable = resolveExecutable
    this.opts = { profileDir, headless, hidden, proxy }
    this.fetchImpl = fetchImpl
    this.firstTokenMs = firstTokenMs
    this.chatTimeoutMs = chatTimeoutMs
    this.quietMs = quietMs
    this.shortQuietMs = shortQuietMs
    this.stopQuietMs = stopQuietMs
    this.loadMs = loadMs
    this.settleMs = settleMs
    this.onCookies = onCookies
    this.onAutomationRefused = onAutomationRefused
    this.launch = launch
    this.probeAutomation = probeAutomation
    this.refused = new Map()
    this.accounts = new Map()
    // account id → {at, plan, windows}; survives the browser closing, read again when it runs
    this.usage = new Map()
    this.reading = new Map()
    // account id → when its last reading failed; a VM still connecting isn't asked every poll
    this.usageFailed = new Map()
    this.started = null
  }

  usageOf(accountId) {
    return this.usage.get(accountId) || null
  }

  // Reads the account's usage in a throwaway tab of its context, once at a time. Never starts
  // the browser or a context for it: an idle account keeps the last reading.
  readUsage(account, { maxAgeMs = 0 } = {}) {
    const a = this.accounts.get(account.id)
    const had = this.usage.get(account.id)
    if (had && Date.now() - had.at < maxAgeMs) return Promise.resolve(had)
    if (!this.started || !a?.contextId) return Promise.resolve(had || null)
    if (this.reading.has(account.id)) return this.reading.get(account.id)
    if (Date.now() - (this.usageFailed.get(account.id) || 0) < USAGE_RETRY_MS) return Promise.resolve(had || null)
    const run = this.openUsage(a).then((meters) => {
      if (!meters.length) throw new GenerationError("设置页的使用情况没有加载出来（账号的虚拟机可能还在预热）")
      const got = { at: Date.now(), ...usageCard(meters) }
      this.usage.set(account.id, got)
      this.usageFailed.delete(account.id)
      return got
    }).catch((err) => {
      this.usageFailed.set(account.id, Date.now())
      throw err
    }).finally(() => this.reading.delete(account.id))
    this.reading.set(account.id, run)
    return run
  }

  async openUsage(a) {
    const { browser, port } = await this.start()
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", browserContextId: a.contextId, background: true })
    // a cold browser can take longer than 15 s to answer a navigation while it loads other tabs
    const page = await CDP.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, { timeoutMs: this.loadMs + 15_000 })
    const press = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) })
      }
    }
    const until = async (fn, ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await page.js(`(${fn})()`).catch(() => false)) return true
        await sleep(250)
      }
      return false
    }
    // The same unlinked screen that takes the composer also takes the header, so a missing
    // settings button is read in the page's own words before it is blamed on the page.
    const unlinked = async () => UNLINKED.test(String((await page.js("document.body ? document.body.innerText.slice(0,1200) : ''").catch(() => "")) || ""))
    try {
      await page.send("Page.enable")
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
      if (!(await until(settingsButton, this.loadMs))) {
        if (await unlinked()) throw new AccountUnlinkedError(unlinkedProblem(a.vmState))
        throw new GenerationError("没有找到设置按钮")
      }
      let open = false
      for (let i = 0; i < 3 && !open; i++) {
        await sleep(i ? 1000 : 600)
        await page.js(`(${settingsButton})()`).catch(() => false)
        await press()
        open = await until(settingsItem, 2500)
      }
      if (!open) {
        if (await unlinked()) throw new AccountUnlinkedError(unlinkedProblem(a.vmState))
        throw new GenerationError("设置菜单没有打开")
      }
      await press()
      // the meters come over the VM's connection: placeholders until it is up
      const shown = await until(() => document.querySelectorAll('[role="progressbar"][aria-valuenow]').length > 0, 20_000)
      return shown ? (await page.js(`(${usageOnPage})()`)) || [] : []
    } finally {
      page.close()
      await browser.send("Target.closeTarget", { targetId }).catch(() => {})
    }
  }

  // Which browser to run: a resolver may hand back a fingerprint browser it picked or just
  // installed, with that browser's own flags; without one the engine's own executable is used.
  async resolveLaunch() {
    const got = this.resolveExecutable ? await this.resolveExecutable() : null
    if (!got) return { executable: this.executable, extraArgs: [] }
    if (typeof got === "string") return { executable: got, extraArgs: [] }
    return { executable: got.executable || this.executable, extraArgs: got.extraArgs || [] }
  }

  // A browser whose connection dropped (sleep, a crash, someone quitting it) is let go with its
  // contexts and tabs, so the next request starts a new one instead of failing.
  start() {
    if (this.started) return this.started
    const started = this.resolveLaunch()
      .then(({ executable, extraArgs }) => this.open(executable, extraArgs))
      .then((b) => {
        const lost = (why) => {
          if (this.started !== started) return
          this.drop()
          this.onLost(why)
          b.close().catch(() => {})
        }
        b.browser.onClose(() => lost("connection closed"))
        b.proc.once("exit", () => lost("browser exited"))
        return b
      }, (err) => {
        if (this.started === started) this.started = null
        throw new GenerationError(`浏览器启动失败: ${err.message}`)
      })
    this.started = started
    return started
  }

  // Launches a browser and proves it will run page script before anything is asked of it. A kernel
  // that refuses (Donut Browser's Wayfern on its free plan opens a window and serves CDP but
  // rejects Runtime.evaluate) cannot be driven, and every page here needs that call; the sign-in
  // only reads cookies and navigates, so it looked fine and the refusal only surfaced later as a
  // chat page that never became ready. When the chosen browser refuses, the engine falls back to
  // the system browser once and remembers the refusal, so later starts skip it instead of waiting
  // out its timeouts again.
  async open(executable: string, extraArgs: string[]): Promise<any> {
    const spare = this.executable
    const hasSpare = Boolean(spare) && spare !== executable
    // Already refused here: do not launch it again. Without another browser there is nothing to
    // do but say why, in words that name the fix.
    if (executable && this.refused.has(executable)) {
      if (!hasSpare) throw new GenerationError(refusalProblem(executable, this.refused.get(executable) || ""))
      return this.usable(spare as string)
    }
    const first = await this.attempt(executable, extraArgs)
    if (!first.said) return first.launched
    if (executable) this.refused.set(executable, first.said)
    if (!hasSpare) throw new GenerationError(refusalProblem(executable, first.said))
    this.onAutomationRefused(executable, first.said)
    return this.usable(spare as string)
  }

  // Starts the spare browser and proves it too. A spare that also refuses is reported rather than
  // retried: two refusals in a row mean this machine has no browser this engine can drive.
  async usable(executable: string): Promise<any> {
    const known = this.refused.get(executable)
    if (known) throw new GenerationError(refusalProblem(executable, known))
    const got = await this.attempt(executable, [])
    if (!got.said) return got.launched
    this.refused.set(executable, got.said)
    throw new GenerationError(refusalProblem(executable, got.said))
  }

  // One launch, then the probe. A refusing browser is closed before returning, since falling back
  // must not leave a window that cannot be used sitting on screen.
  async attempt(executable: string, extraArgs: string[]): Promise<{ launched: any; said: string }> {
    const launched = await this.launch({ ...this.opts, executable, extraArgs, temporary: true })
    const said = await this.probeAutomation(launched)
    if (said) await launched.close().catch(() => {})
    return { launched, said }
  }

  drop() {
    for (const a of this.accounts.values()) a.home?.page.close()
    this.accounts.clear()
    this.started = null
  }

  async stop() {
    const running = await this.started?.catch(() => null)
    this.drop()
    await running?.close()
  }

  // Whether the account's page is open and connected in a running browser, and how many
  // conversations it holds threads for.
  state(accountId) {
    const a = this.accounts.get(accountId)
    const open = !!(a?.home && !a.home.page.closed)
    return { ready: !!(this.started && a?.contextId && open), tabs: a ? a.threads.size : 0 }
  }

  // account id → {contextId, home: the one chat page, threads: conversation → thread path,
  // current: the conversation the page shows, lastRenew, opening, renewing, dead}
  acct(accountId) {
    let a = this.accounts.get(accountId)
    if (!a) {
      a = { contextId: null, home: null, threads: new Map(), current: null, lastRenew: 0, opening: null }
      this.accounts.set(accountId, a)
    }
    return a
  }

  async closeHome(a) {
    const h = a.home
    a.home = null
    a.current = null
    if (!h) return
    h.page.close()
    const { browser } = await this.start()
    await browser.send("Target.closeTarget", { targetId: h.targetId }).catch(() => {})
  }

  // Drops the account's whole browser context: its cookies, storage and its page.
  async closeAccount(accountId) {
    const a = this.accounts.get(accountId)
    if (!a) return
    await this.closeHome(a)
    a.threads.clear()
    if (a.contextId) {
      const { browser } = await this.start()
      await browser.send("Target.disposeBrowserContext", { browserContextId: a.contextId }).catch(() => {})
    }
    a.contextId = null
  }

  // Forgets one conversation's thread: its next message starts a new thread with the whole history.
  async closeTab(accountId, key = "") {
    const a = this.accounts.get(accountId)
    if (!a) return
    a.threads.delete(key)
    if (a.current === key) a.current = null
  }

  async setCookies(browser, contextId, cookies, expires) {
    const specs = cookieSpecs(this.host, this.site.startsWith("https:"), cookies, expires)
    if (!specs.length) return
    // One call places every cookie. If the browser refuses the batch, place them one by one so a
    // single malformed cookie does not cost the whole sign-in.
    const rejected = await browser.send("Storage.setCookies", { browserContextId: contextId, cookies: specs }).then(() => false, () => true)
    if (!rejected) return
    for (const spec of specs) {
      await browser.send("Storage.setCookies", { browserContextId: contextId, cookies: [spec] }).catch(() => {})
    }
  }

  async waitReady(page, ms) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if ((await page.js(READY_JS).catch(() => "")) === "ready") return true
      await sleep(80)
    }
    return false
  }

  // The account's browser context, created once and kept: a fresh context has to handshake
  // with the VM again (tens of seconds), a new tab in a kept one is ready in about a second.
  // Cookies are renewed every 10 minutes and written into the context.
  async context(account) {
    const a = this.acct(account.id)
    if (a.dead) {
      const err = a.dead
      a.dead = null
      await this.closeAccount(account.id)
      throw err
    }
    const { browser } = await this.start()
    const due = Date.now() - a.lastRenew > 600_000
    if (!a.contextId) {
      let { cookies, cookies_exp: exp } = account
      if (due) ({ cookies, exp } = await this.renewCookies(account, a, browser, cookies, exp))
      const ctx = await browser.send("Target.createBrowserContext", { disposeOnDetach: false })
      a.contextId = ctx.browserContextId
      await this.setCookies(browser, a.contextId, cookies, exp)
    } else if (due && !a.renewing) {
      // A kept page already has working cookies; refreshing them must not hold up the reply.
      const { cookies, cookies_exp: exp } = account
      a.renewing = this.renewCookies(account, a, browser, cookies, exp, { closeOnAuth: false })
        .finally(() => { a.renewing = null })
    }
    return a
  }

  // Renews cookies and writes them into the context when it already exists.
  // closeOnAuth: a first open closes the context at once; a refresh beside a live chat only marks it.
  async renewCookies(account, a, browser, cookies, exp, { closeOnAuth = true } = {}) {
    try {
      const r = await renewSession(this.site, cookies, exp, { fetchImpl: this.fetchImpl })
      a.lastRenew = Date.now()
      // Kept for the messages that name why a page had no composer.
      if (r.vmState) a.vmState = r.vmState
      this.onCookies(account.id, r.cookies, r.cookies_exp, r.vm)
      if (a.contextId) await this.setCookies(browser, a.contextId, r.cookies, r.cookies_exp)
      return { cookies: r.cookies, exp: r.cookies_exp }
    } catch (err) {
      // Persist cookies Muse rotated even in a refusal: the next page load must not reuse
      // credentials the upstream has just revoked (muse2api v1.6.11).
      if (err.cookies) {
        this.onCookies(account.id, err.cookies, err.cookies_exp, err.vm)
        if (a.contextId) await this.setCookies(browser, a.contextId, err.cookies, err.cookies_exp).catch(() => {})
      }
      if (err instanceof AuthError) {
        if (!closeOnAuth) a.dead = err
        else await this.closeAccount(account.id)
        if (closeOnAuth) throw err
      }
      // An unlinked workspace is not a transport hiccup: waiting for the page cannot help, so it
      // is reported as it is instead of letting a composer-less page do the talking.
      if (err instanceof AccountUnlinkedError) {
        a.vmState = "DISABLED"
        throw err
      }
      return { cookies: err.cookies || cookies, exp: err.cookies_exp || exp }
    }
  }

  async openTab(account, a) {
    const { browser, port } = await this.start()
    // The page starts loading before the debugger attaches, so a cold open overlaps the handshake.
    const { targetId } = await browser.send("Target.createTarget", {
      url: `${this.site}/thread/new`,
      browserContextId: a.contextId,
      background: true,
    })
    const page = await CDP.connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`, { timeoutMs: 180_000 })
    await Promise.all([
      page.send("Network.enable"),
      page.send("Page.enable"),
      page.send("Runtime.enable"),
      page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {}),
    ])
    const readyBy = async (ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        await sleep(80)
        if ((await page.js(READY_JS).catch(() => "")) === "ready") return true
      }
      return false
    }
    // The composer painting is not the whole answer: muse.ai decides on the client, a few seconds
    // in, whether this workspace is usable at all, and replaces a working composer with the
    // 「Muse已解除关联」 screen without navigating. A page counts as open only once the composer has
    // stayed there, so a warm that succeeds is a warm the next message can use.
    const stays = async (ms) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        await sleep(150)
        if ((await page.js(READY_JS).catch(() => "")) !== "ready") return false
      }
      return true
    }
    const opened = async () => (await readyBy(this.loadMs)) && (await stays(this.settleMs))
    const bodyText = async () => String((await page.js("document.body ? document.body.innerText.slice(0,1200) : ''").catch(() => "")) || "")
    if (await opened()) return { page, targetId, used: false, at: Date.now() }
    // The current build marks a signed-out page with a trace-policy attribute before its text
    // says anything; the text check below stays for builds that only render a "Log in" button.
    const gate = await page.js("!!document.querySelector('[data-hatch-initial-trace-policy=\\'hatch.login\\']')").catch(() => false)
    // A VM that is still connecting gets one more window; anything else has already failed.
    if (/connecting\.\.\.|正在连接|正在预热|warming up/i.test(await bodyText()) && (await opened())) {
      return { page, targetId, used: false, at: Date.now() }
    }
    const body = await bodyText()
    page.close()
    await browser.send("Target.closeTarget", { targetId }).catch(() => {})
    // Read after the page settled: the workspace was unlinked, so there is nothing to sign in to
    // and nothing to retry. Told apart from a sign-out (the cookies are fine) and from a timeout
    // (the page did load).
    if (UNLINKED.test(body)) throw new AccountUnlinkedError(unlinkedProblem(a.vmState))
    if (gate || SIGNED_OUT.test(body.toLowerCase())) {
      await this.closeAccount(account.id)
      throw new AuthError("会话已被 muse.ai 登出，需要重新登录")
    }
    throw new GenerationError("muse.ai 页面加载超时（没出现聊天输入框）；未确认登录失效")
  }

  // The account's one chat page, kept open so its connection to the VM stays up: a new page or
  // a reload has to connect again, 10–40 s, where moving between threads inside it takes 0.5 s.
  async home(account) {
    const a = await this.context(account)
    const h = a.home
    if (h && !h.page.closed && (await h.page.js(`!!document.querySelector(${JSON.stringify(COMPOSER_SEL)})`).catch(() => false))) return "kept"
    a.opening ??= (async () => {
      const lost = a.home ? (a.home.page.closed ? "lost:closed" : "lost:no-input") : ""
      await this.closeHome(a)
      a.home = await this.openTab(account, a)
      return lost ? `new(${lost})` : "new"
    })().finally(() => { a.opening = null })
    return a.opening
  }

  // Shows path in the page. Next.js's router keeps the page and its VM connection; a page
  // without it is loaded again. An existing thread counts as shown once its bubbles stop changing.
  async go(page, path) {
    const how = await page.js(`(function(p){
      var n = document.querySelectorAll(${JSON.stringify(BUBBLE_SEL)}).length;
      if (location.pathname === p) return (p === '/thread/new' && n) ? 'none' : 'here';
      var r = window.next && window.next.router;
      if (r && typeof r.push === 'function') { r.push(p); return 'router'; }
      return 'none';
    })(${JSON.stringify(path)})`).catch(() => "none")
    if (how === "none") await page.send("Page.navigate", { url: `${this.site}${path}` })
    const fresh = path === "/thread/new"
    const end = Date.now() + (how === "none" ? this.loadMs : 10_000)
    let last = -1
    let still = 0
    while (Date.now() < end) {
      await sleep(how === "here" ? 0 : 60)
      const s = JSON.parse((await page.js(`(function(){return JSON.stringify({p:location.pathname,
        ta:!!document.querySelector(${JSON.stringify(COMPOSER_SEL)}),
        n:document.querySelectorAll(${JSON.stringify(BUBBLE_SEL)}).length})})()`).catch(() => "null")) || "null")
      if (!s || s.p !== path || !s.ta) continue
      if (fresh ? s.n === 0 : s.n > 0) {
        still = s.n === last ? still + 1 : 0
        last = s.n
        if (fresh || still >= 3) return (await this.waitReady(page, 15_000)) ? how : false
      }
    }
    return false
  }

  // Puts the page on this conversation's thread when it can continue there, otherwise on a new
  // thread. Returns {how, continues}: continues means only the latest message needs sending.
  async thread(a, page, conversation, continuing) {
    let why = await page.js(NEEDS_NAV_JS(true)).catch(() => "")
    if (why === "stop-button") {
      // a reply left running (the caller went away): stop it, keeping the page
      await page.js(STOP_JS).catch(() => {})
      for (let i = 0; i < 40 && why === "stop-button"; i++) {
        await sleep(100)
        why = await page.js(NEEDS_NAV_JS(true)).catch(() => "")
      }
    }
    if (why === "stop-button" || why === "stuck") {
      // a reply still running or a page that lost its VM: only a reload gets it back
      a.current = null
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
      if (!(await this.go(page, "/thread/new"))) throw new GenerationError("muse.ai 页面重新加载后没有就绪")
      return { how: `reset(${why})`, continues: false }
    }
    const path = conversation && a.threads.get(conversation)
    if (continuing && path) {
      const how = await this.go(page, path)
      const after = how && (await page.js(NEEDS_NAV_JS(true)).catch(() => ""))
      if (how && !after) {
        a.current = conversation
        return { how: how === "here" ? "same" : "back", continues: true }
      }
      a.threads.delete(conversation)
    }
    if (!(await this.go(page, "/thread/new"))) {
      await page.send("Page.navigate", { url: `${this.site}/thread/new` })
      if (!(await this.go(page, "/thread/new"))) throw new GenerationError("muse.ai 没能打开新对话")
    }
    a.current = conversation || null
    return { how: "new-thread", continues: false }
  }

  // The thread muse.ai gave this conversation once it answered, to come back to later.
  async remember(a, page, conversation) {
    if (!conversation) return
    const p = await page.js("location.pathname").catch(() => "")
    if (/^\/thread\/[^/]+$/.test(p) && p !== "/thread/new") a.threads.set(conversation, p)
  }

  async send(page, prompt, vmState = "") {
    // Focus, scroll and measure in one evaluate: a single CDP round trip before typing.
    const rect = await page.js(`(function(){var c=document.querySelector(${JSON.stringify(COMPOSER_SEL)});if(!c)return null;try{c.scrollIntoView({block:'center',inline:'nearest'});c.focus();}catch(e){}var r=c.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`)
    if (!rect) {
      // No composer can mean two very different things: a page that is still loading, or the
      // 「Muse已解除关联」 screen that has no chat at all. Say which.
      const body = String((await page.js("document.body ? document.body.innerText.slice(0,1200) : ''").catch(() => "")) || "")
      if (UNLINKED.test(body)) throw new AccountUnlinkedError(unlinkedProblem(vmState))
      throw new GenerationError("找不到聊天输入框")
    }
    const c = JSON.parse(rect)
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", { type, x: c.x, y: c.y, button: "left", clickCount: 1 })
    }
    const len = (await page.js(SETTER_JS(prompt))) || 0
    if (!len && prompt.length < 500) {
      await page.send("Input.insertText", { text: prompt })
      await page.js(SETTER_JS(prompt))
    }
    const end = Date.now() + 3000
    while (Date.now() < end) {
      if ((await page.js(SEND_BUTTON_JS)) === "clicked") return "clicked"
      await sleep(80)
    }
    for (const modifiers of [1, 0]) {
      for (const type of ["keyDown", "char", "keyUp"]) {
        const params = { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers }
        if (type === "char") Object.assign(params, { text: "\r", unmodifiedText: "\r" })
        await page.send("Input.dispatchKeyEvent", params)
      }
      await sleep(1000)
      if (await page.js(COMPOSER_EMPTY_JS).catch(() => false)) return "enter-sent"
    }
    return "not-sent"
  }

  async poll(page) {
    try {
      const d = JSON.parse((await page.js(POLL_JS)) || "{}")
      return {
        cnt: Number(d.cnt) || 0,
        txt: String(d.txt || "").trim(),
        stop: !!d.stop,
        media: Array.isArray(d.media) ? d.media : [],
        pending: !!d.pending,
        // The page swapped in the 「Muse已解除关联」 screen: the composer is gone and no answer
        // is coming, so the wait that reads this stops instead of running to its deadline.
        unlinked: !!d.unlinked,
      }
    } catch {
      return { cnt: 0, txt: "", stop: false, media: [], pending: false, unlinked: false }
    }
  }

  // blob: URLs only exist in this browser. A client can render an https URL or a data URL.
  async replyMedia(page, media) {
    const items = []
    for (const m of media || []) {
      let url = String(m.src || "")
      if (url.startsWith("blob:")) {
        const read = `(async function(src){try{var r=await fetch(src);var b=await r.blob();if(!b.size||b.size>${6 << 20})return "";return await new Promise(function(res){var fr=new FileReader();fr.onload=function(){res(String(fr.result||""))};fr.onerror=function(){res("")};fr.readAsDataURL(b)})}catch(e){return ""}})(${JSON.stringify(url)})`
        url = String(await page.js(read, { awaitPromise: true, timeoutMs: 20_000 }).catch(() => "") || "")
      }
      if (url) items.push({ kind: m.kind, url })
    }
    return mediaMarkdown(items)
  }

  // Renews the account's session over HTTP and wakes its VM without a page. A 200 from wake
  // only means muse.ai took the request (muse2api 1.6.1): the session is read again for the
  // VM's state, RUNNING being the only proof it is up.
  async keepAlive(account) {
    const r = await renewSession(this.site, account.cookies, account.cookies_exp, { fetchImpl: this.fetchImpl })
    this.onCookies(account.id, r.cookies, r.cookies_exp, r.vm)
    let vmState = r.vmState
    if (r.vm && vmState !== "RUNNING") {
      await sleep(3000)
      vmState = (await renewSession(this.site, r.cookies, r.cookies_exp, { fetchImpl: this.fetchImpl, wakeVm: false }).catch(() => null))?.vmState || vmState
    }
    return { vmState }
  }

  // Opens a spare chat page ahead of the next new conversation. A conversation that already
  // Opens the account's page and lets it connect to the VM ahead of the first message.
  warm(account) {
    return this.home(account).then(() => true)
  }

  // A sign-in counts once the account has answered a short message, in a thread of its own.
  // The whole reply is waited for, so the page is free again afterwards.
  // Throws as chat does (AuthError, QuotaError, GenerationError).
  async verify(account) {
    try {
      let said = ""
      for await (const delta of this.chat(account, { full: VERIFY_PROMPT, last: VERIFY_PROMPT, turns: 1 }, { conversation: VERIFY })) said += delta
      if (!said.trim()) throw new GenerationError("测试消息没有得到回复")
    } finally {
      await this.closeTab(account.id, VERIFY).catch(() => {})
    }
  }

  // Yields text deltas for one conversation on the named account. prompt is {full, last}: last
  // is sent only when the conversation continues and the page can go back to its thread.
  // timing, when given, gets tabMs (getting the page ready) and firstMs (send → first text).
  async *chat(account: Account, prompt: { full: string; last: string; turns?: number }, { conversation = "", continuing = false, signal, timing = {}, expectTools = false }: { conversation?: string; continuing?: boolean; signal?: AbortSignal; timing?: ChatTiming; expectTools?: boolean } = {}): AsyncGenerator<string, void, unknown> {
    const t0 = Date.now()
    timing.how = await this.home(account)
    const a = this.accounts.get(account.id)
    const page = a.home.page
    await page.send("Page.bringToFront").catch(() => {})
    const { how, continues } = await this.thread(a, page, conversation, continuing)
    timing.how += `+${how}`
    const text = continues && prompt.last ? prompt.last : prompt.full
    timing.sent = text === prompt.full ? "full" : "last"
    timing.tabMs = Date.now() - t0
    const base = await this.poll(page)
    const seenMedia = new Set((base.media || []).map((m) => m.src))
    const sentHow = await this.send(page, text, a.vmState)
    if (sentHow === "not-sent") throw new GenerationError("消息没有发出去（输入框还在，发送按钮没有响应）")
    const sentAt = Date.now()
    const deadline = sentAt + this.chatTimeoutMs
    const firstBy = Math.min(deadline, sentAt + this.firstTokenMs)
    let sent = ""
    let last = null
    let changedAt = sentAt
    let got = false
    let lastNotice = sentAt
    let media = []
    let pendingSince = 0
    const takeMedia = (polled) => {
      if (polled.cnt <= base.cnt) return
      const fresh = (polled.media || []).filter((m) => m.src && !seenMedia.has(m.src))
      if (fresh.length) media = fresh
      if (polled.pending) pendingSince ||= Date.now()
    }
    // the bubble's whole final text goes in timing.text: what was streamed may carry restyling
    const flush = () => {
      timing.text = (last || "").replace(ZERO_WIDTH, "")
      const next = settle(sent, last || "", true)
      sent = next.sent
      return next.delta
    }
    const appendMedia = async () => {
      const extra = await this.replyMedia(page, media)
      if (extra) last = [last, extra].filter(Boolean).join("\n\n")
    }
    while (Date.now() < firstBy) {
      if (signal?.aborted) return
      await sleep(60)
      const polled = await this.poll(page)
      const { cnt, txt } = polled
      // The unlinked screen takes the composer away, so no text will ever arrive; saying why now
      // beats spending the first-token window on a page that cannot answer.
      if (polled.unlinked) throw new AccountUnlinkedError(unlinkedProblem(a.vmState))
      takeMedia(polled)
      const textNew = txt && !(cnt <= base.cnt && txt === base.txt)
      const mediaNew = cnt > base.cnt && (media.length || polled.pending)
      if (!textNew && !mediaNew) {
        if (Date.now() - lastNotice > 2000) {
          lastNotice = Date.now()
          const notice = String((await page.js(NOTICE_JS).catch(() => "")) || "")
          if (QUOTA_SPENT.test(notice)) {
            // the notice may stay on the page; a spent account opens a clean one when it is used again
            await this.closeHome(a)
            throw new QuotaError("muse.ai 说这个账号的使用额度用完了")
          }
        }
        if (Date.now() - sentAt > 14_000) {
          const tail = String((await page.js("document.body.innerText.slice(-500)").catch(() => "")) || "")
          if (STUCK.test(tail)) throw new GenerationError("云端 VM 连接超时（页面一直显示正在发送或正在连接）")
        }
        continue
      }
      if (textNew) {
        const { delta, sent: next } = settle(sent, txt)
        if (delta) {
          sent = next
          last = txt
          changedAt = Date.now()
          got = true
          timing.firstMs = Date.now() - sentAt
          await this.remember(a, page, conversation)
          yield delta
          break
        }
      }
      if (mediaNew) {
        got = true
        last = textNew ? txt : (last || "")
        changedAt = Date.now()
        timing.firstMs ??= Date.now() - sentAt
        break
      }
    }
    if (!got) {
      const body = String((await page.js("document.body.innerText").catch(() => "")) || "")
      // Read after the page settled: the workspace was unlinked on muse.ai's side, so neither the
      // message nor a retry can reach it. Told apart from a too-long prompt, which can be resent.
      if (UNLINKED.test(body)) throw new AccountUnlinkedError(unlinkedProblem(a.vmState))
      if (PROMPT_TOO_LONG.test(body)) throw new PromptTooLongError("muse.ai 拒收了这条消息：内容过长")
      if (/正在预热|warming up/i.test(body)) throw new GenerationError("muse.ai 这个账号的虚拟机还在预热，没有回答")
      throw new GenerationError("等待助手首字响应超时")
    }
    const quiet = expectTools ? this.quietMs : this.shortQuietMs
    let wasStop = null
    while (Date.now() < deadline) {
      if (signal?.aborted) return
      await sleep(60)
      const polled = await this.poll(page)
      const { txt, stop } = polled
      if (polled.unlinked) throw new AccountUnlinkedError(unlinkedProblem(a.vmState))
      takeMedia(polled)
      // The quiet window starts when the page says generation ended, not at the last text change:
      // a long silence while Stop is visible must not make the first poll without it final.
      if (stop !== wasStop) {
        wasStop = stop
        if (!stop) changedAt = Date.now()
      }
      const waitingMedia = polled.cnt > base.cnt && polled.pending && Date.now() - (pendingSince || Date.now()) < 20_000
      if (txt && txt !== last) {
        const { delta, sent: next } = settle(sent, txt)
        sent = next
        if (delta) yield delta
        last = txt
        changedAt = Date.now()
      } else if (!waitingMedia && (txt || media.length) && Date.now() - changedAt >= (stop ? this.stopQuietMs : quiet)) {
        await appendMedia()
        await this.remember(a, page, conversation)
        const tail = flush()
        if (tail) yield tail
        return
      }
    }
    throw new GenerationError("等待助手回复超时")
  }
}
