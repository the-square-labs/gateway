package nginx

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fakeNginx(t *testing.T, dir string) (binary string, failPath string) {
	t.Helper()
	failPath = filepath.Join(dir, "fail-reload")
	binary = filepath.Join(dir, "nginx")
	script := fmt.Sprintf("#!/bin/sh\ncase \"$*\" in *reload*) [ ! -f %q ] ;; *) exit 0 ;; esac\n", failPath)
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return binary, failPath
}

func TestReloadAdvancesTheConfigGeneration(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, "conf.d")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	binary, failPath := fakeNginx(t, dir)
	mgr := NewManager(binary, configDir, dir, "")

	written, err := mgr.EnsureConfigGeneration()
	if err != nil || !written || mgr.ConfigGeneration() != 1 {
		t.Fatalf("ensure: written=%v err=%v generation=%d", written, err, mgr.ConfigGeneration())
	}
	if written, _ := mgr.EnsureConfigGeneration(); written {
		t.Fatal("an existing generation file must not be rewritten")
	}
	if err := mgr.Reload(); err != nil {
		t.Fatal(err)
	}
	if mgr.ConfigGeneration() != 2 {
		t.Fatalf("generation = %d after a successful reload, want 2", mgr.ConfigGeneration())
	}
	content, _ := os.ReadFile(filepath.Join(configDir, IngressGenerationFilename()))
	if !strings.Contains(string(content), `default "2";`) || !strings.Contains(string(content), ingressGenerationVariable) {
		t.Fatalf("generation file = %q", content)
	}

	// A failed reload leaves the generation nginx runs, and restores the file.
	if err := os.WriteFile(failPath, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mgr.Reload(); err == nil {
		t.Fatal("expected the reload to fail")
	}
	if mgr.ConfigGeneration() != 2 {
		t.Fatalf("generation = %d after a failed reload, want 2", mgr.ConfigGeneration())
	}
	content, _ = os.ReadFile(filepath.Join(configDir, IngressGenerationFilename()))
	if !strings.Contains(string(content), `default "2";`) {
		t.Fatalf("generation file not restored: %q", content)
	}

	// A restarted daemon continues from the recorded generation.
	restarted := NewManager(binary, configDir, dir, "")
	if restarted.LoadConfigGeneration() != 2 {
		t.Fatalf("restarted generation = %d", restarted.ConfigGeneration())
	}
}

func TestIngressHealthLocationProxiesToTheResponder(t *testing.T) {
	location := IngressHealthLocation()
	for _, want := range []string{
		"location = " + IngressHealthPath,
		"proxy_pass http://unix:" + IngressHealthSocketPath + ":/health;",
		"proxy_set_header " + IngressGenerationHeader + " $gateway_ingress_generation;",
		"allow all;",
		"auth_basic off;",
	} {
		if !strings.Contains(location, want) {
			t.Fatalf("location misses %q:\n%s", want, location)
		}
	}
}

func TestIngressHealthCertificateSelfRenews(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)
	written, err := EnsureIngressHealthCertificate(dir, now)
	if err != nil || !written {
		t.Fatalf("first: written=%v err=%v", written, err)
	}
	certPath, keyPath := ingressHealthCertPaths(dir)
	info, err := os.Stat(keyPath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode = %v err=%v", info.Mode().Perm(), err)
	}
	if written, _ := EnsureIngressHealthCertificate(dir, now.Add(300*24*time.Hour)); written {
		t.Fatal("a certificate with more than 30 days left must be kept")
	}
	if written, _ := EnsureIngressHealthCertificate(dir, now.Add(340*24*time.Hour)); !written {
		t.Fatal("a certificate with fewer than 30 days left must be replaced")
	}
	content, _ := os.ReadFile(certPath)
	block, _ := pem.Decode(content)
	parsed, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Subject.CommonName != IngressHealthHostname || !parsed.NotAfter.After(now.Add(700*24*time.Hour)) {
		t.Fatalf("renewed certificate %s valid until %s", parsed.Subject.CommonName, parsed.NotAfter)
	}
}

func TestIngressHealthServerAnswersTheReservedHostname(t *testing.T) {
	dir := t.TempDir()
	written, err := EnsureIngressHealthServer(dir, "/etc/nginx/certs")
	if err != nil || !written {
		t.Fatalf("written=%v err=%v", written, err)
	}
	content, _ := os.ReadFile(IngressHealthServerPath(dir))
	text := string(content)
	for _, want := range []string{"server_name " + IngressHealthHostname + ";", "listen 443 ssl;", "listen 80;", IngressHealthPath} {
		if !strings.Contains(text, want) {
			t.Fatalf("server misses %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "default_server") {
		t.Fatalf("the reserved server must not take a default_server:\n%s", text)
	}
	if written, _ := EnsureIngressHealthServer(dir, "/etc/nginx/certs"); written {
		t.Fatal("unchanged content must not be rewritten")
	}
}

const installerDefaultServer = `server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
    }

    location /health {
        access_log off;
        return 200 "OK\n";
    }
}
`

func TestDefaultHTTPServerHealthPatchOnlyTouchesTheInstallerFile(t *testing.T) {
	root := t.TempDir()
	global := filepath.Join(root, "nginx.conf")
	confD := filepath.Join(root, "conf.d")
	if err := os.MkdirAll(confD, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(confD, "default.conf")
	if err := os.WriteFile(path, []byte(installerDefaultServer), 0o644); err != nil {
		t.Fatal(err)
	}
	target, original, patched, ok := DefaultHTTPServerHealthPatch(global)
	if !ok || target != path || string(original) != installerDefaultServer {
		t.Fatalf("patch: ok=%v target=%q", ok, target)
	}
	if !strings.Contains(string(patched), "server_name _;\n\n"+IngressHealthLocation()) {
		t.Fatalf("patched file:\n%s", patched)
	}
	if err := os.WriteFile(path, patched, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := DefaultHTTPServerHealthPatch(global); ok {
		t.Fatal("an already patched file must not be patched again")
	}

	operator := "server {\n    listen 80 default_server;\n    server_name _;\n    return 444;\n}\n"
	if err := os.WriteFile(path, []byte(operator), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, _, ok := DefaultHTTPServerHealthPatch(global); ok {
		t.Fatal("an operator-owned default server must be left alone")
	}
}
