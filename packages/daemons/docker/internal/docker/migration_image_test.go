package docker

import (
	"reflect"
	"strings"
	"testing"
)

func TestRestorableMigrationImageTags(t *testing.T) {
	digestRef := "127.0.0.1:5443/gateway/builds/source@sha256:" + strings.Repeat("a", 64)
	got := restorableMigrationImageTags([]string{
		"registry.example.com/acme/api:latest",
		digestRef,
		"<none>:<none>",
		"registry.example.com/acme/api:latest",
		"  registry.example.com/acme/api:v2  ",
	})
	want := []string{
		"registry.example.com/acme/api:latest",
		"registry.example.com/acme/api:v2",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("restorable tags = %#v, want %#v", got, want)
	}
}
