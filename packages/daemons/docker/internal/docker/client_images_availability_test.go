package docker

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/moby/moby/api/pkg/authconfig"
	"github.com/moby/moby/client"
)

func TestImageRepositoryRemovesTagButPreservesRegistryPort(t *testing.T) {
	tests := map[string]string{
		"127.0.0.1:5443/gateway/availability/policy/1/2:image": "127.0.0.1:5443/gateway/availability/policy/1/2",
		"registry.example/acme/api:latest":                     "registry.example/acme/api",
		"registry.example/acme/api@sha256:abc":                 "registry.example/acme/api",
		"ubuntu":                                               "ubuntu",
	}
	for input, expected := range tests {
		if actual := imageRepository(input); actual != expected {
			t.Fatalf("imageRepository(%q) = %q, want %q", input, actual, expected)
		}
	}
}

func TestMirrorImageSendsAnonymousRegistryAuthHeader(t *testing.T) {
	const (
		sourceRef = "nginx:1.29-alpine"
		targetRef = "127.0.0.1:5443/gateway/availability/policy/image:test"
		digest    = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	)
	pushSeen := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/"+sourceRef+"/json"):
			_, _ = w.Write([]byte(`{"Id":"sha256:source","Os":"linux","Architecture":"amd64","Size":123}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/sha256:source/tag"):
			w.WriteHeader(http.StatusCreated)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/127.0.0.1:5443/gateway/availability/policy/image/push"):
			pushSeen = true
			encoded := r.Header.Get("X-Registry-Auth")
			if encoded == "" {
				t.Error("mirror push omitted X-Registry-Auth")
			} else if decoded, err := authconfig.Decode(encoded); err != nil {
				t.Errorf("decode anonymous registry auth: %v", err)
			} else if decoded.Username != "" || decoded.Password != "" || decoded.IdentityToken != "" || decoded.RegistryToken != "" {
				t.Errorf("anonymous registry auth contains credentials: %#v", decoded)
			}
			_, _ = w.Write([]byte("{\"status\":\"pushed\"}\n"))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/images/"+targetRef+"/json"):
			_, _ = w.Write([]byte(`{"Id":"sha256:source","RepoDigests":["127.0.0.1:5443/gateway/availability/policy/image@` + digest + `"],"Os":"linux","Architecture":"amd64","Size":123}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dockerAPI, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create Docker client: %v", err)
	}
	defer dockerAPI.Close()

	mirrored, err := (&Client{cli: dockerAPI, logger: slog.Default()}).MirrorImage(context.Background(), sourceRef, targetRef, "")
	if err != nil {
		t.Fatalf("mirror image: %v", err)
	}
	if !pushSeen {
		t.Fatal("mirror image did not push the tagged image")
	}
	if mirrored.Reference != "127.0.0.1:5443/gateway/availability/policy/image@"+digest {
		t.Fatalf("mirrored reference = %q", mirrored.Reference)
	}
}

func TestTagImageCreatesLocalAliasFromImmutableArtifact(t *testing.T) {
	const (
		sourceRef = "127.0.0.1:5443/gateway/availability/policy/image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		targetRef = "example/api:v1"
	)
	tagSeen := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/images/") && strings.HasSuffix(r.URL.Path, "/json"):
			_, _ = w.Write([]byte(`{"Id":"sha256:source"}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/images/sha256:source/tag"):
			tagSeen = true
			w.WriteHeader(http.StatusCreated)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	dockerAPI, err := client.NewClientWithOpts(client.WithHost(server.URL), client.WithVersion("1.43"))
	if err != nil {
		t.Fatalf("create Docker client: %v", err)
	}
	defer dockerAPI.Close()

	if err := (&Client{cli: dockerAPI, logger: slog.Default()}).TagImage(context.Background(), sourceRef, targetRef); err != nil {
		t.Fatalf("tag image: %v", err)
	}
	if !tagSeen {
		t.Fatal("image tag endpoint was not called")
	}
}
