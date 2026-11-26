package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "0.11.0"

// prewarmUsageParallel caps how many usage reads run at once during cold start. Each read opens
// its own tab, so a small pool keeps a large saved set from flooding the browser.
const prewarmUsageParallel = 3

type config struct {
	dir         string
	port        int
	key         string
	site        string
	idle        time.Duration
	prewarm     bool
	verifyLogin bool
	parentPID   int
}

func loadConfig() (config, error) {
	home, err := os.UserHomeDir()
	if err != nil && os.Getenv("MUSE_WEB_HOME") == "" {
		return config{}, err
	}
	idleMinutes, _ := strconv.ParseFloat(os.Getenv("MUSE_WEB_IDLE_MIN"), 64)
	if idleMinutes <= 0 || idleMinutes > 525600 {
		idleMinutes = 60
	}
	parent, _ := strconv.Atoi(os.Getenv("MUSE_WEB_PARENT_PID"))
	return config{
		dir:         resolveDataDir(os.Getenv, runtime.GOOS, home),
		port:        resolvePort(os.Getenv),
		site:        strings.TrimRight(envValue(os.Getenv, "MUSE_WEB_SITE", "https://muse.ai"), "/"),
		idle:        time.Duration(idleMinutes * float64(time.Minute)),
		prewarm:     os.Getenv("MUSE_WEB_PREWARM") != "0",
		verifyLogin: os.Getenv("MUSE_WEB_VERIFY_LOGIN") != "0",
		parentPID:   parent,
	}, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, redact(err.Error()))
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(cfg.dir, 0o700); err != nil {
		return err
	}
	log := newLogger(cfg.dir, os.Stderr)
	cfg.key, err = engineKey(cfg.dir)
	if err != nil {
		return err
	}
	st, err := newStore(filepath.Join(cfg.dir, "accounts.json"))
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", cfg.port))
	if err != nil {
		if errors.Is(err, syscall.EADDRINUSE) && sameEngine(cfg.port) {
			log.Log("another muse-web engine already serves port %d; leaving it running", cfg.port)
			return nil
		}
		return fmt.Errorf("port %d unavailable; set MUSE_WEB_ENGINE_PORT: %w", cfg.port, err)
	}
	drv := newDriver(log)
	defer drv.Close()
	e := newEngine(cfg, log, st, drv)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wokenMu sync.Mutex
	woken := map[string]time.Time{}
	for _, handle := range st.Handles() {
		woken[handle] = time.Now()
	}
	drv.handler = func(req string, raw json.RawMessage) (any, error) {
		var params struct {
			Handle     string            `json:"handle"`
			Cookies    map[string]string `json:"cookies"`
			CookiesExp map[string]int64  `json:"cookies_exp"`
			Label      string            `json:"label"`
			VM         string            `json:"vm"`
		}
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, err
		}
		switch req {
		case "store.get":
			if acct, ok := st.Get(params.Handle); ok {
				return acct, nil
			}
			return nil, nil
		case "store.add":
			return st.Add(params.Cookies, params.CookiesExp, params.Label, params.VM)
		case "store.update":
			return nil, st.Update(params.Handle, params.Cookies, params.CookiesExp, params.VM)
		case "store.remove":
			return nil, st.Remove(params.Handle)
		case "woken":
			wokenMu.Lock()
			woken[params.Handle] = time.Now()
			wokenMu.Unlock()
			return nil, nil
		default:
			return nil, fmt.Errorf("unknown driver callback: %s", req)
		}
	}
	server := &http.Server{Handler: e, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	var stopOnce sync.Once
	e.stop = func(why string) {
		stopOnce.Do(func() {
			log.Log("%s engine stopping (%s)", timeString(), why)
			cancel()
			_ = server.Close()
		})
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		select {
		case sig := <-signals:
			e.stop(sig.String())
		case <-ctx.Done():
		}
	}()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			if cfg.parentPID > 0 && cfg.parentPID != os.Getpid() && !processAlive(cfg.parentPID) {
				e.stop("Magpie exited")
				return
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() {
		idle := time.NewTicker(time.Minute)
		keepalive := time.NewTicker(30 * time.Minute)
		defer idle.Stop()
		defer keepalive.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-idle.C:
				if e.idleFor() > cfg.idle && e.beginIdle() {
					bounded, release := context.WithTimeout(ctx, 15*time.Second)
					_, _ = drv.Do(bounded, "stop", nil)
					release()
					e.endIdle()
				}
			case <-keepalive.C:
				for _, handle := range st.Handles() {
					wokenMu.Lock()
					due := time.Since(woken[handle]) >= 6*time.Hour
					wokenMu.Unlock()
					if !due || !e.acquire(handle) {
						continue
					}
					if acct, ok := st.Get(handle); ok {
						wokenMu.Lock()
						woken[handle] = time.Now()
						wokenMu.Unlock()
						bounded, release := context.WithTimeout(ctx, 60*time.Second)
						var kept struct {
							VMState string `json:"vmState"`
						}
						err := drv.Decode(bounded, "keep_alive", map[string]any{"account": acct}, &kept)
						release()
						if err != nil {
							log.Log("%s keepalive account=%s failed reason=%s", timeString(), handle, redact(err.Error()))
						} else {
							vmState := kept.VMState
							if vmState == "" {
								vmState = "?"
							}
							log.Log("%s keepalive account=%s vm=%s", timeString(), handle, vmState)
						}
					}
					e.setBusy(handle, false)
				}
			}
		}
	}()
	log.Log("muse-web engine %s listening on http://127.0.0.1:%d · %d accounts · data %s", version, cfg.port, st.Count(), cfg.dir)
	if cfg.prewarm && st.Count() > 0 {
		go func() {
			startedAt := time.Now()
			var group sync.WaitGroup
			for _, handle := range st.Handles() {
				acct, ok := st.Get(handle)
				if !ok {
					continue
				}
				group.Add(1)
				go func() {
					defer group.Done()
					bounded, release := context.WithTimeout(ctx, 3*time.Minute)
					defer release()
					if _, err := drv.Do(bounded, "warm", map[string]any{"account": acct}); err != nil {
						log.Log("%s warm account=%s failed reason=%s", timeString(), acct.ID, redact(err.Error()))
					}
				}()
			}
			group.Wait()
			warmDone := time.Now()
			accounts := make(chan account)
			var usage sync.WaitGroup
			for i := 0; i < prewarmUsageParallel; i++ {
				usage.Add(1)
				go func() {
					defer usage.Done()
					for acct := range accounts {
						if ctx.Err() == nil {
							e.readUsage(ctx, acct, 0)
						}
					}
				}()
			}
			for _, handle := range st.Handles() {
				acct, ok := st.Get(handle)
				if !ok {
					continue
				}
				select {
				case accounts <- acct:
				case <-ctx.Done():
				}
			}
			close(accounts)
			usage.Wait()
			log.Log("%s prewarm accounts=%d warm=%dms total=%dms", timeString(), st.Count(), warmDone.Sub(startedAt).Milliseconds(), time.Since(startedAt).Milliseconds())
		}()
	}
	err = server.Serve(listener)
	cancel()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func sameEngine(port int) bool {
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/health", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var body struct {
		Engine string `json:"engine"`
	}
	return res.StatusCode == 200 && json.NewDecoder(res.Body).Decode(&body) == nil && body.Engine == engineName
}
