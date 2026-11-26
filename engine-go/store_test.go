package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func TestStoreRoundTrip(t *testing.T) {
	file := filepath.Join(t.TempDir(), "accounts.json")
	st, err := newStore(file)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.Add(map[string]string{"hatch_sess": "a"}, map[string]int64{"hatch_vml": 1900000000}, "", "vm-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(first.Label, "muse.ai ") || !strings.HasSuffix(first.Label, " 登录") {
		t.Fatal(first.Label)
	}
	if first.Expires == nil || *first.Expires != 1900000000000 {
		t.Fatal(first.Expires)
	}
	again, err := st.Add(map[string]string{"hatch_sess": "b"}, nil, "new label", "vm-1")
	if err != nil {
		t.Fatal(err)
	}
	if !again.Again || again.Handle != first.Handle || again.Label != first.Label {
		t.Fatalf("renewal: %+v", again)
	}
	second, err := st.Add(map[string]string{"hatch_sess": "c"}, nil, "a@b.c", "vm-2")
	if err != nil {
		t.Fatal(err)
	}
	if second.Handle == first.Handle || second.Label != "a@b.c" || st.Count() != 2 {
		t.Fatal(second)
	}
	loaded, err := newStore(file)
	if err != nil {
		t.Fatal(err)
	}
	acct, ok := loaded.Get(first.Handle)
	if !ok || acct.Cookies["hatch_sess"] != "b" {
		t.Fatal(acct)
	}
	acct.Cookies["hatch_sess"] = "external mutation"
	copy, _ := loaded.Get(first.Handle)
	if copy.Cookies["hatch_sess"] != "b" {
		t.Fatal("store aliases caller maps")
	}
	if err := loaded.Update(first.Handle, map[string]string{"hatch_sess": "renewed"}, nil, ""); err != nil {
		t.Fatal(err)
	}
	if err := loaded.Remove(second.Handle); err != nil {
		t.Fatal(err)
	}
	if loaded.Count() != 1 {
		t.Fatal(loaded.Count())
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 {
			t.Fatal(info.Mode())
		}
	}
}

func TestStoreFailedSavePreservesMemory(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.Add(map[string]string{"hatch_sess": "a"}, nil, "first", "vm")
	if err != nil {
		t.Fatal(err)
	}
	st.file = t.TempDir()
	if err := st.Update(first.Handle, map[string]string{"hatch_sess": "b"}, nil, ""); err == nil {
		t.Fatal("expected save failure")
	}
	acct, _ := st.Get(first.Handle)
	if acct.Cookies["hatch_sess"] != "a" {
		t.Fatal(acct)
	}
	if err := st.Remove(first.Handle); err == nil {
		t.Fatal("expected remove failure")
	}
	if st.Count() != 1 {
		t.Fatal("failed save changed memory")
	}
}

func TestStoreRejectsCorruptFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "accounts.json")
	if err := os.WriteFile(file, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newStore(file); err == nil {
		t.Fatal("corrupt file accepted")
	}
}

func TestStoreConcurrentWrites(t *testing.T) {
	st, err := newStore(filepath.Join(t.TempDir(), "accounts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for index := 0; index < 12; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, err := st.Add(map[string]string{"hatch_sess": "a"}, nil, "", ""); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	loaded, err := newStore(st.file)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Count() != 12 {
		t.Fatal(loaded.Count())
	}
}
