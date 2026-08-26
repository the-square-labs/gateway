package docker

import "testing"

func TestMigrationStreamEnabled(t *testing.T) {
	tests := []struct {
		name    string
		mode    string
		enabled bool
	}{
		{name: "runtime", mode: "docker", enabled: true},
		{name: "database profile", mode: "databases", enabled: false},
		{name: "builder profile", mode: "builder", enabled: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := migrationStreamEnabled(tt.mode); got != tt.enabled {
				t.Fatalf("migrationStreamEnabled(%q) = %v, want %v", tt.mode, got, tt.enabled)
			}
		})
	}
}
