package lifecycle

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func loadHostAccessTestConfig(t *testing.T, extra string) *BaseConfig {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "gateway:\n  address: \"gateway.example.com:9443\"\n" + extra
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadBaseConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func nodeExecCommand(action string) *pb.GatewayCommand {
	return &pb.GatewayCommand{
		CommandId: "cmd-1",
		Payload:   &pb.GatewayCommand_NodeExec{NodeExec: &pb.NodeExecCommand{Action: action}},
	}
}

func nodeFileCommand(action string) *pb.GatewayCommand {
	return &pb.GatewayCommand{
		CommandId: "cmd-2",
		Payload:   &pb.GatewayCommand_NodeFile{NodeFile: &pb.NodeFileCommand{Action: action, Path: "/etc"}},
	}
}

func TestHostAccessDefaultsToEnabled(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  user: \"ops\"\n")
	if !cfg.Console.IsEnabled() || !cfg.Files.IsEnabled() {
		t.Fatalf("console and files must default to enabled, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
	if caps := cfg.hostAccessCapabilities(); len(caps) != 0 {
		t.Fatalf("an enabled node must not advertise disabled features, got %v", caps)
	}
	for _, action := range []string{"create", "resize", "run"} {
		if refused := refuseDisabledNodeExec(cfg, nodeExecCommand(action)); refused != nil {
			t.Fatalf("enabled console refused %s: %v", action, refused.Error)
		}
	}
	if refused := refuseDisabledNodeFile(cfg, nodeFileCommand("list")); refused != nil {
		t.Fatalf("enabled files refused list: %v", refused.Error)
	}
}

func TestDisabledConsoleRefusesEveryNodeExecAction(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  enabled: false\n")
	if cfg.Console.IsEnabled() {
		t.Fatal("console.enabled: false must disable the console")
	}
	if !cfg.Files.IsEnabled() {
		t.Fatal("disabling the console must leave file access enabled")
	}
	for _, action := range []string{"create", "resize", "run"} {
		refused := refuseDisabledNodeExec(cfg, nodeExecCommand(action))
		if refused == nil {
			t.Fatalf("disabled console accepted %s", action)
		}
		if refused.Success || refused.CommandId != "cmd-1" || !strings.Contains(refused.Error, "console is disabled in this node's daemon configuration") {
			t.Fatalf("unexpected refusal for %s: %+v", action, refused)
		}
	}
	if got := cfg.hostAccessCapabilities(); !reflect.DeepEqual(got, []string{NodeConsoleDisabledCapability}) {
		t.Fatalf("capabilities = %v", got)
	}
}

func TestDisabledFilesRefusesHostFileAccessButKeepsHostIdentity(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "files:\n  enabled: false\n")
	if cfg.Files.IsEnabled() || !cfg.Console.IsEnabled() {
		t.Fatalf("files.enabled: false must disable only files, got console=%v files=%v", cfg.Console.IsEnabled(), cfg.Files.IsEnabled())
	}
	for _, action := range []string{"list", "read", "write", "create-file", "create-dir", "delete", "move", "upload-init", "upload-chunk", "upload-complete", "upload-abort"} {
		refused := refuseDisabledNodeFile(cfg, nodeFileCommand(action))
		if refused == nil {
			t.Fatalf("disabled files accepted %s", action)
		}
		if refused.Success || refused.CommandId != "cmd-2" || !strings.Contains(refused.Error, "file access is disabled in this node's daemon configuration") {
			t.Fatalf("unexpected refusal for %s: %+v", action, refused)
		}
	}
	if refused := refuseDisabledNodeFile(cfg, nodeFileCommand("ensure-host-identity")); refused != nil {
		t.Fatalf("ensure-host-identity must stay available: %v", refused.Error)
	}
	if got := cfg.hostAccessCapabilities(); !reflect.DeepEqual(got, []string{NodeFilesDisabledCapability}) {
		t.Fatalf("capabilities = %v", got)
	}
}

func TestBothHostAccessFeaturesDisabledAdvertiseBothMarkers(t *testing.T) {
	cfg := loadHostAccessTestConfig(t, "console:\n  enabled: false\nfiles:\n  enabled: false\n")
	want := []string{NodeConsoleDisabledCapability, NodeFilesDisabledCapability}
	if got := cfg.hostAccessCapabilities(); !reflect.DeepEqual(got, want) {
		t.Fatalf("capabilities = %v, want %v", got, want)
	}
}
