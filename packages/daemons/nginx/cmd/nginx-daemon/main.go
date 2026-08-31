package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"regexp"
	"syscall"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/daemon"
)

var gatewayCertSHA256Pattern = regexp.MustCompile(`^sha256:[0-9a-fA-F]{64}$`)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version":
			fmt.Printf("nginx-daemon %s\n", daemon.Version)
			return
		case "install":
			runInstall()
			return
		case "update-guard":
			runUpdateGuard(os.Args[2:])
			return
		case "run":
			// explicit run, continue below
		default:
			fmt.Fprintf(os.Stderr, "Usage: nginx-daemon [run|install|update-guard|version]\n")
			os.Exit(1)
		}
	}
	if err := lifecycle.EnsureCurrentSystemdUpdateGuard("nginx"); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: automatic update rollback guard unavailable: %v\n", err)
	}

	// Default: run the daemon
	configPath := os.Getenv("NGINX_DAEMON_CONFIG")
	if configPath == "" {
		configPath = "/etc/nginx-daemon/config.yaml"
	}

	logger := setupLogger("info", "json")

	cfg, err := config.Load(configPath)
	if err != nil {
		logger.Error("failed to load config", "path", configPath, "error", err)
		os.Exit(1)
	}

	logger = setupLogger(cfg.LogLevel, cfg.LogFormat)
	logger.Info("starting nginx-daemon", "version", daemon.Version, "config", configPath)

	d, err := daemon.New(cfg, configPath, logger)
	if err != nil {
		logger.Error("failed to initialize daemon", "error", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, shutting down", "signal", sig)
		cancel()
	}()

	if err := d.Run(ctx); err != nil {
		logger.Error("daemon exited with error", "error", err)
		os.Exit(1)
	}
}

func runUpdateGuard(args []string) {
	rolledBack, err := lifecycle.RunUpdateGuardCommand(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "update guard failed: %v\n", err)
		os.Exit(1)
	}
	if rolledBack {
		fmt.Fprintln(os.Stderr, "daemon update rolled back to the previous version")
	}
}

func defaultNginxConfigDir() string { return "/etc/nginx/gateway/conf.d" }

func setupLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: lvl}

	var handler slog.Handler
	if format == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}

	return slog.New(handler)
}

func runInstall() {
	if len(os.Args) < 4 {
		fmt.Fprintf(os.Stderr, "Usage: nginx-daemon install --gateway <address> --token <token> --gateway-cert-sha256 <sha256:hex>\n")
		os.Exit(1)
	}

	var address, token, certSHA256 string
	for i := 2; i < len(os.Args)-1; i++ {
		switch os.Args[i] {
		case "--gateway":
			address = os.Args[i+1]
		case "--token":
			token = os.Args[i+1]
		case "--gateway-cert-sha256":
			certSHA256 = os.Args[i+1]
		}
	}

	if address == "" || token == "" || certSHA256 == "" {
		fmt.Fprintf(os.Stderr, "--gateway, --token, and --gateway-cert-sha256 are required\n")
		os.Exit(1)
	}
	if !gatewayCertSHA256Pattern.MatchString(certSHA256) {
		fmt.Fprintf(os.Stderr, "--gateway-cert-sha256 must use sha256:<64-hex> format\n")
		os.Exit(1)
	}

	configDir := "/etc/nginx-daemon"
	configPath := configDir + "/config.yaml"

	if err := os.MkdirAll(configDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create config dir: %v\n", err)
		os.Exit(1)
	}

	configContent := fmt.Sprintf(`gateway:
  address: "%s"
  token: "%s"
  cert_sha256: "%s"

tls:
  ca_cert: "/etc/nginx-daemon/certs/ca.pem"
  client_cert: "/etc/nginx-daemon/certs/node.pem"
  client_key: "/etc/nginx-daemon/certs/node-key.pem"

nginx:
  config_dir: "%s"
  certs_dir: "/etc/nginx/certs"
  logs_dir: "/var/log/nginx"
  global_config: "/etc/nginx/nginx.conf"
  binary: "/usr/sbin/nginx"
  stub_status_url: "http://127.0.0.1/nginx_status"
  htpasswd_dir: "/etc/nginx/gateway/htpasswd"
  acme_challenge_dir: "/var/www/acme-challenge"

state_dir: "/var/lib/nginx-daemon"
log_level: "info"
log_format: "json"
`, address, token, certSHA256, defaultNginxConfigDir())

	if err := os.WriteFile(configPath, []byte(configContent), 0600); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write config: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Config written to %s\n", configPath)

	// Create systemd service unit
	serviceContent := `[Unit]
Description=Gateway Nginx Daemon
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/nginx-daemon run
Restart=always
RestartSec=5
Environment=NGINX_DAEMON_CONFIG=/etc/nginx-daemon/config.yaml

[Install]
WantedBy=multi-user.target
`
	servicePath := "/etc/systemd/system/nginx-daemon.service"
	if err := os.WriteFile(servicePath, []byte(serviceContent), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to write systemd unit: %v\n", err)
		fmt.Println("You can start the daemon manually: nginx-daemon run")
	} else {
		fmt.Printf("Systemd service written to %s\n", servicePath)
		fmt.Println("Enable and start: systemctl enable --now nginx-daemon")
	}
}
