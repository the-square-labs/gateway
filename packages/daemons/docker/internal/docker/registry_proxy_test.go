package docker

import (
	"net/http"
	"net/url"
	"testing"
)

func TestRegistryRuntimeBindingsArePullOnly(t *testing.T) {
	if _, err := validateRegistryBindingActions("runtime", []string{"pull"}); err != nil {
		t.Fatalf("runtime pull was rejected: %v", err)
	}
	if _, err := validateRegistryBindingActions("runtime", []string{"pull", "push"}); err == nil {
		t.Fatal("runtime push was accepted")
	}
	if _, err := validateRegistryBindingActions("builder", []string{"pull", "push"}); err != nil {
		t.Fatalf("builder push/pull was rejected: %v", err)
	}
	if _, err := validateRegistryBindingActions("mirror", []string{"pull", "push"}); err != nil {
		t.Fatalf("availability mirror push/pull was rejected: %v", err)
	}
	if _, err := validateRegistryBindingActions("builder", []string{"delete"}); err == nil {
		t.Fatal("unsupported delete action was accepted")
	}
}

func TestRegistryBindingRoleMatchesDaemonProfile(t *testing.T) {
	if err := validateRegistryBindingProfile("builder", "builder"); err != nil {
		t.Fatalf("builder binding was rejected: %v", err)
	}
	if err := validateRegistryBindingProfile("builder", "runtime"); err == nil {
		t.Fatal("builder profile accepted a runtime binding")
	}
	if err := validateRegistryBindingProfile("", "runtime"); err != nil {
		t.Fatalf("runtime binding was rejected: %v", err)
	}
	if err := validateRegistryBindingProfile("", "mirror"); err != nil {
		t.Fatalf("availability mirror binding was rejected: %v", err)
	}
	if err := validateRegistryBindingProfile("builder", "mirror"); err == nil {
		t.Fatal("builder profile accepted an availability mirror binding")
	}
	if err := validateRegistryBindingProfile("", "builder"); err == nil {
		t.Fatal("runtime profile accepted a builder binding")
	}
}

func TestRegistryRequestScopeIsRepositoryExact(t *testing.T) {
	tests := []struct {
		method     string
		path       string
		repository string
		action     string
		allowed    bool
	}{
		{http.MethodGet, "/v2/", "", "pull", true},
		{http.MethodGet, "/v2/acme/api/manifests/sha256:abc", "acme/api", "pull", true},
		{http.MethodHead, "/v2/acme/api/blobs/sha256:abc", "acme/api", "pull", true},
		{http.MethodPost, "/v2/acme/api/blobs/uploads/", "acme/api", "push", true},
		{http.MethodPatch, "/v2/acme/api/blobs/uploads/id", "acme/api", "push", true},
		{http.MethodPut, "/v2/acme/api/manifests/main", "acme/api", "push", true},
		{http.MethodDelete, "/v2/acme/api/manifests/main", "", "", false},
		{http.MethodGet, "/v2/_catalog", "", "", false},
		{http.MethodGet, "/metrics", "", "", false},
		{http.MethodGet, "/v2/Acme/api/manifests/main", "", "", false},
	}
	for _, test := range tests {
		repository, action, allowed := registryRequestScope(test.method, test.path)
		if repository != test.repository || action != test.action || allowed != test.allowed {
			t.Fatalf("%s %s = (%q, %q, %t), want (%q, %q, %t)", test.method, test.path, repository, action, allowed, test.repository, test.action, test.allowed)
		}
	}
}

func TestRegistryLocationRewritesOnlyTheInternalUploadEndpoint(t *testing.T) {
	internal := "http://registry.internal/v2/acme/api/blobs/uploads/id?_state=opaque"
	if actual := rewriteRegistryLocation(internal); actual != "https://127.0.0.1:5443/v2/acme/api/blobs/uploads/id?_state=opaque" {
		t.Fatalf("internal registry location = %q", actual)
	}
	for _, value := range []string{
		"/v2/acme/api/blobs/uploads/id",
		"https://registry.internal/v2/acme/api/blobs/uploads/id",
		"http://registry.internal:5001/v2/acme/api/blobs/uploads/id",
		"http://example.com/v2/acme/api/blobs/uploads/id",
	} {
		if actual := rewriteRegistryLocation(value); actual != value {
			t.Fatalf("untrusted location %q was rewritten to %q", value, actual)
		}
	}
}

func TestRegistryProxyRemovesCrossRepositoryBlobMounts(t *testing.T) {
	query := url.Values{
		"mount":  {"sha256:abc"},
		"from":   {"gateway/builds/other"},
		"digest": {"sha256:def"},
	}
	actual := sanitizeRegistryProxyQuery(http.MethodPost, "/v2/gateway/builds/current/blobs/uploads/", query)
	if actual.Get("mount") != "" || actual.Get("from") != "" {
		t.Fatalf("cross-repository mount parameters survived: %v", actual)
	}
	if actual.Get("digest") != "sha256:def" {
		t.Fatalf("unrelated upload parameter was removed: %v", actual)
	}
	if query.Get("mount") != "sha256:abc" || query.Get("from") != "gateway/builds/other" {
		t.Fatalf("input query was mutated: %v", query)
	}

	untouched := sanitizeRegistryProxyQuery(http.MethodGet, "/v2/gateway/builds/current/blobs/sha256:abc", query)
	if untouched.Get("mount") != "sha256:abc" || untouched.Get("from") != "gateway/builds/other" {
		t.Fatalf("non-upload query was changed: %v", untouched)
	}
}
