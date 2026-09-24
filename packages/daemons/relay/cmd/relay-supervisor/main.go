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
	if lifecycle.IsLauncherProbeCommand(os.Args) {
		lifecycle.PrintLauncherProbe()
		return
	}
	if lifecycle.IsLauncherCommand(os.Args) {
		if err := lifecycle.RunLauncherCommand(os.Args, nil); err != nil {
			fmt.Fprintf(os.Stderr, "launcher failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version":
			fmt.Printf("relay-supervisor %s\n", Version)
			return
		case "run":
		default:
			fmt.Fprintln(os.Stderr, "Usage: relay-supervisor [run|version]")
			os.Exit(1)
		}
	}
	if err := lifecycle.BootstrapLauncher(lifecycle.LauncherSpec{
		DaemonType: "relay",
		StateDir:   "/var/lib/gateway-relay-supervisor",
		ChildArgs:  os.Args[1:],
	}); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: launcher unavailable; continuing in direct mode: %v\n", err)
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
	if err := supervisor.RecoverInterruptedReenrollment(&cfg.BaseConfig); err != nil {
		logger.Error("restore relay supervisor identity from an interrupted re-enrollment", "error", err)
	}
	reenrollment, err := supervisor.BeginReenrollment(&cfg.BaseConfig)
	if err != nil {
		logger.Error("re-enrollment skipped; continuing with the current identity", "error", err)
	} else if reenrollment != nil {
		logger.Warn("configuration carries an enrollment token; re-enrolling this relay with Gateway")
	}
	daemon, err := lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, supervisor.New(cfg), logger)
	if err != nil {
		restoreIdentity(reenrollment, logger)
		logger.Error("initialize relay supervisor", "error", err)
		os.Exit(1)
	}
	lifecycle.NotifyLauncherLocalReadyAwaitingControl(Version)
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	err = daemon.Run(ctx)
	if err != nil && reenrollment != nil && !cfg.IsEnrolled() && ctx.Err() == nil {
		// The enrollment did not complete: keep running as the relay was.
		logger.Error("re-enrollment failed; continuing with the previous identity", "error", err)
		if !restoreIdentity(reenrollment, logger) {
			os.Exit(1)
		}
		if supervisor.EnrollmentTokenRejected(err) {
			if clearErr := lifecycle.ClearTokenFromFile(configPath); clearErr != nil {
				logger.Warn("failed to clear the rejected enrollment token from the configuration", "error", clearErr)
			}
		}
		cfg.Gateway.Token = ""
		daemon, err = lifecycle.NewDaemonBase(&cfg.BaseConfig, configPath, supervisor.New(cfg), logger)
		if err == nil {
			err = daemon.Run(ctx)
		}
	}
	if err != nil {
		logger.Error("relay supervisor stopped", "error", err)
		os.Exit(lifecycle.DaemonExitCode(err))
	}
}

func restoreIdentity(reenrollment *supervisor.Reenrollment, logger *slog.Logger) bool {
	if reenrollment == nil {
		return true
	}
	if err := reenrollment.Restore(); err != nil {
		logger.Error("restore the previous relay supervisor identity", "error", err)
		return false
	}
	return true
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
