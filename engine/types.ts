// Shared shapes for the engine. Everything here is data that crosses a module boundary: the
// account store, the usage meters read off muse.ai's settings page, and the tool-call objects
// exchanged with the OpenAI-compatible client. Dynamic JSON from the page and from CDP stays
// `any` on purpose; the boundaries below are the parts worth naming.

export type Cookies = Record<string, string>
// name → expiry in unix seconds, as muse.ai sends it in Set-Cookie
export type ExpiryMap = Record<string, number>

// One entry of accounts.json.
export interface StoredAccount {
  cookies: Cookies
  cookies_exp: ExpiryMap
  label?: string
  created?: number
  vm?: string
}

// The store's view of an account: never carries the file's other fields.
export interface Account {
  id: string
  label: string
  cookies: Cookies
  cookies_exp: ExpiryMap
}

export interface SavedAccount {
  handle: string
  expires: number | null
  label: string
  // Set when the session was saved but a test message could not confirm it answers yet.
  warning?: string
  again?: boolean
  account?: Account
}

// One meter from Settings → Usage.
export interface Meter {
  name: string
  used: number
  texts: string[]
}

export interface UsageWindow {
  name: string
  used: number
  resetsAt?: string
  display?: string
}

export interface UsageCard {
  plan: string
  windows: UsageWindow[]
}

// A card plus when it was read.
export interface UsageReading extends UsageCard {
  at: number
}

// What /api/session hands back once a sign-in is accepted.
export interface Renewed {
  cookies: Cookies
  cookies_exp: ExpiryMap
  label: string
  vm: string
  vmState: string
}

export interface ToolFunction {
  name: string
  description: string
  parameters?: any
}

// A tool call as the page wrote it, before it becomes an OpenAI tool_calls entry.
export interface ParsedCall {
  name: string
  arguments: string
}

export interface ChatMessage {
  role?: string
  content?: unknown
  tool_calls?: any[]
  tool_call_id?: string
  [key: string]: unknown
}

export interface BuiltPrompt {
  full: string
  last: string
  turns: number
}

// A browser executable the engine chose, with any flags it needs.
export interface PickedBrowser {
  executable: string
  extraArgs: string[]
  source: string
  version: string
}
