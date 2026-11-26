// Accounts kept by the engine: handle → {cookies, cookies_exp}. Cookies never leave this file
// except into that account's own browser context and muse.ai requests.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"sort"
	"sync"
	"time"
)

type accountRecord struct {
	Cookies    map[string]string `json:"cookies"`
	CookiesExp map[string]int64  `json:"cookies_exp"`
	Label      string            `json:"label,omitempty"`
	Created    int64             `json:"created,omitempty"`
	VM         string            `json:"vm,omitempty"`
}

// account is the store's view of one entry: never the file's other fields.
type account struct {
	ID         string            `json:"id"`
	Label      string            `json:"label"`
	Cookies    map[string]string `json:"cookies"`
	CookiesExp map[string]int64  `json:"cookies_exp"`
}

type savedAccount struct {
	Handle  string  `json:"handle"`
	Expires *int64  `json:"expires"`
	Label   string  `json:"label"`
	Again   bool    `json:"again"`
	Account account `json:"account"`
}

type store struct {
	file string
	mu   sync.Mutex
	all  map[string]accountRecord
}

func newStore(file string) (*store, error) {
	s := &store{file: file, all: map[string]accountRecord{}}
	raw, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return s, nil
		}
		return nil, err
	}
	var parsed map[string]accountRecord
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("accounts.json: %w", err)
	}
	if parsed != nil {
		s.all = parsed
	}
	return s, nil
}

func (s *store) Get(handle string) (account, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.all[handle]
	if !ok || len(item.Cookies) == 0 {
		return account{}, false
	}
	return account{ID: handle, Label: item.Label, Cookies: maps.Clone(item.Cookies), CookiesExp: maps.Clone(item.CookiesExp)}, true
}

func (s *store) Handles() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.all))
	for handle := range s.all {
		out = append(out, handle)
	}
	sort.Strings(out)
	return out
}

func (s *store) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.all)
}

func (s *store) saveLocked(next map[string]accountRecord) error {
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := writePrivate(s.file, string(data)+"\n"); err != nil {
		return err
	}
	s.all = next
	return nil
}

// Add stores a fresh sign-in. vm is muse.ai's id for the account's VM, one per account: signing in
// again to an account already here renews that one, under its handle and name, instead of adding
// another. label is what Magpie shows; the sign-in time when muse.ai names no one.
func (s *store) Add(cookies map[string]string, exp map[string]int64, label, vm string) (savedAccount, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if exp == nil {
		exp = map[string]int64{}
	}
	cookies = maps.Clone(cookies)
	exp = maps.Clone(exp)
	next := maps.Clone(s.all)
	if vm != "" {
		for handle, item := range s.all {
			if item.VM != vm {
				continue
			}
			item.Cookies = cookies
			item.CookiesExp = exp
			next[handle] = item
			if err := s.saveLocked(next); err != nil {
				return savedAccount{}, err
			}
			return savedAccount{
				Handle:  handle,
				Expires: expiryMS(exp),
				Label:   item.Label,
				Again:   true,
				Account: account{ID: handle, Label: item.Label, Cookies: maps.Clone(cookies), CookiesExp: maps.Clone(exp)},
			}, nil
		}
	}
	handle, err := newHandle()
	if err != nil {
		return savedAccount{}, err
	}
	created := time.Now()
	name := label
	if name == "" {
		name = "muse.ai " + created.Format("2006-01-02 15:04") + " 登录"
	}
	next[handle] = accountRecord{Cookies: cookies, CookiesExp: exp, Label: name, Created: created.UnixMilli(), VM: vm}
	if err := s.saveLocked(next); err != nil {
		return savedAccount{}, err
	}
	return savedAccount{
		Handle:  handle,
		Expires: expiryMS(exp),
		Label:   name,
		Account: account{ID: handle, Label: name, Cookies: maps.Clone(cookies), CookiesExp: maps.Clone(exp)},
	}, nil
}

func (s *store) Update(handle string, cookies map[string]string, exp map[string]int64, vm string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.all[handle]
	if !ok {
		return nil
	}
	if cookies != nil {
		item.Cookies = maps.Clone(cookies)
	}
	if exp != nil {
		item.CookiesExp = maps.Clone(exp)
	}
	if vm != "" {
		item.VM = vm
	}
	next := maps.Clone(s.all)
	next[handle] = item
	return s.saveLocked(next)
}

func (s *store) Remove(handle string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.all[handle]; !ok {
		return nil
	}
	next := maps.Clone(s.all)
	delete(next, handle)
	return s.saveLocked(next)
}

func newHandle() (string, error) {
	suffix, err := randomHex(6)
	if err != nil {
		return "", err
	}
	return "muse-" + suffix, nil
}

// expiryMS is the session cookie that decides when the sign-in ends, in milliseconds.
func expiryMS(exp map[string]int64) *int64 {
	pos := func(v int64) int64 {
		if v > 0 {
			return v
		}
		return 0
	}
	if v := pos(exp["hatch_vml"]); v > 0 {
		ms := v * 1000
		return &ms
	}
	var least int64
	for _, name := range essentialCookies {
		if v := pos(exp[name]); v > 0 && (least == 0 || v < least) {
			least = v
		}
	}
	if least > 0 {
		ms := least * 1000
		return &ms
	}
	return nil
}
