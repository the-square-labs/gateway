package docker

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	mobyclient "github.com/moby/moby/client"
)

// fakeImageEngine is a minimal Docker Engine API for image resolution: exact
// reference inspect, reference-filtered list and pull by name+digest.
type fakeImageEngine struct {
	mu      sync.Mutex
	present map[string]bool
	failing map[string]bool
	pulls   []string
	other   func(w http.ResponseWriter, r *http.Request) bool
}

func newFakeImageEngine() *fakeImageEngine {
	return &fakeImageEngine{present: map[string]bool{}, failing: map[string]bool{}}
}

func (e *fakeImageEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	path := r.URL.Path
	if index := strings.Index(path, "/images/"); index >= 0 {
		path = path[index:]
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && path == "/images/json":
		_, _ = w.Write([]byte(`[]`))
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
		name, _ := url.PathUnescape(strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json"))
		if !e.present[name] {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"No such image: ` + name + `"}`))
			return
		}
		_, _ = w.Write([]byte(`{"Id":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`))
	case r.Method == http.MethodPost && path == "/images/create":
		reference := r.URL.Query().Get("fromImage") + "@" + r.URL.Query().Get("tag")
		e.pulls = append(e.pulls, reference)
		if e.failing[reference] {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"manifest for ` + reference + ` not found"}`))
			return
		}
		e.present[reference] = true
		_, _ = w.Write([]byte(`{"status":"Digest: ` + r.URL.Query().Get("tag") + `"}` + "\n"))
	default:
		if e.other != nil && e.other(w, r) {
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"unexpected request ` + r.Method + " " + r.URL.Path + `"}`))
	}
}

func newFakeImageClient(t *testing.T, engine http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(engine)
	t.Cleanup(server.Close)
	cli, err := mobyclient.NewClientWithOpts(mobyclient.WithHost(server.URL), mobyclient.WithVersion("1.47"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cli.Close() })
	return &Client{cli: cli, logger: slog.Default()}
}

const testPostgresUpstream = "docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"

func TestThirdPartyMirrorAllowListMatchesReleaseList(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "..", "config", "third-party-images.json")
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		t.Skip("release image list is outside this checkout")
	}
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		MirrorRepository string `json:"mirrorRepository"`
		Images           []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"images"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	if list.MirrorRepository != thirdPartyMirrorRepository {
		t.Fatalf("mirror repository = %q, daemon uses %q", list.MirrorRepository, thirdPartyMirrorRepository)
	}
	listed := map[string]struct{}{}
	for _, image := range list.Images {
		listed[image.Source] = struct{}{}
		mirror, ok := thirdPartyMirrorReference(image.Source)
		if !ok {
			t.Fatalf("daemon allow-list misses %s", image.Source)
		}
		digest := image.Source[strings.Index(image.Source, "@"):]
		if want := thirdPartyMirrorRepository + "/" + image.Name + digest; mirror != want {
			t.Fatalf("mirror of %s = %s, release pipeline pushes %s", image.Source, mirror, want)
		}
	}
	for source := range thirdPartyMirroredImages {
		if _, ok := listed[source]; !ok {
			t.Fatalf("daemon allow-lists %s, which the release pipeline does not mirror", source)
		}
	}
}

func TestThirdPartyImageCandidatesTryMirrorThenUpstream(t *testing.T) {
	mirror := "ghcr.io/the-square-labs/gateway/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a"
	if got := thirdPartyImageCandidates(testPostgresUpstream); !reflect.DeepEqual(got, []string{mirror, testPostgresUpstream}) {
		t.Fatalf("upstream candidates = %v", got)
	}
	if got := thirdPartyImageCandidates(mirror); !reflect.DeepEqual(got, []string{mirror, testPostgresUpstream}) {
		t.Fatalf("mirror candidates = %v", got)
	}
	seaweed := thirdPartyImageCandidates(seaweedfsUpstreamImage)
	if len(seaweed) != 2 || seaweed[0] != "ghcr.io/the-square-labs/gateway/seaweedfs@"+seaweedfsImageDigest || seaweed[1] != seaweedfsUpstreamImage {
		t.Fatalf("SeaweedFS candidates = %v", seaweed)
	}
	for _, unlisted := range []string{
		"docker.io/library/postgres@sha256:" + strings.Repeat("a", 64),
		"registry.example/tools/compose@sha256:" + strings.Repeat("b", 64),
		"ghcr.io/the-square-labs/gateway/postgres@sha256:" + strings.Repeat("c", 64),
	} {
		if got := thirdPartyImageCandidates(unlisted); !reflect.DeepEqual(got, []string{unlisted}) {
			t.Fatalf("unlisted %s candidates = %v", unlisted, got)
		}
	}
	if !isCuratedDigestImage("postgres", mirror) || !isCuratedDigestImage("postgres", testPostgresUpstream) {
		t.Fatal("curated PostgreSQL image or its GHCR mirror was rejected")
	}
	if isCuratedDigestImage("redis", mirror) {
		t.Fatal("PostgreSQL mirror accepted as a Redis image")
	}
	if isCuratedDigestImage("postgres", "ghcr.io/the-square-labs/gateway/postgres@sha256:"+strings.Repeat("d", 64)) {
		t.Fatal("unlisted mirror digest accepted as curated")
	}
}

func TestEnsureThirdPartyImagePullsMirrorFirst(t *testing.T) {
	engine := newFakeImageEngine()
	client := newFakeImageClient(t, engine)
	reference, err := client.EnsureThirdPartyImage(context.Background(), testPostgresUpstream)
	if err != nil {
		t.Fatal(err)
	}
	mirror, _ := thirdPartyMirrorReference(testPostgresUpstream)
	if reference != mirror || !reflect.DeepEqual(engine.pulls, []string{mirror}) {
		t.Fatalf("resolved %s after pulls %v, want the mirror only", reference, engine.pulls)
	}
}

func TestEnsureThirdPartyImageFallsBackToUpstream(t *testing.T) {
	engine := newFakeImageEngine()
	mirror, _ := thirdPartyMirrorReference(testPostgresUpstream)
	engine.failing[mirror] = true
	client := newFakeImageClient(t, engine)
	reference, err := client.EnsureThirdPartyImage(context.Background(), testPostgresUpstream)
	if err != nil {
		t.Fatal(err)
	}
	if reference != testPostgresUpstream || !reflect.DeepEqual(engine.pulls, []string{mirror, testPostgresUpstream}) {
		t.Fatalf("resolved %s after pulls %v", reference, engine.pulls)
	}
}

func TestEnsureThirdPartyImageUsesLocalCopyWithoutPulling(t *testing.T) {
	engine := newFakeImageEngine()
	engine.present[testPostgresUpstream] = true
	client := newFakeImageClient(t, engine)
	reference, err := client.EnsureThirdPartyImage(context.Background(), testPostgresUpstream)
	if err != nil {
		t.Fatal(err)
	}
	if reference != testPostgresUpstream || len(engine.pulls) != 0 {
		t.Fatalf("existing node re-pulled: %s %v", reference, engine.pulls)
	}
}

func TestEnsureThirdPartyImageReportsEveryAttempt(t *testing.T) {
	engine := newFakeImageEngine()
	mirror, _ := thirdPartyMirrorReference(testPostgresUpstream)
	engine.failing[mirror] = true
	engine.failing[testPostgresUpstream] = true
	client := newFakeImageClient(t, engine)
	_, err := client.EnsureThirdPartyImage(context.Background(), testPostgresUpstream)
	var pullErr *thirdPartyImagePullError
	if !errors.As(err, &pullErr) || len(pullErr.Attempts) != 2 || pullErr.Attempts[0].Reference != mirror || pullErr.Attempts[1].Reference != testPostgresUpstream {
		t.Fatalf("pull error = %#v", err)
	}
	unlisted := "registry.example/tools/compose@sha256:" + strings.Repeat("b", 64)
	engine.failing[unlisted] = true
	engine.pulls = nil
	if _, err := client.EnsureThirdPartyImage(context.Background(), unlisted); err == nil || !reflect.DeepEqual(engine.pulls, []string{unlisted}) {
		t.Fatalf("unlisted image pulls = %v err = %v", engine.pulls, err)
	}
}
