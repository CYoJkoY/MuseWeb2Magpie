package main

import "testing"

// healthProof must stay byte-for-byte identical to engine/health.ts's healthProof; these vectors
// are the same ones the TypeScript side can reproduce, so a drift between the two breaks the test.
func TestHealthProof(t *testing.T) {
	for _, spec := range []struct {
		key, nonce, want string
	}{
		{"k", "abcdefgh", "bb528925cff297092538a0694382252e434faf0718293d42e083ee6fc506187a"},
		{"key123", "nonce-0123456789", "5f3cc3ead7acb81a22571114263c6d9f8cad7a5323d5bfd9b632db306bd6df50"},
	} {
		if got := healthProof(spec.key, spec.nonce); got != spec.want {
			t.Errorf("healthProof(%q, %q) = %q, want %q", spec.key, spec.nonce, got, spec.want)
		}
	}
	// A different key or a different nonce must change the answer, or it proves nothing.
	if healthProof("k", "abcdefgh") == healthProof("k2", "abcdefgh") {
		t.Error("proof does not depend on the key")
	}
	if healthProof("k", "abcdefgh") == healthProof("k", "abcdefgi") {
		t.Error("proof does not depend on the nonce")
	}
}

func TestValidNonce(t *testing.T) {
	// 8 is the minimum; mixed case, digits, dash and underscore are all allowed.
	for _, nonce := range []string{"abcdefgh", "ABCDEFGH0123456789-_"} {
		if !validNonce(nonce) {
			t.Errorf("validNonce(%q) = false, want true", nonce)
		}
	}
	// Exactly 64 is the largest allowed.
	if !validNonce("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") {
		t.Error("64-char nonce rejected")
	}
	for _, nonce := range []string{
		"",        // empty
		"abcdefg", // 7, too short
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0", // 65, too long
		"abcdefg ", // trailing space
		"abc/defg", // disallowed character
		"abc.defg", // disallowed character
	} {
		if validNonce(nonce) {
			t.Errorf("validNonce(%q) = true, want false", nonce)
		}
	}
}
