package daemon

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	daemonconfig "github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/pages"
)

func TestPagesCapabilityRequiresCompleteRuntimeInitialization(t *testing.T) {
	plugin := &NginxPlugin{}
	if hasCapability(plugin.capabilities(), "nginx_pages_v1") {
		t.Fatal("Pages capability advertised without a initialized v1 runtime")
	}
	runtime, err := pages.New(filepath.Join(t.TempDir(), "pages"), filepath.Join(t.TempDir(), "conf"), filepath.Join(t.TempDir(), "certs"), pagesNginx{})
	if err != nil {
		t.Fatal(err)
	}
	plugin.pagesRuntime = runtime
	// The runtime pointer alone is insufficient. Init sets this flag only after
	// the confined root has passed storage preflight and all v1 handlers exist.
	if hasCapability(plugin.capabilities(), "nginx_pages_v1") {
		t.Fatal("Pages capability advertised before v1 preflight")
	}
	plugin.pagesV1Available = true
	if !hasCapability(plugin.capabilities(), "nginx_pages_v1") {
		t.Fatal("Pages capability missing after complete v1 runtime initialization")
	}
	if hasCapability(plugin.capabilities(), "nginx_pages_config_v1") {
		t.Fatal("runtime config capability advertised without http_sub_module preflight")
	}
	plugin.pagesRuntimeConfigAvailable = true
	if !hasCapability(plugin.capabilities(), "nginx_pages_config_v1") {
		t.Fatal("runtime config capability missing after complete preflight")
	}
}

func TestNginxBuildOutputRequiresSubFilterModule(t *testing.T) {
	if nginxBuildOutputHasSubFilter([]byte("configure arguments: --with-http_ssl_module")) {
		t.Fatal("sub-filter preflight accepted a build without the module")
	}
	if !nginxBuildOutputHasSubFilter([]byte("configure arguments: --with-http_sub_module --with-http_ssl_module")) {
		t.Fatal("sub-filter preflight rejected a build with the module")
	}
}

type pagesNginx struct{}

func (pagesNginx) TestConfig() (bool, string) { return true, "" }
func (pagesNginx) Reload() error              { return nil }

func TestPagesCommandsFailClosedWithoutRuntime(t *testing.T) {
	handler := NewHandler(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, nil, false)
	result := handler.HandleCommand(&pb.GatewayCommand{
		CommandId: "command",
		Payload:   &pb.GatewayCommand_PagesInventory{PagesInventory: &pb.PagesInventoryCommand{}},
	})
	if result.Success || result.Error != "Gateway Pages v1 runtime is unavailable on this node" {
		t.Fatalf("unexpected unavailable runtime result: %#v", result)
	}
}

func TestPagesRuntimeConfigCommandsRequireCapabilityAndReturnDaemonPath(t *testing.T) {
	runtime, err := pages.New(filepath.Join(t.TempDir(), "pages"), filepath.Join(t.TempDir(), "conf"), filepath.Join(t.TempDir(), "certs"), pagesNginx{})
	if err != nil {
		t.Fatal(err)
	}
	const routeID = "33333333-3333-3333-3333-333333333333"
	stage := &pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesStageRuntimeConfig{PagesStageRuntimeConfig: &pb.PagesStageRuntimeConfigCommand{
		BindingKind: pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE,
		BindingId:   routeID,
		Generation:  1,
		Json:        []byte(`{"apiUrl":"https://example.test"}`),
	}}}
	withoutCapability := NewHandler(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, runtime, false).HandleCommand(stage)
	if withoutCapability.Success || withoutCapability.Error != "Gateway Pages runtime configuration is unavailable on this node" {
		t.Fatalf("runtime config command did not fail closed: %#v", withoutCapability)
	}
	handler := NewHandler(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, runtime, true)
	if result := handler.HandleCommand(stage); !result.Success {
		t.Fatalf("stage failed: %#v", result)
	}
	result := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesActivateRuntimeConfig{PagesActivateRuntimeConfig: &pb.PagesActivateRuntimeConfigCommand{
		BindingKind: pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE,
		BindingId:   routeID,
		Generation:  1,
	}}})
	if !result.Success {
		t.Fatalf("activate failed: %#v", result)
	}
	var response struct {
		ConfigPath string `json:"configPath"`
	}
	if err := json.Unmarshal(result.Data, &response); err != nil || !strings.HasSuffix(response.ConfigPath, "/runtime-configs/routes/"+routeID+"/current.js") {
		t.Fatalf("unexpected config path %q, %v", response.ConfigPath, err)
	}
}

func TestPagesRuntimeConfigGenerationDiscardPreservesActiveGeneration(t *testing.T) {
	runtime, err := pages.New(filepath.Join(t.TempDir(), "pages"), filepath.Join(t.TempDir(), "conf"), filepath.Join(t.TempDir(), "certs"), pagesNginx{})
	if err != nil {
		t.Fatal(err)
	}
	const routeID = "44444444-4444-4444-4444-444444444444"
	handler := NewHandler(nil, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, runtime, true)
	for _, generation := range []uint64{1, 2} {
		result := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesStageRuntimeConfig{PagesStageRuntimeConfig: &pb.PagesStageRuntimeConfigCommand{
			BindingKind: pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE,
			BindingId:   routeID,
			Generation:  generation,
			Json:        []byte(`{"generation":` + fmt.Sprint(generation) + `}`),
		}}})
		if !result.Success {
			t.Fatalf("stage generation %d failed: %#v", generation, result)
		}
	}
	if result := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesActivateRuntimeConfig{PagesActivateRuntimeConfig: &pb.PagesActivateRuntimeConfigCommand{
		BindingKind: pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE,
		BindingId:   routeID,
		Generation:  1,
	}}}); !result.Success {
		t.Fatalf("activate failed: %#v", result)
	}
	if result := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesRemoveRuntimeConfig{PagesRemoveRuntimeConfig: &pb.PagesRemoveRuntimeConfigCommand{
		BindingKind: pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE,
		BindingId:   routeID,
		Generation:  2,
	}}}); !result.Success {
		t.Fatalf("discard failed: %#v", result)
	}
	if err := runtime.StageRuntimeConfig(pages.RuntimeConfigBindingRoute, routeID, 2, []byte(`{"generation":"retry"}`)); err != nil {
		t.Fatalf("retry stage failed: %v", err)
	}
	if result := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesRemoveRuntimeConfig{PagesRemoveRuntimeConfig: &pb.PagesRemoveRuntimeConfigCommand{
		BindingKind: pb.PagesRuntimeConfigBindingKind_PAGES_RUNTIME_CONFIG_BINDING_KIND_ROUTE,
		BindingId:   routeID,
		Generation:  1,
	}}}); result.Success {
		t.Fatal("discarded active runtime config generation")
	}
}

func TestPagesActivateTagRouteReturnsDaemonDerivedIncludePath(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "custom-nginx", "conf.d")
	certsDir := filepath.Join(t.TempDir(), "certs")
	runtime, err := pages.New(filepath.Join(t.TempDir(), "pages"), configDir, certsDir, pagesNginx{})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(&daemonconfig.Config{Nginx: daemonconfig.NginxConfig{CertsDir: certsDir}}, nil, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, runtime, true)
	archive := pagesTestArchive(t)
	sum := sha256.Sum256(archive)
	digest := hex.EncodeToString(sum[:])
	uploadID := "11111111-1111-1111-1111-111111111111"
	deploymentID := "22222222-2222-2222-2222-222222222222"
	routeID := "33333333-3333-3333-3333-333333333333"
	for _, command := range []*pb.GatewayCommand{
		{Payload: &pb.GatewayCommand_PagesUploadInit{PagesUploadInit: &pb.PagesUploadInitCommand{UploadId: uploadID, DeploymentId: deploymentID, ExpectedSize: int64(len(archive)), Sha256: digest}}},
		{Payload: &pb.GatewayCommand_PagesUploadChunk{PagesUploadChunk: &pb.PagesUploadChunkCommand{UploadId: uploadID, Content: archive}}},
		{Payload: &pb.GatewayCommand_PagesUploadFinalize{PagesUploadFinalize: &pb.PagesUploadFinalizeCommand{UploadId: uploadID, DeploymentId: deploymentID}}},
	} {
		if result := handler.HandleCommand(command); !result.Success {
			t.Fatalf("stage command failed: %#v", result)
		}
	}
	certificateID := "internal-66666666-6666-6666-6666-666666666666"
	certificateVersion := strings.Repeat("a", 64)
	certificate := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesDeployCertificate{PagesDeployCertificate: &pb.PagesDeployCertificateCommand{CertId: certificateID, CertPem: []byte("certificate"), KeyPem: []byte("key"), Version: certificateVersion, ReplicaGeneration: "1"}}})
	if !certificate.Success {
		t.Fatalf("Pages certificate deployment failed: %#v", certificate)
	}
	certificatePath := filepath.Join(certsDir, certificateID, "versions", certificateVersion, "fullchain.pem")
	if _, err := os.Stat(certificatePath); err != nil {
		t.Fatalf("fresh Pages-only versioned certificate is missing: %v", err)
	}
	hostname := "preview.pages.example"
	preview := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesMaterializePreview{PagesMaterializePreview: &pb.PagesMaterializePreviewCommand{ProfileId: "default", DeploymentId: deploymentID, Hostname: hostname, CertificateId: certificateID, CertificateVersion: certificateVersion}}})
	if !preview.Success {
		t.Fatalf("Pages TLS preview materialization failed: %#v", preview)
	}
	hostHash := sha256.Sum256([]byte(hostname))
	previewPath := filepath.Join(configDir, "pages-preview-"+hex.EncodeToString(hostHash[:12])+".conf")
	previewConfig, err := os.ReadFile(previewPath)
	if err != nil || !strings.Contains(string(previewConfig), certificatePath) {
		t.Fatalf("preview config does not reference fresh versioned certificate: %q, %v", previewConfig, err)
	}
	result := handler.HandleCommand(&pb.GatewayCommand{Payload: &pb.GatewayCommand_PagesActivateTagRoute{PagesActivateTagRoute: &pb.PagesActivateTagRouteCommand{RouteId: routeID, DeploymentId: deploymentID}}})
	if !result.Success {
		t.Fatalf("activation failed: %#v", result)
	}
	var response struct {
		IncludePath string `json:"includePath"`
	}
	if err := json.Unmarshal(result.Data, &response); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(configDir, "pages", "routes", routeID+".inc")
	if response.IncludePath != want {
		t.Fatalf("include path = %q, want %q", response.IncludePath, want)
	}
}

func pagesTestArchive(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	gz := gzip.NewWriter(&output)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "index.html", Mode: 0o644, Size: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("ok")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func hasCapability(capabilities []string, wanted string) bool {
	for _, capability := range capabilities {
		if capability == wanted {
			return true
		}
	}
	return false
}
