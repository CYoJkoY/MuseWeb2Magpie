// The driver is engine/driver.ts running under the JavaScript runtime that started the plugin.
// It owns Muse and Logins — the parts that must evaluate code inside muse.ai's page — and speaks
// one JSON object per line on stdin and stdout. Everything here is about keeping that pipe healthy:
// a single writer, a single reader, and a request table so a chat can stream while other calls
// run. The driver may also call back into this process (a finished sign-in asks the store to save
// the account); those requests arrive on the same pipe, tagged with an "rid" instead of an "id".
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var errDriverDown = errors.New("muse-web driver is not running")

// driverError carries the driver's own classification of a failure, so the HTTP layer can pick a
// status and a code without reading the message.
type driverError struct {
	Kind    string
	Message string
}

func (e *driverError) Error() string { return e.Message }

func newDriverError(kind, message string) error {
	if message == "" {
		message = "engine unavailable"
	}
	return &driverError{Kind: kind, Message: message}
}

type driverCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// event is one line of the driver's protocol; only the fields a given message uses are set.
type event struct {
	ID      string          `json:"id,omitempty"`
	RID     string          `json:"rid,omitempty"`
	EV      string          `json:"ev,omitempty"`
	Req     string          `json:"req,omitempty"`
	Op      string          `json:"op,omitempty"`
	OK      *bool           `json:"ok,omitempty"`
	Value   json.RawMessage `json:"value,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Error   string          `json:"error,omitempty"`
	Kind    string          `json:"kind,omitempty"`
	Message string          `json:"message,omitempty"`
	Line    string          `json:"line,omitempty"`
	Why     string          `json:"why,omitempty"`
	Version string          `json:"version,omitempty"`

	Handle     string            `json:"handle,omitempty"`
	Cookies    map[string]string `json:"cookies,omitempty"`
	CookiesExp map[string]int64  `json:"cookies_exp,omitempty"`
	VM         string            `json:"vm,omitempty"`

	Text    string       `json:"text,omitempty"`
	Content *string      `json:"content,omitempty"`
	Calls   []driverCall `json:"calls,omitempty"`
	Tools   string       `json:"tools,omitempty"`
	How     string       `json:"how,omitempty"`
	Sent    string       `json:"sent,omitempty"`
	TabMS   *float64     `json:"tabMs,omitempty"`
	FirstMS *float64     `json:"firstMs,omitempty"`
}

type waiting struct {
	ch   chan event
	gone chan struct{}
	done chan struct{}
}

type driver struct {
	log *logger
	// handler answers the driver's own requests (store.add, store.remove).
	handler func(req string, params json.RawMessage) (any, error)

	startMu  sync.Mutex
	stateMu  sync.Mutex
	stdin    io.WriteCloser
	pending  map[string]*waiting
	started  bool
	closed   bool
	cmd      *exec.Cmd
	exited   chan struct{}
	gone     chan struct{}
	failed   error
	failedAt time.Time

	writeMu sync.Mutex
	seq     atomic.Uint64
}

func newDriver(log *logger) *driver {
	return &driver{log: log, pending: map[string]*waiting{}, gone: make(chan struct{})}
}

func (d *driver) nextID() string {
	return fmt.Sprintf("r%d", d.seq.Add(1))
}

// driverScript finds engine/driver.ts relative to this binary or an explicit override.
func driverScript() (string, error) {
	if path := strings.TrimSpace(os.Getenv("MUSE_WEB_DRIVER")); path != "" {
		if _, err := os.Stat(path); err != nil {
			return "", fmt.Errorf("MUSE_WEB_DRIVER: %w", err)
		}
		return path, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exeDir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(exeDir, "driver.ts"),
		filepath.Join(exeDir, "..", "engine", "driver.ts"),
		filepath.Join(exeDir, "..", "..", "..", "engine", "driver.ts"),
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}
	return "", errors.New("engine/driver.ts not found; set MUSE_WEB_DRIVER to its path")
}

// ensure starts the driver the first time it is needed. A failed start is remembered briefly, so a
// broken runtime does not respawn the process on every request.
func (d *driver) ensure(ctx context.Context) error {
	d.startMu.Lock()
	defer d.startMu.Unlock()
	d.stateMu.Lock()
	started := d.started
	closed := d.closed
	failed, failedAt := d.failed, d.failedAt
	d.stateMu.Unlock()
	if closed {
		return errDriverDown
	}
	if started {
		return nil
	}
	if failed != nil && time.Since(failedAt) < 3*time.Second {
		return failed
	}

	runtime := envValue(os.Getenv, "MUSE_WEB_NODE", "node")
	script, err := driverScript()
	if err != nil {
		d.rememberFailure(err)
		return err
	}
	cmd := exec.Command(runtime, script)
	cmd.Env = append(os.Environ(), "MUSE_WEB_CHILD=1")
	cmd.SysProcAttr = hiddenWindow()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		d.rememberFailure(err)
		return err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		d.rememberFailure(err)
		return err
	}
	cmd.Stderr = &lineWriter{log: d.log}
	if err := cmd.Start(); err != nil {
		failure := fmt.Errorf("driver: %w", err)
		d.rememberFailure(failure)
		return failure
	}

	ready := make(chan struct{})
	gone := make(chan struct{})
	exited := make(chan struct{})
	d.stateMu.Lock()
	d.stdin = stdin
	d.cmd = cmd
	d.exited = exited
	d.started = true
	d.failed = nil
	d.gone = gone
	d.pending = map[string]*waiting{}
	d.stateMu.Unlock()

	go d.readLoop(stdout, ready, gone)
	go func() {
		_ = cmd.Wait()
		d.retire(gone, errors.New("driver exited"))
		close(exited)
	}()

	select {
	case <-ready:
		return nil
	case <-gone:
		return errors.New("driver stopped before it was ready")
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		return errors.New("driver did not become ready")
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return ctx.Err()
	}
}

func (d *driver) rememberFailure(err error) {
	d.stateMu.Lock()
	d.failed = err
	d.failedAt = time.Now()
	d.stateMu.Unlock()
}

// Running reports whether a driver process is up right now, without starting one. Callers that
// answer unauthenticated requests use it to skip work entirely when nothing could be in flight:
// reading that nothing is running costs one mutex, while ensure() would spawn a browser process.
func (d *driver) Running() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.started && d.stdin != nil
}

// retire forgets a dead generation: the next request starts a fresh driver.
func (d *driver) retire(gone chan struct{}, cause error) {
	d.stateMu.Lock()
	if d.gone == gone {
		if d.stdin != nil {
			_ = d.stdin.Close()
		}
		d.stdin = nil
		d.started = false
		d.failed = cause
		d.failedAt = time.Now()
		d.pending = map[string]*waiting{}
	}
	select {
	case <-gone:
	default:
		close(gone)
	}
	d.stateMu.Unlock()
}

func (d *driver) readLoop(r io.Reader, ready, gone chan struct{}) {
	var readyOnce sync.Once
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev event
		if err := json.Unmarshal(line, &ev); err != nil {
			d.log.Log("driver: unreadable line (%d bytes)", len(line))
			continue
		}
		if ev.EV == "ready" {
			readyOnce.Do(func() { close(ready) })
			continue
		}
		d.dispatch(ev, gone)
	}
	if err := scanner.Err(); err != nil {
		d.log.Log("driver: %s", redact(err.Error()))
	}
	d.retire(gone, errors.New("driver output closed"))
}

func (d *driver) dispatch(ev event, gone chan struct{}) {
	d.stateMu.Lock()
	current := d.gone == gone
	d.stateMu.Unlock()
	if !current {
		return
	}
	if ev.RID != "" && ev.Req != "" {
		d.answer(ev)
		return
	}
	if ev.ID != "" {
		d.stateMu.Lock()
		w := d.pending[ev.ID]
		d.stateMu.Unlock()
		if w == nil {
			return
		}
		select {
		case w.ch <- ev:
		case <-w.done:
		case <-w.gone:
		}
		return
	}
	// Unsolicited: the driver describing something that happened on its own.
	switch ev.EV {
	case "cookies":
		d.log.Log("%s cookies account=%s (%d)", timeString(), ev.Handle, len(ev.Cookies))
		if d.handler != nil {
			params, _ := json.Marshal(map[string]any{"handle": ev.Handle, "cookies": ev.Cookies, "cookies_exp": ev.CookiesExp, "vm": ev.VM})
			if _, err := d.handler("store.update", params); err != nil {
				d.log.Log("driver: saving renewed cookies failed: %s", redact(err.Error()))
			}
		}
	case "lost":
		d.log.Log("%s browser lost (%s) — a new one starts with the next request", timeString(), redact(ev.Why))
	case "log":
		d.log.Log("%s %s", timeString(), redact(ev.Line))
	}
}

// answer serves a request the driver made of this process.
func (d *driver) answer(ev event) {
	var value any
	var err error
	if d.handler != nil {
		value, err = d.handler(ev.Req, ev.Params)
	} else {
		err = errors.New("driver callback handler unavailable")
	}
	reply := map[string]any{"rid": ev.RID}
	if err != nil {
		reply["ok"] = false
		reply["error"] = redact(err.Error())
	} else {
		reply["ok"] = true
		reply["value"] = value
	}
	if sendErr := d.send(reply); sendErr != nil {
		d.log.Log("driver: reply to %s not sent: %s", ev.Req, redact(sendErr.Error()))
	}
}

func (d *driver) send(v any) error {
	d.stateMu.Lock()
	stdin := d.stdin
	d.stateMu.Unlock()
	if stdin == nil {
		return errDriverDown
	}
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	line = append(line, '\n')
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	_, err = stdin.Write(line)
	return err
}

func (d *driver) register(id string) *waiting {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	w := &waiting{ch: make(chan event, 256), gone: d.gone, done: make(chan struct{})}
	d.pending[id] = w
	return w
}

func (d *driver) unregister(id string) {
	d.stateMu.Lock()
	if pending := d.pending[id]; pending != nil {
		close(pending.done)
	}
	delete(d.pending, id)
	d.stateMu.Unlock()
}

// Do runs one request and returns its "result" value.
func (d *driver) Do(ctx context.Context, op string, params any) (json.RawMessage, error) {
	if err := d.ensure(ctx); err != nil {
		return nil, err
	}
	id := d.nextID()
	w := d.register(id)
	defer d.unregister(id)
	if err := d.send(map[string]any{"id": id, "op": op, "params": params}); err != nil {
		return nil, err
	}
	for {
		select {
		case ev := <-w.ch:
			switch ev.EV {
			case "result":
				return ev.Value, nil
			case "error":
				return nil, newDriverError(ev.Kind, ev.Message)
			}
		case <-w.gone:
			return nil, errDriverDown
		case <-ctx.Done():
			_ = d.send(map[string]any{"id": id, "op": "abort"})
			return nil, ctx.Err()
		}
	}
}

// Decode unpacks a Do result into v.
func (d *driver) Decode(ctx context.Context, op string, params, v any) error {
	raw, err := d.Do(ctx, op, params)
	if err != nil {
		return err
	}
	if len(raw) == 0 || v == nil {
		return nil
	}
	return json.Unmarshal(raw, v)
}

// Stream runs a request whose answer arrives in parts, and returns the final message.
func (d *driver) Stream(ctx context.Context, op string, params any, fn func(event) error) (event, error) {
	if err := d.ensure(ctx); err != nil {
		return event{}, err
	}
	id := d.nextID()
	w := d.register(id)
	defer d.unregister(id)
	if err := d.send(map[string]any{"id": id, "op": op, "params": params}); err != nil {
		return event{}, err
	}
	var once sync.Once
	cancel := func() { once.Do(func() { _ = d.send(map[string]any{"id": id, "op": "abort"}) }) }
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			cancel()
		case <-done:
		}
	}()
	for {
		select {
		case ev := <-w.ch:
			switch ev.EV {
			case "delta", "meta":
				if fn != nil {
					if err := fn(ev); err != nil {
						cancel()
						return event{}, err
					}
				}
			case "final":
				return ev, nil
			case "error":
				return event{}, newDriverError(ev.Kind, ev.Message)
			}
		case <-w.gone:
			return event{}, errDriverDown
		case <-ctx.Done():
			cancel()
			return event{}, ctx.Err()
		}
	}
}

// Close shuts the driver down for good.
func (d *driver) Close() {
	d.startMu.Lock()
	defer d.startMu.Unlock()
	d.stateMu.Lock()
	stdin := d.stdin
	cmd, exited, gone := d.cmd, d.exited, d.gone
	d.closed = true
	d.stdin = nil
	d.started = false
	d.stateMu.Unlock()
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd == nil {
		return
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		_ = cmd.Process.Kill()
		<-exited
	}
	d.retire(gone, errDriverDown)
}
