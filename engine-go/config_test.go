package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestDataDir(t *testing.T) {
	for _, spec := range []struct {
		goos, home string
		env        map[string]string
		expected   string
	}{
		{"darwin", "/Users/a", nil, filepath.Join("/Users/a", "Library", "Application Support", "muse-web")},
		{"windows", "C:/Users/a", map[string]string{"APPDATA": "C:/roaming"}, filepath.Join("C:/roaming", "muse-web")},
		{"linux", "/home/a", nil, filepath.Join("/home/a", ".local", "share", "muse-web")},
		{"linux", "/home/a", map[string]string{"XDG_DATA_HOME": "/x"}, filepath.Join("/x", "muse-web")},
		{"linux", "/home/a", map[string]string{"MUSE_WEB_HOME": "/own"}, "/own"},
	} {
		actual := resolveDataDir(func(key string) string { return spec.env[key] }, spec.goos, spec.home)
		if actual != spec.expected {
			t.Errorf("%s: %q != %q", spec.goos, actual, spec.expected)
		}
	}
}

func TestPort(t *testing.T) {
	for _, value := range []string{"", "0", "65536", "-1", "wat"} {
		if resolvePort(func(string) string { return value }) != defaultPort {
			t.Fatal(value)
		}
	}
	if resolvePort(func(string) string { return " 12345 " }) != 12345 {
		t.Fatal("valid port")
	}
}

func TestExclusiveEngineKey(t *testing.T) {
	dir := t.TempDir()
	var group sync.WaitGroup
	keys := make(chan string, 16)
	for index := 0; index < cap(keys); index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			key, err := engineKey(dir)
			if err != nil {
				t.Error(err)
				return
			}
			keys <- key
		}()
	}
	group.Wait()
	close(keys)
	want := ""
	for key := range keys {
		if len(key) != 48 {
			t.Fatal(key)
		}
		if want == "" {
			want = key
		}
		if key != want {
			t.Fatal("concurrent engines installed different keys")
		}
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, "engine.key"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatal(info.Mode())
		}
	}
}

func TestErrorMappingAndEscaping(t *testing.T) {
	for _, spec := range []struct {
		text, code string
		retry      float64
	}{
		{"VM warming", "vm_warming", 10}, {"页面没有加载", "page_unavailable", 10},
		{"TIMEOUT", "upstream_timeout", 5}, {"没有发出去", "send_failed", 2}, {"other", "engine_unavailable", 5},
	} {
		code, retry := generationCode(spec.text)
		if code != spec.code || retry != spec.retry {
			t.Fatal(spec, code, retry)
		}
	}
	if redact("Bearer test-token hatch_sess=private") != "Bearer *** hatch_sess=***" {
		t.Fatal("redaction")
	}
	state, _ := json.Marshal(map[string]string{"status": "failed", "error": "<script>alert(1)</script>"})
	if strings.Contains(loginPage(state), "<script>") {
		t.Fatal("unescaped login error")
	}
}
