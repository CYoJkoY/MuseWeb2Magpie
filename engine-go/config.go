// Package main is the muse-web engine: the loopback HTTP surface Magpie talks to, the account
// store, and the supervisor for the browser driver. Everything that has to evaluate JavaScript
// inside muse.ai's page lives in engine/driver.ts; everything that can be decided from HTTP alone
// lives here, so the process that holds the port is one static binary with no runtime of its own.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	engineName  = "muse-web"
	modelName   = "muse-spark"
	defaultPort = 18611
	// engine.log is a tail, not an archive: it is rolled over once when it passes this size.
	logLimit = 5 << 20
	// logLineLimit bounds one record. Browser and driver messages can be long; the log is a tail
	// for diagnosis, so a single record never needs more than this.
	logLineLimit = 2048
	// maxDriverLine bounds how much of a driver message is held before its newline arrives. A child
	// that keeps writing without one would otherwise grow that buffer for as long as it runs.
	maxDriverLine = 64 << 10
)

// essentialCookies are the two muse.ai cookies that mean "signed in".
var essentialCookies = []string{"hatch_sess", "hatch_native_auth_device"}

func envValue(getenv func(string) string, name, fallback string) string {
	if v := strings.TrimSpace(getenv(name)); v != "" {
		return v
	}
	return fallback
}

// resolveDataDir keeps every engine's state (accounts, key, browser profile, log) in one place.
func resolveDataDir(getenv func(string) string, goos, home string) string {
	if dir := getenv("MUSE_WEB_HOME"); dir != "" {
		return dir
	}
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "muse-web")
	case "windows":
		appData := getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "muse-web")
	default:
		xdg := getenv("XDG_DATA_HOME")
		if xdg == "" {
			xdg = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(xdg, "muse-web")
	}
}

func resolvePort(getenv func(string) string) int {
	if n, err := strconv.Atoi(strings.TrimSpace(getenv("MUSE_WEB_ENGINE_PORT"))); err == nil && n > 0 && n < 65536 {
		return n
	}
	return defaultPort
}

// writePrivate replaces a file atomically, owner-readable only where the platform has modes.
func writePrivate(file, contents string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".muse-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.WriteString(contents); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), file)
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// engineKey is the bearer token every caller must present. "O_EXCL" makes creation exclusive, so
// two engines starting together cannot each install a key.
func engineKey(dir string) (string, error) {
	file := filepath.Join(dir, "engine.key")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	for i := 0; i < 20; i++ {
		if raw, err := os.ReadFile(file); err == nil {
			if key := strings.TrimSpace(string(raw)); key != "" {
				return key, nil
			}
			// Another engine created the file and has not written its key yet.
			time.Sleep(25 * time.Millisecond)
			continue
		}
		key, err := randomHex(24)
		if err != nil {
			return "", err
		}
		f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if errors.Is(err, fs.ErrExist) {
				continue
			}
			return "", err
		}
		_, writeErr := f.WriteString(key + "\n")
		closeErr := f.Close()
		if writeErr != nil {
			return "", writeErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		_ = os.Chmod(file, 0o600)
		return key, nil
	}
	// The file is there but empty (a crash between create and write): replace it atomically.
	key, err := randomHex(24)
	if err != nil {
		return "", err
	}
	return key, writePrivate(file, key+"\n")
}

var (
	redactBearer = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+`)
	redactQuery  = regexp.MustCompile(`(?i)([?&](?:key|token|access_token|refresh_token|api_key)=)[^&\s]+`)
	redactCookie = regexp.MustCompile(`(?i)\b(hatch_[a-z_]+)=([^;\s]+)`)
)

// healthProof answers a caller's nonce with an HMAC that only a holder of engine.key can make, so
// the port can prove "I am your engine" without the key ever being sent to it. The prefix keeps
// the answer from doubling as a signature over anything else. Kept identical to engine/health.ts.
func healthProof(key, nonce string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("muse-web-health:" + nonce))
	return hex.EncodeToString(mac.Sum(nil))
}

// validNonce keeps the unauthenticated proof from being a MAC oracle over arbitrary input.
func validNonce(nonce string) bool {
	if len(nonce) < 8 || len(nonce) > 64 {
		return false
	}
	for _, r := range nonce {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// redact strips the shapes that carry credentials, for log lines and error bodies alike.
func redact(text string) string {
	out := redactBearer.ReplaceAllString(text, "Bearer ***")
	out = redactQuery.ReplaceAllString(out, "$1***")
	return redactCookie.ReplaceAllString(out, "$1=***")
}

// masked hides the credentials a proxy URL may carry.
func masked(url string) string {
	if strings.TrimSpace(url) == "" {
		return ""
	}
	if at := strings.Index(url, "@"); at > 0 {
		if scheme := strings.Index(url, "//"); scheme >= 0 && scheme+2 <= at {
			return url[:scheme+2] + "***@" + url[at+1:]
		}
	}
	return url
}

func timeString() string {
	return time.Now().Format("15:04:05")
}

// oneLine makes text safe to append as one log record: no control characters, and no newlines.
// A request path arrives percent-decoded, so a path can carry a "\n"; an error text from a proxy
// or a page can carry anything at all. Without this rule an unauthenticated request could append a
// record of its own to engine.log — a line reading "200 GET /v1/accounts account=muse-…" that
// never happened — and whoever reads the log could not tell it from a real one.
func oneLine(text string) string {
	var b strings.Builder
	for _, r := range text {
		if b.Len() >= logLineLimit {
			b.WriteString("...")
			break
		}
		switch {
		case r == '\t':
			// A tab would still be one line, but it moves the columns a reader aligns on.
			b.WriteByte(' ')
		case r < 0x20 || r == 0x7f:
			// \r and \n are what a forged record needs; the rest of C0 and DEL are what a
			// terminal escape sequence starts with. All of them become a space.
			b.WriteByte(' ')
		case r == '\u2028' || r == '\u2029':
			// The line separators JSON and JavaScript also count as newlines.
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isoMillis is the shape JSON clients expect from a millisecond timestamp.
func isoMillis(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// logger writes to the terminal and to engine.log, rolling the file over once past its limit.
type logger struct {
	mu   sync.Mutex
	file string
	out  io.Writer
}

func newLogger(dir string, out io.Writer) *logger {
	return &logger{file: filepath.Join(dir, "engine.log"), out: out}
}

func (l *logger) Log(format string, args ...any) {
	// Every record goes through oneLine here, so the rule holds for request lines, driver
	// messages and a child process's stderr alike — there is no other path into the file.
	line := oneLine(fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.out != nil {
		fmt.Fprintln(l.out, line)
	}
	if l.file == "" {
		return
	}
	if st, err := os.Stat(l.file); err == nil && st.Size() > logLimit {
		_ = os.Rename(l.file, l.file+".1")
	}
	f, err := os.OpenFile(l.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.WriteString(line + "\n")
	_ = f.Close()
}

// lineWriter turns a child process's stderr into log lines of their own.
type lineWriter struct {
	log *logger
	buf []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		at := bytes.IndexByte(w.buf, '\n')
		if at < 0 {
			break
		}
		line := strings.TrimRight(string(w.buf[:at]), "\r")
		w.buf = w.buf[at+1:]
		if line != "" {
			w.log.Log("%s", line)
		}
	}
	// A child that writes without ever sending a newline would otherwise grow this buffer for as
	// long as it runs. The partial line is worthless for diagnosis, so it is dropped, not kept.
	if len(w.buf) > maxDriverLine {
		w.log.Log("%s driver: dropped %d bytes of an unfinished line", timeString(), len(w.buf))
		w.buf = nil
	}
	return len(p), nil
}
