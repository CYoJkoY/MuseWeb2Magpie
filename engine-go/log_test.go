package main

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestOneLineStripsWhatAForgedRecordNeeds pins the shape of one record: nothing a caller sends can
// end the line early, and nothing can move the console cursor around either.
func TestOneLineStripsWhatAForgedRecordNeeds(t *testing.T) {
	for _, spec := range []struct {
		name string
		in   string
		want string
	}{
		{"plain", "500 GET /v1/health 12ms", "500 GET /v1/health 12ms"},
		{"empty", "", ""},
		{"newline", "a\nb", "a b"},
		{"crlf", "a\r\nb", "a  b"},
		{"tab", "a\tb", "a b"},
		{"nul", "a\x00b", "a b"},
		{"escape sequence", "a\x1b[2Jb", "a [2Jb"},
		{"delete", "a\x7fb", "a b"},
		{"line separator", "a\u2028b", "a b"},
		{"paragraph separator", "a\u2029b", "a b"},
		{"keeps text", "登录完成 account=muse-abc123", "登录完成 account=muse-abc123"},
	} {
		if got := oneLine(spec.in); got != spec.want {
			t.Errorf("%s: oneLine(%q) = %q, want %q", spec.name, spec.in, got, spec.want)
		}
	}
}

// TestOneLineBoundsOneRecord keeps a single record from swallowing the tail of the log.
func TestOneLineBoundsOneRecord(t *testing.T) {
	got := oneLine(strings.Repeat("x", 10*logLineLimit))
	if len(got) > logLineLimit+8 {
		t.Errorf("oneLine kept %d bytes of a %d-byte message, want about %d",
			len(got), 10*logLineLimit, logLineLimit)
	}
	if !strings.HasSuffix(got, "...") {
		t.Error("a truncated record does not say it was truncated")
	}
}

// TestUnauthenticatedRequestCannotForgeALogRecord is the reason oneLine exists. A request path is
// percent-decoded before the engine writes it, so a caller with no key at all could otherwise add
// a line of its own to engine.log and make the log say something that never happened.
func TestUnauthenticatedRequestCannotForgeALogRecord(t *testing.T) {
	e := newTestEngine(t)
	forged := "2026-11-27T00:00:00 200 GET /v1/accounts account=muse-forged"
	target := "/v1/health%0A" + strings.ReplaceAll(url.QueryEscape(forged), "+", "%20")
	rec := call(e, request(http.MethodGet, target, "127.0.0.1:18611"))
	// The path matches no route and no key was sent: this is a request anyone on the machine can
	// make.
	if rec.Code != 404 {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	raw, err := os.ReadFile(filepath.Join(e.cfg.dir, "engine.log"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("one request wrote %d log records, want 1:\n%s", len(lines), raw)
	}
	if !strings.Contains(lines[0], "GET /v1/health "+forged) {
		t.Errorf("record = %q, want the decoded path in it with the newline replaced", lines[0])
	}
}

// TestDriverLogWriterBoundsUnfinishedLine keeps a child that writes without newlines from growing
// the buffer for as long as it runs: the partial line is dropped, and the next real line still
// arrives.
func TestDriverLogWriterBoundsUnfinishedLine(t *testing.T) {
	dir := t.TempDir()
	w := &lineWriter{log: newLogger(dir, io.Discard)}
	chunk := bytes.Repeat([]byte("x"), 8<<10)
	for i := 0; i < 64; i++ {
		if _, err := w.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if len(w.buf) > maxDriverLine {
		t.Fatalf("buffer kept %d bytes of an unfinished line, want at most %d", len(w.buf), maxDriverLine)
	}
	// End whatever partial line is still buffered, then send a real one: the child's next message
	// still arrives as its own record.
	if _, err := w.Write([]byte("\nbrowser: ready\n")); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "engine.log"))
	if err != nil {
		t.Fatal(err)
	}
	log := string(raw)
	if !strings.Contains(log, "dropped") {
		t.Errorf("log does not say the unfinished line was dropped:\n%s", log)
	}
	lines := strings.Split(strings.TrimRight(log, "\n"), "\n")
	if lines[len(lines)-1] != "browser: ready" {
		t.Errorf("log lost the line that followed:\n%s", log)
	}
	for _, line := range lines {
		if len(line) > logLineLimit+8 {
			t.Errorf("record of %d bytes exceeds the limit", len(line))
		}
	}
}
