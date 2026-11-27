package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestEngine builds a real engine wired the way main() builds it, minus the TCP listener: the
// driver is a lazy spawn, so nothing here touches a browser.
func newTestEngine(t *testing.T) *engine {
	t.Helper()
	dir := t.TempDir()
	log := newLogger(dir, io.Discard)
	st, err := newStore(filepath.Join(dir, "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	drv := newDriver(log)
	t.Cleanup(drv.Close)
	return newEngine(config{
		dir:  dir,
		port: defaultPort,
		key:  "test-engine-key",
		idle: time.Hour,
	}, log, st, drv)
}

// call sends one request through the engine's own ServeHTTP so every test exercises the same path
// as main()'s http.Server does.
func call(e *engine, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, r)
	return rec
}

func request(method, path, host string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.Host = host
	return r
}

// TestEveryRouteRequiresTheKey walks the route table itself: every row that declares auth must
// answer 401 before its handler can read a byte of the body. If someone adds an endpoint and
// forgets to wire authorization, this fails with the endpoint's name in the message.
func TestEveryRouteRequiresTheKey(t *testing.T) {
	e := newTestEngine(t)
	for _, rt := range e.table {
		if !rt.auth {
			continue
		}
		path := strings.Replace(rt.pattern, "{id}", "abc", 1)
		rec := call(e, request(rt.method, path, "127.0.0.1:18611"))
		if rec.Code != 401 {
			t.Errorf("%s %s without Authorization = %d, want 401", rt.method, path, rec.Code)
			continue
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("%s %s body is not JSON: %v", rt.method, path, err)
			continue
		}
		if body.Error.Code != "engine_key_invalid" {
			t.Errorf("%s %s error code = %q, want engine_key_invalid", rt.method, path, body.Error.Code)
		}
	}
}

// TestOnlyHealthAndLoginPageAreOpen pins the set of endpoints that need no key. A new unauthenti-
// cated endpoint must be added here knowingly, not by forgetting auth: true.
func TestOnlyHealthAndLoginPageAreOpen(t *testing.T) {
	e := newTestEngine(t)
	var open []string
	for _, rt := range e.table {
		if !rt.auth {
			open = append(open, rt.method+" "+rt.pattern)
		}
	}
	want := []string{"GET /v1/health", "GET /login/{id}"}
	if len(open) != len(want) {
		t.Fatalf("unauthenticated routes = %v, want exactly %v", open, want)
	}
	for i := range want {
		if open[i] != want[i] {
			t.Errorf("unauthenticated route[%d] = %q, want %q", i, open[i], want[i])
		}
	}
}

func TestAuthenticatedRoutesAcceptTheKey(t *testing.T) {
	e := newTestEngine(t)
	for _, rt := range e.table {
		if !rt.auth {
			continue
		}
		path := strings.Replace(rt.pattern, "{id}", "abc", 1)
		r := request(rt.method, path, "127.0.0.1:18611")
		r.Header.Set("authorization", "Bearer "+e.cfg.key)
		rec := call(e, r)
		if rec.Code == 401 {
			t.Errorf("%s %s with the key still returned 401", rt.method, path)
		}
	}
}

// TestHostHeaderMustBeLoopback pins the DNS-rebinding guard: the port answers only to loopback
// names, so a page that rebound a domain to 127.0.0.1 cannot read even the unauthenticated
// answers.
func TestHostHeaderMustBeLoopback(t *testing.T) {
	e := newTestEngine(t)
	for _, spec := range []struct {
		host   string
		status int
		code   string
	}{
		{"evil.example:18611", 403, "host_not_allowed"},
		{"evil.example", 403, "host_not_allowed"},
		{"localhost.evil.example:18611", 403, "host_not_allowed"},
		{"127.0.0.2:18611", 403, "host_not_allowed"},
		{"::ffff:127.0.0.1:18611", 403, "host_not_allowed"},
		{"127.0.0.1:18611", 200, ""},
		{"127.0.0.1", 200, ""},
		{"localhost:18611", 200, ""},
		{"localhost.", 200, ""},
		{"LOCALHOST:18611", 200, ""},
		{"[::1]:18611", 200, ""},
		{"[::1]", 200, ""},
	} {
		rec := call(e, request(http.MethodGet, "/v1/health", spec.host))
		if rec.Code != spec.status {
			t.Errorf("Host %q: status = %d, want %d", spec.host, rec.Code, spec.status)
			continue
		}
		if spec.code == "" {
			continue
		}
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code != spec.code {
			t.Errorf("Host %q: error code = %q (err %v), want %q", spec.host, body.Error.Code, err, spec.code)
		}
	}
}

// TestHealthProofStillAnswers pins the one behavior that makes the unauthenticated health check
// trustworthy: a valid nonce gets an HMAC proof the plugin can check locally.
func TestHealthProofStillAnswers(t *testing.T) {
	e := newTestEngine(t)
	r := request(http.MethodGet, "/v1/health", "127.0.0.1:18611")
	nonce := "nonce-0123456789"
	r.Header.Set("x-muse-challenge", nonce)
	rec := call(e, r)
	if rec.Code != 200 {
		t.Fatalf("health status = %d, want 200", rec.Code)
	}
	var body struct {
		Proof string `json:"proof"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if want := healthProof(e.cfg.key, nonce); body.Proof != want {
		t.Errorf("proof = %q, want %q", body.Proof, want)
	}
}

// TestLoginPageStillRendersWithoutKey guards the human path: the progress page stays reachable
// from a browser without the engine key, and keeps its hardening headers.
func TestLoginPageStillRendersWithoutKey(t *testing.T) {
	e := newTestEngine(t)
	rec := call(e, request(http.MethodGet, "/login/abc", "127.0.0.1:18611"))
	if rec.Code != 200 {
		t.Fatalf("login page status = %d, want 200", rec.Code)
	}
	h := rec.Header()
	for _, name := range []string{"Content-Security-Policy", "X-Frame-Options", "Referrer-Policy"} {
		if h.Get(name) == "" {
			t.Errorf("login page is missing %s", name)
		}
	}
}

// TestMethodMismatchStaysNotFound keeps the external shape the plugin and OpenAI clients see:
// a wrong method on a known path is a plain 404, not 405.
func TestMethodMismatchStaysNotFound(t *testing.T) {
	e := newTestEngine(t)
	for _, spec := range []struct{ method, path string }{
		{http.MethodPost, "/v1/health"},
		{http.MethodGet, "/v1/chat/completions"},
		{http.MethodGet, "/v1/shutdown"},
	} {
		rec := call(e, request(spec.method, spec.path, "127.0.0.1:18611"))
		if rec.Code != 404 {
			t.Errorf("%s %s = %d, want 404", spec.method, spec.path, rec.Code)
		}
	}
}

// TestLoopbackHost keeps the guard itself pinned to its accepted names, including the shapes
// Go's net/http can hand over in r.Host.
func TestLoopbackHost(t *testing.T) {
	for _, spec := range []struct {
		host string
		want bool
	}{
		{"127.0.0.1:18611", true},
		{"localhost:18611", true},
		{"[::1]:18611", true},
		{"[::1]", true},
		{"::1", true},
		{"0.0.0.0", true},
		{"0.0.0.0:18611", true},
		{"localhost.", true},
		{"LOCALHOST:18611", true},
		{"127.0.0.1.", true},
		{"evil.example:18611", false},
		{"localhost.evil.example:18611", false},
		{"127.0.0.2:18611", false},
		{"::ffff:127.0.0.1:18611", false},
		{"[::ffff:127.0.0.1]:18611", false},
		{"", false},
		{"   ", false},
	} {
		if got := loopbackHost(spec.host); got != spec.want {
			t.Errorf("loopbackHost(%q) = %v, want %v", spec.host, got, spec.want)
		}
	}
}

// TestWrongLoginIDFormatStaysNotFound keeps the id rules where they live: in the route's matcher,
// not re-checked by hand inside the handler.
func TestWrongLoginIDFormatStaysNotFound(t *testing.T) {
	e := newTestEngine(t)
	for _, path := range []string{"/v1/login/", "/v1/login/a/b", "/login/", "/login/a/b"} {
		rec := call(e, request(http.MethodGet, path, "127.0.0.1:18611"))
		if rec.Code != 404 {
			t.Errorf("GET %s = %d, want 404", path, rec.Code)
		}
	}
}

// TestDriverIsNotSpawnedByHTTP pins the lazy-driver property the tests rely on: answering HTTP
// — even the sign-in endpoints — must not start a browser when the driver idles. A login start
// with no driver up answers 503, not a spawned process.
func TestDriverIsNotSpawnedByHTTP(t *testing.T) {
	e := newTestEngine(t)
	r := request(http.MethodPost, "/v1/login", "127.0.0.1:18611")
	r.Header.Set("authorization", "Bearer "+e.cfg.key)
	rec := call(e, r)
	if rec.Code != 503 {
		t.Errorf("login start with idle driver = %d, want 503", rec.Code)
	}
}

// TestHealthDoesNotCountAccounts pins the thinness of the unauthenticated answer: any local user
// can read it, so it says an engine is up and which version, and nothing about the accounts
// behind the key.
func TestHealthDoesNotCountAccounts(t *testing.T) {
	e := newTestEngine(t)
	if _, err := e.store.Add(map[string]string{"hatch_sess": "s"}, nil, "someone@example.test", ""); err != nil {
		t.Fatal(err)
	}
	rec := call(e, request(http.MethodGet, "/v1/health", "127.0.0.1:18611"))
	if rec.Code != 200 {
		t.Fatalf("health status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["accounts"]; ok {
		t.Errorf("unauthenticated health answer counts accounts: %v", body)
	}
	if body["engine"] != engineName {
		t.Errorf("health engine = %v, want %q", body["engine"], engineName)
	}
	if body["version"] != version {
		t.Errorf("health version = %v, want %q", body["version"], version)
	}
	// The count is still available where it belongs: behind the key.
	r := request(http.MethodGet, "/v1/accounts", "127.0.0.1:18611")
	r.Header.Set("authorization", "Bearer "+e.cfg.key)
	var listed struct {
		Accounts []map[string]any `json:"accounts"`
	}
	if err := json.Unmarshal(call(e, r).Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Accounts) != 1 {
		t.Errorf("/v1/accounts lists %d accounts, want 1", len(listed.Accounts))
	}
}

// TestHTTPServerSetsItsLimits pins the listener's limits, including the request deadline that
// keeps a trickling body from pinning the process — and the absence of a write deadline, which
// would cut a streaming answer short.
func TestHTTPServerSetsItsLimits(t *testing.T) {
	s := newHTTPServer(nil)
	if s.ReadHeaderTimeout <= 0 || s.ReadTimeout <= 0 || s.IdleTimeout <= 0 || s.MaxHeaderBytes <= 0 {
		t.Errorf("unbounded server: header=%v read=%v idle=%v maxHeader=%d",
			s.ReadHeaderTimeout, s.ReadTimeout, s.IdleTimeout, s.MaxHeaderBytes)
	}
	if s.ReadTimeout > 2*time.Minute {
		t.Errorf("read timeout %v is long enough to be a pin", s.ReadTimeout)
	}
	if s.WriteTimeout != 0 {
		t.Errorf("write timeout %v would cut streaming answers", s.WriteTimeout)
	}
	if s.MaxHeaderBytes > 1<<20 {
		t.Errorf("header limit %d is far above the 32 KB the engine expects", s.MaxHeaderBytes)
	}
}

