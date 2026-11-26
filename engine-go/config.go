// Package main is the muse-web engine: the loopback HTTP surface Magpie talks to, the account
// store, and the supervisor for the browser driver. Everything that has to evaluate JavaScript
// inside muse.ai's page lives in engine/driver.ts; everything that can be decided from HTTP alone
// lives here, so the process that holds the port is one static binary with no runtime of its own.
package main

import (
	"crypto/rand"
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
	line := fmt.Sprintf(format, args...)
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
		at := strings.IndexByte(string(w.buf), '\n')
		if at < 0 {
			break
		}
		line := strings.TrimRight(string(w.buf[:at]), "\r")
		w.buf = w.buf[at+1:]
		if line != "" {
			w.log.Log("%s", line)
		}
	}
	return len(p), nil
}
