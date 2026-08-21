package config

import "testing"

func TestRelayMode(t *testing.T) {
	for _, test := range []struct {
		value string
		want  Mode
		ok    bool
	}{
		{"", ModeLocalCombined, true},
		{"local", ModeLocalCombined, true},
		{"remote", ModeRemoteDataOnly, true},
		{"other", "", false},
	} {
		got, err := relayMode(test.value)
		if (err == nil) != test.ok || got != test.want {
			t.Fatalf("relayMode(%q) = %q, %v", test.value, got, err)
		}
	}
}
