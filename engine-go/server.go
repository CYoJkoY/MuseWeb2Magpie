// Loopback HTTP surface of the engine: chat SSE · 401 sign-in expired · 429 account busy ·
// 503 engine trouble. The shapes here are the contract the Magpie plugin and any OpenAI-compatible
// client see; the page work behind them is the driver's, reached over one JSON line per request.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	usageStaleMS      = 30 * 60_000
	usageAfterChatMS  = 2 * 60_000
	maxRequestBody    = 8 << 20
	engineBusyRetry   = 1
	loginLimitMinutes = 15
)

type httpError struct {
	status int
	code   string
	retry  float64
	msg    string
}

func (e *httpError) Error() string { return e.msg }

func fail(status int, msg, code string) *httpError {
	return &httpError{status: status, msg: msg, code: code}
}

// generationCode turns the page's own words into something a gateway can act on: wait for the VM,
// retry now, or re-sign-in.
func generationCode(text string) (string, float64) {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(text, "预热") || strings.Contains(lower, "warming"):
		return "vm_warming", 10
	case strings.Contains(text, "页面") || strings.Contains(lower, "page") || strings.Contains(text, "加载"):
		return "page_unavailable", 10
	case strings.Contains(text, "超时") || strings.Contains(lower, "timeout"):
		return "upstream_timeout", 5
	case strings.Contains(text, "没有发出去") || strings.Contains(lower, "send"):
		return "send_failed", 2
	}
	return "engine_unavailable", 5
}

// response remembers whether the status line has gone out, so an error after streaming starts
// becomes an event instead of a second header block.
type response struct {
	w       http.ResponseWriter
	flusher http.Flusher
	status  int
	wrote   bool
}

func newResponse(w http.ResponseWriter) *response {
	r := &response{w: w, status: 200}
	if f, ok := w.(http.Flusher); ok {
		r.flusher = f
	}
	return r
}

func (r *response) header(status int, contentType string, extra map[string]string) {
	r.status = status
	r.wrote = true
	h := r.w.Header()
	h.Set("content-type", contentType)
	// Answers here carry account handles, usage numbers and a stream of live replies. Never let a
	// browser guess the type, and never let anything cache them; callers may pick a stricter
	// cache-control (the SSE stream keeps its own no-cache).
	h.Set("x-content-type-options", "nosniff")
	if _, set := extra["cache-control"]; !set {
		h.Set("cache-control", "no-store")
	}
	for name, value := range extra {
		h.Set(name, value)
	}
	r.w.WriteHeader(status)
}

func (r *response) json(status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		data = []byte(`{"error":{"message":"could not encode the answer","type":"engine_error"}}`)
		status = 500
	}
	r.header(status, "application/json; charset=utf-8", map[string]string{"content-length": strconv.Itoa(len(data))})
	_, _ = r.w.Write(data)
}

func (r *response) fail(err error) {
	status := 500
	code := ""
	var retry float64
	var he *httpError
	if errors.As(err, &he) {
		status, code, retry = he.status, he.code, he.retry
	}
	kind := "engine_error"
	switch {
	case status == 401:
		kind = "authentication_error"
	case status == 429:
		kind = "rate_limit_error"
	case status >= 400 && status < 500:
		kind = "invalid_request_error"
	}
	detail := map[string]any{"message": redact(err.Error()), "type": kind}
	if code != "" {
		detail["code"] = code
	}
	data, _ := json.Marshal(map[string]any{"error": detail})
	extra := map[string]string{"content-length": strconv.Itoa(len(data))}
	if retry > 0 {
		extra["retry-after"] = strconv.Itoa(int(maxf(1, float64(int(retry+0.999)))))
	}
	r.header(status, "application/json; charset=utf-8", extra)
	_, _ = r.w.Write(data)
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func (r *response) event(payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = io.WriteString(r.w, "data: "+string(data)+"\n\n")
}

func (r *response) flush() {
	if r.flusher != nil {
		r.flusher.Flush()
	}
}

// chatWriter frames one chat completion as server-sent events.
type chatWriter struct {
	r       *response
	id      string
	created int64
	started bool
	shown   strings.Builder
}

type chunkChoice struct {
	Index        int `json:"index"`
	Delta        any `json:"delta"`
	FinishReason any `json:"finish_reason"`
}

type chunkBody struct {
	ID      string        `json:"id"`
	Object  string        `json:"object"`
	Created int64         `json:"created"`
	Model   string        `json:"model"`
	Choices []chunkChoice `json:"choices"`
}

func (c *chatWriter) chunk(delta any, finish any) {
	c.r.event(chunkBody{
		ID:      c.id,
		Object:  "chat.completion.chunk",
		Created: c.created,
		Model:   modelName,
		Choices: []chunkChoice{{Index: 0, Delta: delta, FinishReason: finish}},
	})
	c.r.flush()
}

func (c *chatWriter) begin() {
	if c.started {
		return
	}
	c.r.header(200, "text/event-stream; charset=utf-8", map[string]string{
		"cache-control": "no-cache",
		"connection":    "keep-alive",
	})
	c.started = true
	c.chunk(map[string]any{"role": "assistant", "content": ""}, nil)
}

type meta struct {
	account string
	session string
	reason  string
	timing  string
	tools   string
}

type engine struct {
	cfg   config
	log   *logger
	store *store
	drv   *driver

	busyMu sync.Mutex
	busy   map[string]bool
	idling bool

	lastMu  sync.Mutex
	lastUse time.Time

	stop func(why string)
}

func newEngine(cfg config, log *logger, st *store, drv *driver) *engine {
	return &engine{cfg: cfg, log: log, store: st, drv: drv, busy: map[string]bool{}, lastUse: time.Now()}
}

func (e *engine) touch() {
	e.lastMu.Lock()
	e.lastUse = time.Now()
	e.lastMu.Unlock()
}

func (e *engine) idleFor() time.Duration {
	e.lastMu.Lock()
	defer e.lastMu.Unlock()
	return time.Since(e.lastUse)
}

func (e *engine) isBusy(id string) bool {
	e.busyMu.Lock()
	defer e.busyMu.Unlock()
	return e.busy[id]
}

func (e *engine) acquire(id string) bool {
	e.busyMu.Lock()
	defer e.busyMu.Unlock()
	if e.idling || e.busy[id] {
		return false
	}
	e.busy[id] = true
	return true
}

func (e *engine) beginIdle() bool {
	e.busyMu.Lock()
	defer e.busyMu.Unlock()
	if e.idling || len(e.busy) != 0 {
		return false
	}
	e.idling = true
	return true
}

func (e *engine) endIdle() {
	e.busyMu.Lock()
	e.idling = false
	e.busyMu.Unlock()
}

func (e *engine) setBusy(id string, busy bool) {
	e.busyMu.Lock()
	defer e.busyMu.Unlock()
	if busy {
		e.busy[id] = true
	} else {
		delete(e.busy, id)
	}
}

func (e *engine) authorize(r *http.Request) error {
	header := r.Header.Get("authorization")
	token := ""
	if len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") {
		token = strings.TrimSpace(header[7:])
	}
	if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(e.cfg.key)) != 1 {
		return fail(401, "bad engine key", "engine_key_invalid")
	}
	return nil
}

func (e *engine) account(r *http.Request) (account, error) {
	id := strings.TrimSpace(r.Header.Get("x-muse-account"))
	if id == "" {
		return account{}, fail(400, "missing X-Muse-Account", "account_missing")
	}
	acct, ok := e.store.Get(id)
	if !ok {
		return account{}, fail(401, "unknown account; sign in again", "account_unknown")
	}
	return acct, nil
}

func (e *engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	e.touch()
	res := newResponse(w)
	m := &meta{}
	err := e.route(res, r, m)
	if err != nil {
		m.reason = redact(err.Error())
		if !res.wrote {
			res.fail(err)
		}
	}
	e.touch()
	line := fmt.Sprintf("%s %d %s %s", timeString(), res.status, r.Method, r.URL.Path)
	if m.account != "" {
		line += " account=" + m.account
	}
	if m.session != "" {
		session := m.session
		if len(session) > 12 {
			session = session[:12]
		}
		line += " session=" + session
	}
	line += fmt.Sprintf(" %dms", time.Since(started).Milliseconds())
	if m.timing != "" {
		line += " " + m.timing
	}
	if m.tools != "" {
		line += " tools=" + m.tools
	}
	if m.reason != "" {
		line += " reason=" + m.reason
	}
	e.log.Log("%s", line)
}

func (e *engine) route(res *response, r *http.Request, m *meta) error {
	path := r.URL.Path
	switch {
	case r.Method == http.MethodGet && path == "/v1/health":
		body := map[string]any{"ok": true, "engine": engineName, "version": version, "accounts": e.store.Count()}
		// A caller may ask the port to prove it holds engine.key: it sends a nonce and gets back an
		// HMAC it can check locally. Without the challenge nothing extra is revealed, and the key
		// itself is never part of the answer.
		if nonce := strings.TrimSpace(r.Header.Get("x-muse-challenge")); validNonce(nonce) {
			body["proof"] = healthProof(e.cfg.key, nonce)
		}
		res.json(200, body)
		return nil
	case r.Method == http.MethodGet && path == "/v1/models":
		if err := e.authorize(r); err != nil {
			return err
		}
		res.json(200, map[string]any{"object": "list", "data": []any{
			map[string]any{"id": modelName, "object": "model", "owned_by": "muse.ai"},
		}})
		return nil
	case r.Method == http.MethodGet && path == "/v1/accounts":
		if err := e.authorize(r); err != nil {
			return err
		}
		handles := e.store.Handles()
		accounts := make([]map[string]any, 0, len(handles))
		for _, id := range handles {
			acct, ok := e.store.Get(id)
			if !ok {
				continue
			}
			accounts = append(accounts, map[string]any{"id": id, "label": acct.Label, "expires": expiryMS(acct.CookiesExp)})
		}
		res.json(200, map[string]any{"accounts": accounts})
		return nil
	case r.Method == http.MethodPost && path == "/v1/chat/completions":
		if err := e.authorize(r); err != nil {
			return err
		}
		return e.chat(res, r, m)
	case r.Method == http.MethodPost && path == "/v1/session/refresh":
		if err := e.authorize(r); err != nil {
			return err
		}
		return e.refresh(res, r, m)
	case r.Method == http.MethodGet && path == "/v1/usage":
		if err := e.authorize(r); err != nil {
			return err
		}
		return e.usage(res, r, m)
	case r.Method == http.MethodPost && path == "/v1/shutdown":
		if err := e.authorize(r); err != nil {
			return err
		}
		res.json(200, map[string]any{"ok": true})
		if e.stop != nil {
			go func() {
				time.Sleep(100 * time.Millisecond)
				e.stop("asked to stop")
			}()
		}
		return nil
	case r.Method == http.MethodPost && path == "/v1/login":
		if err := e.authorize(r); err != nil {
			return err
		}
		return e.loginStart(res, r)
	}
	if r.Method == http.MethodGet {
		if id, ok := strings.CutPrefix(path, "/v1/login/"); ok && id != "" && !strings.Contains(id, "/") {
			if err := e.authorize(r); err != nil {
				return err
			}
			state, err := e.loginState(r.Context(), id)
			if err != nil {
				return err
			}
			if state == nil {
				return fail(404, "no such login", "login_not_found")
			}
			res.json(200, state)
			return nil
		}
		if id, ok := strings.CutPrefix(path, "/login/"); ok && id != "" && !strings.Contains(id, "/") {
			state, err := e.loginState(r.Context(), id)
			if err != nil {
				state = nil
			}
			// The progress page is opened by a person in their own browser, driven by a URL that
			// carries a login id: keep it out of frames, out of caches and out of any third-party
			// request. It needs no script at all, only its own inline styles.
			res.header(200, "text/html; charset=utf-8", map[string]string{
				"cache-control":           "no-store",
				"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
				"x-frame-options":         "DENY",
				"referrer-policy":         "no-referrer",
			})
			_, _ = io.WriteString(res.w, loginPage(state))
			return nil
		}
	}
	return fail(404, "not found", "not_found")
}

type chatRequest struct {
	Stream     *bool           `json:"stream"`
	Messages   json.RawMessage `json:"messages"`
	Tools      json.RawMessage `json:"tools"`
	ToolChoice json.RawMessage `json:"tool_choice"`
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, fail(413, "request too large", "request_too_large")
		}
		return nil, err
	}
	return body, nil
}

func (e *engine) chat(res *response, r *http.Request, m *meta) error {
	raw, err := readBody(res.w, r)
	if err != nil {
		return err
	}
	var payload chatRequest
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			return fail(400, "invalid JSON body", "invalid_json")
		}
	}
	var messages []json.RawMessage
	if err := json.Unmarshal(payload.Messages, &messages); err != nil || len(messages) == 0 {
		return fail(400, "messages is empty", "invalid_request")
	}
	acct, err := e.account(r)
	if err != nil {
		return err
	}
	m.account = acct.ID
	if !e.acquire(acct.ID) {
		return &httpError{status: 429, code: "account_busy", retry: engineBusyRetry, msg: "account busy"}
	}
	defer e.setBusy(acct.ID, false)

	session := strings.TrimSpace(r.Header.Get("x-muse-session"))
	m.session = session
	stream := payload.Stream == nil || *payload.Stream
	id := "chatcmpl-" + mustHex(16)
	created := time.Now().Unix()
	out := &chatWriter{r: res, id: id, created: created}

	timing := map[string]any{}
	final, chatErr := e.drv.Stream(r.Context(), "chat_stream", map[string]any{
		"account":      acct,
		"messages":     payload.Messages,
		"tools":        payload.Tools,
		"tool_choice":  payload.ToolChoice,
		"conversation": session,
		"stream":       stream,
	}, func(ev event) error {
		switch ev.EV {
		case "delta":
			if !stream || ev.Text == "" {
				return nil
			}
			out.begin()
			out.chunk(map[string]any{"content": ev.Text}, nil)
			out.shown.WriteString(ev.Text)
		case "meta":
			if ev.How != "" {
				timing["how"] = ev.How
			}
			if ev.Sent != "" {
				timing["sent"] = ev.Sent
			}
			if ev.TabMS != nil {
				timing["tabMs"] = *ev.TabMS
			}
			if ev.FirstMS != nil {
				timing["firstMs"] = *ev.FirstMS
			}
		}
		return nil
	})
	m.timing = timingLine(timing)
	if chatErr != nil {
		return e.chatFailure(out, r, acct, session, chatErr, m)
	}
	if r.Context().Err() == nil {
		e.afterChatUsage(acct, usageAfterChatMS)
	}

	calls := final.Calls
	finish := "stop"
	if len(calls) > 0 {
		finish = "tool_calls"
	}
	m.tools = final.Tools
	toolCalls := make([]map[string]any, 0, len(calls))
	for _, call := range calls {
		toolCalls = append(toolCalls, map[string]any{
			"id":       "call_" + mustHex(12),
			"type":     "function",
			"function": map[string]any{"name": call.Name, "arguments": call.Arguments},
		})
	}

	if !stream {
		message := map[string]any{"role": "assistant"}
		if len(toolCalls) > 0 {
			var content any
			if final.Content != nil && *final.Content != "" {
				content = *final.Content
			}
			message["content"] = content
			message["tool_calls"] = toolCalls
		} else {
			message["content"] = final.Text
		}
		res.json(200, map[string]any{
			"id":      id,
			"object":  "chat.completion",
			"created": created,
			"model":   modelName,
			"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": finish}},
		})
		return nil
	}

	out.begin()
	for index, call := range toolCalls {
		fn := call["function"].(map[string]any)
		out.chunk(map[string]any{"tool_calls": []any{map[string]any{
			"index": index, "id": call["id"], "type": "function",
			"function": map[string]any{"name": fn["name"], "arguments": ""},
		}}}, nil)
		out.chunk(map[string]any{"tool_calls": []any{map[string]any{
			"index": index, "function": map[string]any{"arguments": fn["arguments"]},
		}}}, nil)
	}
	out.chunk(map[string]any{}, finish)
	_, _ = io.WriteString(res.w, "data: [DONE]\n\n")
	res.flush()
	return nil
}

// chatFailure maps the driver's classification onto the status the client expects, and turns a
// failure after the first byte into an event instead of a header rewrite.
func (e *engine) chatFailure(out *chatWriter, r *http.Request, acct account, session string, err error, m *meta) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = e.drv.Do(ctx, "close_tab", map[string]any{"account": acct, "conversation": session})
	if errors.Is(err, context.Canceled) {
		return nil
	}
	var de *driverError
	kind := ""
	if errors.As(err, &de) {
		kind = de.Kind
	}
	var mapped *httpError
	switch kind {
	case "auth":
		mapped = fail(401, err.Error(), "session_expired")
	case "quota":
		e.afterChatUsage(acct, 0)
		mapped = &httpError{status: 429, code: "quota_spent", retry: 60, msg: err.Error()}
	case "prompt_too_long":
		mapped = fail(413, err.Error(), "prompt_too_long")
	case "invalid_request":
		mapped = fail(400, err.Error(), "invalid_request")
	case "busy":
		mapped = &httpError{status: 429, code: "account_busy", retry: 1, msg: err.Error()}
	case "tool_call_not_parsed":
		mapped = fail(422, err.Error(), "tool_call_not_parsed")
	case "generation":
		code, retry := generationCode(err.Error())
		mapped = &httpError{status: 503, code: code, retry: retry, msg: err.Error()}
	default:
		if kind == "" && !out.started {
			code, retry := generationCode(err.Error())
			return &httpError{status: 503, code: code, retry: retry, msg: err.Error()}
		}
		mapped = &httpError{status: 503, code: "engine_unavailable", retry: 5, msg: err.Error()}
	}
	if !out.started {
		return mapped
	}
	out.r.event(map[string]any{"error": map[string]any{
		"message": redact(err.Error()),
		"type":    "engine_error",
		"code":    "stream_interrupted",
	}})
	_, _ = io.WriteString(out.r.w, "data: [DONE]\n\n")
	out.r.flush()
	return nil
}

func timingLine(timing map[string]any) string {
	parts := make([]string, 0, 4)
	if how, ok := timing["how"].(string); ok && how != "" {
		parts = append(parts, "tab="+how)
	}
	if sent, ok := timing["sent"].(string); ok && sent != "" {
		parts = append(parts, "sent="+sent)
	}
	if ms, ok := timing["tabMs"].(float64); ok {
		parts = append(parts, fmt.Sprintf("page=%.0fms", ms))
	}
	if ms, ok := timing["firstMs"].(float64); ok {
		parts = append(parts, fmt.Sprintf("first=%.0fms", ms))
	}
	return strings.Join(parts, " ")
}

// afterChatUsage lets what the answer spent show on the card soon after, at most every 2 minutes.
func (e *engine) afterChatUsage(acct account, maxAgeMS int64) {
	go func() {
		time.Sleep(1500 * time.Millisecond)
		// A new chat may already own this account's page; reading usage now would queue behind it.
		if e.isBusy(acct.ID) {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		e.readUsage(ctx, acct, maxAgeMS)
	}()
}

func (e *engine) readUsage(ctx context.Context, acct account, maxAgeMS int64) {
	started := time.Now()
	var out struct {
		Usage *usageCard `json:"usage"`
	}
	if err := e.drv.Decode(ctx, "read_usage", map[string]any{"account": acct, "maxAgeMs": maxAgeMS}, &out); err != nil {
		e.log.Log("%s usage account=%s failed reason=%s", timeString(), acct.ID, redact(err.Error()))
		return
	}
	if out.Usage == nil {
		return
	}
	meters := make([]string, 0, len(out.Usage.Windows))
	for _, w := range out.Usage.Windows {
		meters = append(meters, fmt.Sprintf("%s=%v%%", w.Name, w.Used))
	}
	e.log.Log("%s usage account=%s %dms %s", timeString(), acct.ID, time.Since(started).Milliseconds(), strings.Join(meters, " "))
}

type usageWindow struct {
	Name    string  `json:"name"`
	Used    float64 `json:"used"`
	Resets  string  `json:"resetsAt,omitempty"`
	Display string  `json:"display,omitempty"`
}

type usageCard struct {
	Plan    string        `json:"plan"`
	Windows []usageWindow `json:"windows"`
	At      int64         `json:"at,omitempty"`
}

func (e *engine) usage(res *response, r *http.Request, m *meta) error {
	acct, err := e.account(r)
	if err != nil {
		return err
	}
	m.account = acct.ID
	busy := e.isBusy(acct.ID)
	var out struct {
		Usage *usageCard `json:"usage"`
		Ready bool       `json:"ready"`
	}
	// A driver that is down costs the meters, not the card: the account is still signed in.
	if err := e.drv.Decode(r.Context(), "usage", map[string]any{"account": acct, "busy": busy, "maxAgeMs": usageStaleMS}, &out); err != nil {
		e.log.Log("%s usage account=%s failed reason=%s", timeString(), acct.ID, redact(err.Error()))
	}
	status := "闲置，下一条约需 30 秒唤醒"
	if busy {
		status = "正在回答"
	} else if out.Ready {
		status = "已就绪"
	}
	plan := "muse.ai"
	windows := []usageWindow{}
	if out.Usage != nil {
		if strings.TrimSpace(out.Usage.Plan) != "" {
			plan = out.Usage.Plan
		}
		if out.Usage.Windows != nil {
			windows = out.Usage.Windows
		}
	}
	body := map[string]any{"plan": plan + " · " + status, "windows": windows}
	if acct.Label != "" {
		body["user"] = acct.Label
	}
	if ms := expiryMS(acct.CookiesExp); ms != nil {
		body["until"] = isoMillis(*ms)
	}
	res.json(200, body)
	return nil
}

func (e *engine) refresh(res *response, r *http.Request, m *meta) error {
	acct, err := e.account(r)
	if err != nil {
		return err
	}
	m.account = acct.ID
	var out struct {
		Cookies    map[string]string `json:"cookies"`
		CookiesExp map[string]int64  `json:"cookies_exp"`
	}
	if err := e.drv.Decode(r.Context(), "refresh", map[string]any{"account": acct}, &out); err != nil {
		var de *driverError
		if errors.As(err, &de) && de.Kind == "auth" {
			return fail(401, err.Error(), "session_expired")
		}
		code, retry := generationCode(err.Error())
		return &httpError{status: 503, code: code, retry: retry, msg: err.Error()}
	}
	if err := e.store.Update(acct.ID, out.Cookies, out.CookiesExp, ""); err != nil {
		return err
	}
	res.json(200, map[string]any{"expires": expiryMS(out.CookiesExp)})
	return nil
}

func (e *engine) loginStart(res *response, r *http.Request) error {
	raw, err := readBody(res.w, r)
	if err != nil {
		return err
	}
	browser := ""
	if len(raw) > 0 {
		var payload struct {
			Browser string `json:"browser"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return fail(400, "invalid JSON body", "invalid_json")
		}
		browser = strings.TrimSpace(payload.Browser)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := e.drv.Decode(r.Context(), "login_start", map[string]any{"browser": browser}, &out); err != nil {
		return &httpError{status: 503, code: "engine_unavailable", retry: 5, msg: err.Error()}
	}
	res.json(200, map[string]any{"id": out.ID, "url": fmt.Sprintf("http://127.0.0.1:%d/login/%s", e.cfg.port, out.ID)})
	return nil
}

// loginState is the driver's view of one sign-in run, or nil when there is no such run.
func (e *engine) loginState(ctx context.Context, id string) (json.RawMessage, error) {
	raw, err := e.drv.Do(ctx, "login_status", map[string]any{"id": id})
	if err != nil {
		return nil, &httpError{status: 503, code: "engine_unavailable", retry: 5, msg: err.Error()}
	}
	var wrap struct {
		State json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		return nil, err
	}
	if len(wrap.State) == 0 || string(wrap.State) == "null" {
		return nil, nil
	}
	return wrap.State, nil
}

func mustHex(n int) string {
	out, err := randomHex(n)
	if err != nil {
		return strings.Repeat("0", n*2)
	}
	return out
}
