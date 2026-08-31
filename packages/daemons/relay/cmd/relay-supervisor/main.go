package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/relay-supervisor/internal/config"
	"github.com/wiolett-industries/gateway/relay-supervisor/internal/supervisor"
)

var Version = "dev"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version":
			fmt.Printf("relay-supervisor %s\n", Version)
			return
		case "update-guard":
			runUpdateGuard(os.Args[2:])
			return
		case "run":
		default:
			fmt.Fprintln(os.Stderr, "Usage: relay-supervisor [run|update-guard|version]")
			os.Exit(1)
		}
	}
	if err := lifecycle.EnsureCurrentSystemdUpdateGuard("relay"); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: automatic update rollback guard unavailable: %v\n", err)
	}
	configPath := os.Getenv("RELAY_SUPERVISOR_CONFIG")
	if configPath == "" {
		configPath = "/etc/gateway-relay-supervisor/config.yaml"
	}
	cfg, err := config.Load(configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "load relay supervisor config: %v\n", err)
		os.Exit(1)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel(cfg.LogLevel)}))
	lifecycle.Version = Version
	plugin := supervisor.New(cfg)
	daemon, err := lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, plugin, logger)
	if err != nil {
		logger.Error("initialize relay supervisor", "error", err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	if err := daemon.Run(ctx); err != nil {
		logger.Error("relay supervisor stopped", "error", err)
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

func logLevel(value string) slog.Level {
	switch value {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
