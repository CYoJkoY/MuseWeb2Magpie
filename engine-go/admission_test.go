// Tests for the two admission rules of the loopback surface: the unauthenticated page does no
// work at all, and every row that does work runs under a fixed in-flight budget.
package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testLoginID is a login id of the shape login_start hands out: 12 base64url characters.
const testLoginID = "abcdefgh1234"

// TestMain doubles as a fake driver process. "Prove no process was started" cannot be answered
// portably by counting processes, so the test that needs it points MUSE_WEB_NODE at this very
// binary: any spawn of the driver then runs fakeDriver, which writes a marker file. In that role
// the binary answers the two sign-in ops and exits when its stdin closes.
func TestMain(m *testing.M) {
	if marker := os.Getenv("MUSE_FAKE_DRIVER_MARKER"); marker != "" {
		os.Exit(fakeDriver(marker))
	}
	os.Exit(m.Run())
}

func fakeDriver(marker string) int {
	if err := os.WriteFile(marker, []byte("spawned\n"), 0o600); err != nil {
		return 3
	}
	out := bufio.NewWriter(os.Stdout)
	_, _ = out.WriteString("{\"ev\":\"ready\"}\n")
	_ = out.Flush()
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		line := in.Bytes()
		if len(line) == 0 {
			continue
		}
		var req struct {
			ID string `json:"id"`
			Op string `json:"op"`
		}
		if err := json.Unmarshal(line, &req); err != nil || req.ID == "" {
			continue
		}
		reply := map[string]any{"id": req.ID, "ev": "error", "kind": "engine_unavailable", "message": "fake driver has no " + req.Op}
		switch req.Op {
		case "login_start":
			reply = map[string]any{"id": req.ID, "ev": "result", "value": map[string]any{"id": testLoginID}}
		case "login_status":
			reply = map[string]any{"id": req.ID, "ev": "result", "value": map[string]any{"state": nil}}
		}
		data, err := json.Marshal(reply)
		if err != nil {
			return 4
		}
		_, _ = out.Write(data)
		_, _ = out.WriteString("\n")
		_ = out.Flush()
	}
	return 0
}

// fakeRuntime makes this binary the driver's runtime, so a spawn is observable as a marker file.
func fakeRuntime(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	marker := filepath.Join(dir, "spawned")
	script := filepath.Join(dir, "driver.ts")
	if err := os.WriteFile(script, []byte("// placeholder; the test binary plays the driver\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MUSE_FAKE_DRIVER_MARKER", marker)
	t.Setenv("MUSE_WEB_NODE", exe)
	t.Setenv("MUSE_WEB_DRIVER", script)
	return marker
}

// TestUnauthenticatedLoginPageStartsNoProcess is the strong form of "the open page does no work":
// a GET to the progress page must not spawn the driver. The keyed login start, through the same
// runtime and script, must — otherwise the missing marker would only mean the check is broken.
func TestUnauthenticatedLoginPageStartsNoProcess(t *testing.T) {
	e := newTestEngine(t)
	marker := fakeRuntime(t)

	rec := call(e, request(http.MethodGet, "/login/"+testLoginID, "127.0.0.1:18611"))
	if rec.Code != 200 {
		t.Fatalf("login page status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "找不到这次登录") {
		t.Errorf("login page without a driver does not say the sign-in is unknown: %s", rec.Body.String())
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("the unauthenticated progress page started the driver process")
	}
	if e.drv.Running() {
		t.Fatal("the unauthenticated progress page left a driver running")
	}

	r := request(http.MethodPost, "/v1/login", "127.0.0.1:18611")
	r.Header.Set("authorization", "Bearer "+e.cfg.key)
	rec = call(e, r)
	if rec.Code != 200 {
		t.Fatalf("login start with the key = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("the keyed login start did not start the driver, so the marker proves nothing: %v", err)
	}
	if !e.drv.Running() {
		t.Fatal("the keyed login start did not leave a driver running")
	}
}

// occupy takes every token of a budget, so a request that needs one must be refused.
func occupy(t *testing.T, e *engine, budget chan struct{}, size int) {
	t.Helper()
	for i := 0; i < size; i++ {
		if _, ok := e.enter(budget); !ok {
			t.Fatalf("budget refused token %d of %d", i+1, size)
		}
	}
}

func drain(budget chan struct{}) {
	for len(budget) > 0 {
		<-budget
	}
}

// TestOpenSurfaceRefusesWhenItsBudgetIsSpent pins that the unauthenticated row answers 503 with a
// retry hint instead of queueing, that health stays exempt, and that the token comes back.
func TestOpenSurfaceRefusesWhenItsBudgetIsSpent(t *testing.T) {
	e := newTestEngine(t)
	occupy(t, e, e.open, openInFlight)
	defer drain(e.open)

	rec := call(e, request(http.MethodGet, "/login/"+testLoginID, "127.0.0.1:18611"))
	if rec.Code != 503 {
		t.Fatalf("login page with a spent open budget = %d, want 503", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code != "engine_busy" {
		t.Errorf("error code = %q (err %v), want engine_busy", body.Error.Code, err)
	}
	if rec.Header().Get("retry-after") == "" {
		t.Error("503 engine_busy carries no retry-after")
	}

	// Health is the row the plugin uses to decide "is an engine up": it must never be refused.
	if rec := call(e, request(http.MethodGet, "/v1/health", "127.0.0.1:18611")); rec.Code != 200 {
		t.Errorf("health with a spent open budget = %d, want 200", rec.Code)
	}
	// The keyed budget is untouched by an open-surface flood.
	r := request(http.MethodGet, "/v1/models", "127.0.0.1:18611")
	r.Header.Set("authorization", "Bearer "+e.cfg.key)
	if rec := call(e, r); rec.Code != 200 {
		t.Errorf("keyed route with a spent open budget = %d, want 200", rec.Code)
	}

	<-e.open
	if rec := call(e, request(http.MethodGet, "/login/"+testLoginID, "127.0.0.1:18611")); rec.Code != 200 {
		t.Errorf("login page after one token came back = %d, want 200", rec.Code)
	}
}

// TestKeyedSurfaceRefusesWhenItsBudgetIsSpent pins the same for the keyed rows, and that a normal
// answer gives its token back so the budget cannot shrink over time.
func TestKeyedSurfaceRefusesWhenItsBudgetIsSpent(t *testing.T) {
	e := newTestEngine(t)
	occupy(t, e, e.keyed, keyedInFlight)
	defer drain(e.keyed)

	r := request(http.MethodGet, "/v1/models", "127.0.0.1:18611")
	r.Header.Set("authorization", "Bearer "+e.cfg.key)
	rec := call(e, r)
	if rec.Code != 503 {
		t.Fatalf("keyed route with a spent keyed budget = %d, want 503", rec.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code != "engine_busy" {
		t.Errorf("error code = %q (err %v), want engine_busy", body.Error.Code, err)
	}
	if rec := call(e, request(http.MethodGet, "/v1/health", "127.0.0.1:18611")); rec.Code != 200 {
		t.Errorf("health with a spent keyed budget = %d, want 200", rec.Code)
	}

	drain(e.keyed)
	if rec := call(e, r); rec.Code != 200 {
		t.Fatalf("keyed route after the budget came back = %d, want 200", rec.Code)
	}
	if len(e.keyed) != 0 {
		t.Errorf("keyed budget holds %d tokens after an answer, want 0", len(e.keyed))
	}
	if len(e.open) != 0 {
		t.Errorf("open budget holds %d tokens after an answer, want 0", len(e.open))
	}
}

// TestWrongKeySpendsNoBudget pins the order inside route(): authorization comes first, so a caller
// guessing keys can never hold a token, let alone crowd out a caller that has the key.
func TestWrongKeySpendsNoBudget(t *testing.T) {
	e := newTestEngine(t)
	occupy(t, e, e.open, openInFlight)
	defer drain(e.open)

	r := request(http.MethodGet, "/v1/models", "127.0.0.1:18611")
	r.Header.Set("authorization", "Bearer not-the-key")
	rec := call(e, r)
	if rec.Code != 401 {
		t.Errorf("wrong key = %d, want 401", rec.Code)
	}
	if len(e.keyed) != 0 {
		t.Errorf("a rejected request is holding %d keyed tokens", len(e.keyed))
	}
}
