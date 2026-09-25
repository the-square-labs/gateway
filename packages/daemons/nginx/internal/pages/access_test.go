package pages

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const accessListID = "44444444-4444-4444-8444-444444444444"

func accessRuntime(t *testing.T) (*Runtime, string) {
	t.Helper()
	runtime, _ := newRuntime(t)
	htpasswd := filepath.Join(t.TempDir(), "htpasswd")
	if err := os.MkdirAll(htpasswd, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := runtime.SetHtpasswdDir(htpasswd); err != nil {
		t.Fatal(err)
	}
	stageRelease(t, runtime)
	return runtime, htpasswd
}

func TestPreviewAccessRendersProxyHostDirectivesAtServerLevel(t *testing.T) {
	runtime, htpasswd := accessRuntime(t)
	if err := os.WriteFile(filepath.Join(htpasswd, "access-list-"+accessListID), []byte("ops:$2y$10$hash\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	access := &PreviewAccess{
		AccessListID: accessListID,
		IPRules:      []PreviewIPRule{{Type: "allow", Value: "10.0.0.0/8"}, {Type: "deny", Value: "192.0.2.7"}},
		BasicAuth:    true,
	}
	if err := runtime.MaterializePreview(profileID, deploymentID, "abc-main.pages.example", "", "", PreviewFallback{Access: access}); err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(runtime.previewConfigPath("abc-main.pages.example"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"    server_name abc-main.pages.example;",
		"    allow 10.0.0.0/8;",
		"    deny 192.0.2.7;",
		"    deny all;",
		"    auth_basic \"Restricted Access\";",
		"    auth_basic_user_file " + filepath.Join(htpasswd, "access-list-"+accessListID) + ";",
		"    root ",
	}, "\n")
	if !strings.Contains(string(config), want) {
		t.Fatalf("access directives are missing or out of order:\n%s", config)
	}
	// Server-level directives cover the runtime config script and assets too:
	// no location may re-open access with its own allow/auth_basic off.
	if strings.Contains(string(config), "auth_basic off") || strings.Count(string(config), "allow ") != 1 {
		t.Fatalf("unexpected per-location access override:\n%s", config)
	}
}

func TestPreviewAccessIPOnlyAndPublicPreviewsStayUnchanged(t *testing.T) {
	runtime, _ := accessRuntime(t)
	ipOnly := &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "2001:db8::/32"}}}
	if err := runtime.MaterializePreview(profileID, deploymentID, "ip.pages.example", "", "", PreviewFallback{Access: ipOnly}); err != nil {
		t.Fatal(err)
	}
	config, _ := os.ReadFile(runtime.previewConfigPath("ip.pages.example"))
	if !strings.Contains(string(config), "    allow 2001:db8::/32;\n    deny all;\n") || strings.Contains(string(config), "auth_basic") {
		t.Fatalf("IP-only access list rendered incorrectly:\n%s", config)
	}

	if err := runtime.MaterializePreview(profileID, deploymentID, "public.pages.example", "", ""); err != nil {
		t.Fatal(err)
	}
	public, _ := os.ReadFile(runtime.previewConfigPath("public.pages.example"))
	if strings.Contains(string(public), "deny all;\n    root") || strings.Contains(string(public), "auth_basic") {
		t.Fatalf("public preview must not render access directives:\n%s", public)
	}
}

func TestPreviewAccessFailsClosed(t *testing.T) {
	runtime, _ := accessRuntime(t)
	cases := map[string]*PreviewAccess{
		"missing credentials": {AccessListID: accessListID, BasicAuth: true},
		"invalid list id":     {AccessListID: "../../etc/passwd", IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1"}}},
		"invalid rule type":   {AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "permit", Value: "10.0.0.1"}}},
		"injected address":    {AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1; return 200"}}},
		"not an address":      {AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "example.com"}}},
	}
	for name, access := range cases {
		t.Run(name, func(t *testing.T) {
			hostname := "closed.pages.example"
			if err := runtime.MaterializePreview(profileID, deploymentID, hostname, "", "", PreviewFallback{Access: access}); err == nil {
				t.Fatal("expected access validation failure")
			}
			if _, err := os.Stat(runtime.previewConfigPath(hostname)); !os.IsNotExist(err) {
				t.Fatalf("rejected access list must not publish a preview: %v", err)
			}
		})
	}
}

func TestBindingInspectionComparesPreviewAccess(t *testing.T) {
	r, _, bindings := inspectionFixture(t)
	preview := bindings[1]
	if got := r.InspectBindings([]BindingExpectation{preview}); !reflect.DeepEqual(got.Matches, []bool{true}) {
		t.Fatalf("baseline inspection: %#v", got)
	}
	protected := preview
	protected.Access = &PreviewAccess{AccessListID: accessListID, IPRules: []PreviewIPRule{{Type: "allow", Value: "10.0.0.1"}}}
	if got := r.InspectBindings([]BindingExpectation{protected}); !reflect.DeepEqual(got.Matches, []bool{false}) {
		t.Fatalf("a newly attached access list must force re-materialization: %#v", got)
	}
	if err := r.MaterializePreview(profileID, deploymentID, preview.ID, "", "", PreviewFallback{Access: protected.Access}); err != nil {
		t.Fatal(err)
	}
	if got := r.InspectBindings([]BindingExpectation{protected}); !reflect.DeepEqual(got.Matches, []bool{true}) {
		t.Fatalf("protected inspection: %#v", got)
	}
	encoded, err := json.Marshal(protected)
	if err != nil || !strings.Contains(string(encoded), `"access":{"accessListId":"`+accessListID+`"`) {
		t.Fatalf("expectation JSON shape changed: %s %v", encoded, err)
	}
}
