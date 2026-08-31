package daemon

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
)

func TestCollectHealthUsesCachedConfigAndTrafficRates(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	binary := filepath.Join(dir, "nginx")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$*\" >> %q\nexit 0\n", argsPath)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	mgr := nginx.NewManager(binary, dir, dir, "")
	if valid, _ := mgr.TestConfig(); !valid {
		t.Fatal("expected config test to pass")
	}
	reporter := NewReporter(
		&config.Config{Nginx: config.NginxConfig{}},
		mgr,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	reporter.SetErrorRates(4, 1, 1)
	if err := os.WriteFile(argsPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	report := reporter.CollectHealth(&pb.HealthReport{})
	if !report.ConfigValid || report.ErrorRate_4Xx != 25 || report.ErrorRate_5Xx != 25 {
		t.Fatalf("unexpected cached health: %#v", report)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(args), "-t") {
		t.Fatalf("health collection executed nginx -t: %q", args)
	}
}

func TestValidateConfigIfStaleKeepsDeadlineAcrossSessions(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	binary := filepath.Join(dir, "nginx")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$*\" >> %q\nexit 0\n", argsPath)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	mgr := nginx.NewManager(binary, dir, dir, "")
	if valid, _ := mgr.TestConfig(); !valid {
		t.Fatal("expected config test to pass")
	}
	_, checkedAt, checked := mgr.CachedConfigValidity()
	if !checked {
		t.Fatal("expected cached validation timestamp")
	}
	if err := os.WriteFile(argsPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	plugin := &NginxPlugin{
		cfg: &config.Config{Nginx: config.NginxConfig{
			ConfigDir: dir, CertsDir: dir, HtpasswdDir: dir,
		}},
		mgr: mgr, logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	plugin.validateConfigIfStale(checkedAt.Add(configValidationInterval - time.Second))
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 0 {
		t.Fatalf("fresh reconnect revalidated config: %q", args)
	}

	plugin.validateConfigIfStale(checkedAt.Add(configValidationInterval))
	args, err = os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(args), "-t") != 1 {
		t.Fatalf("stale reconnect did not revalidate config: %q", args)
	}
}
