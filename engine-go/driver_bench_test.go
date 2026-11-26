package main

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

// The driver protocol is one JSON object per line on a pipe. These benchmarks cover the costs
// that dominate a chat: decoding every streamed line, encoding the request that starts one, and
// the store lookup each HTTP request begins with.

var deltaLine = []byte(`{"id":"r7","ev":"delta","text":"这是一个较长的中文片段，代表真实流式输出里的一个分块。"}`)

var finalLine = []byte(`{"id":"r7","ev":"final","content":"回答结束","tools":"","calls":[{"name":"read_file","arguments":"{\"path\":\"C:\\\\Users\\\\Admin\\\\notes.md\"}"}],"how":"same","sent":"clicked","tabMs":420,"firstMs":980}`)

var benchChatEnvelope = map[string]any{
	"id": "r9",
	"op": "chat_stream",
	"params": map[string]any{
		"account": map[string]any{
			"id":          "9f2c",
			"label":       "muse.ai 登录",
			"cookies":     map[string]string{"hatch_sess": "sess-value", "hatch_vml": "vml-value"},
			"cookies_exp": map[string]int64{"hatch_vml": 1900000000},
		},
		"messages":     json.RawMessage(`[{"role":"system","content":"你是助手"},{"role":"user","content":"帮我总结这个文件"}]`),
		"tools":        `[{"type":"function","function":{"name":"read_file","description":"读文件","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}]`,
		"tool_choice":  "auto",
		"conversation": "sess-1",
		"stream":       true,
	},
}

func BenchmarkEventDecodeDelta(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		var ev event
		if err := json.Unmarshal(deltaLine, &ev); err != nil {
			b.Fatal(err)
		}
		if ev.Text == "" {
			b.Fatal("empty delta")
		}
	}
}

func BenchmarkEventDecodeFinal(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		var ev event
		if err := json.Unmarshal(finalLine, &ev); err != nil {
			b.Fatal(err)
		}
		if len(ev.Calls) != 1 {
			b.Fatal("missing call")
		}
	}
}

func BenchmarkRequestEncodeChat(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		line, err := json.Marshal(benchChatEnvelope)
		if err != nil {
			b.Fatal(err)
		}
		if len(line) == 0 {
			b.Fatal("empty request")
		}
	}
}

func BenchmarkStoreGet(b *testing.B) {
	st, err := newStore(filepath.Join(b.TempDir(), "accounts.json"))
	if err != nil {
		b.Fatal(err)
	}
	saved, err := st.Add(map[string]string{"hatch_sess": "a", "hatch_vml": "b"}, map[string]int64{"hatch_vml": 1900000000}, "", "vm")
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := st.Get(saved.Handle); !ok {
			b.Fatal("missing account")
		}
	}
}
