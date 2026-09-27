// Command lease-watchdog enforces Docker Availability lease deadlines on a
// node independently of docker-daemon and dockerd (A2.2, A12). It runs as
// root under its own service unit, reads deadline records from tmpfs, kills
// the cgroup of any container past its deadline, and writes a heartbeat the
// daemon requires before it acquires, starts or renews a lease.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/lease-watchdog/internal/update"
	"github.com/wiolett-industries/gateway/lease-watchdog/internal/watchdog"
)

// Version is set at build time: -X main.Version=vX.Y.Z.
var Version = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	var err error
	switch os.Args[1] {
	case "run":
		err = run(os.Args[2:], logger)
	case "update":
		err = updateOnce(os.Args[2:], logger)
	case "status":
		err = status(os.Args[2:])
	case "self-test":
		err = selfTest(os.Args[2:])
	case "version":
		fmt.Printf("lease-watchdog %s\n", Version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		logger.Error("lease watchdog failed", "command", os.Args[1], "error", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: lease-watchdog run|update|status|self-test|version [flags]")
}

type updateFlags struct {
	releasesURL, artifactBaseURL, channel *string
}

func addUpdateFlags(fs *flag.FlagSet) updateFlags {
	return updateFlags{
		releasesURL:     fs.String("releases-url", update.DefaultReleasesURL, "update service releases endpoint"),
		artifactBaseURL: fs.String("artifact-base-url", update.DefaultArtifactBaseURL, "update service artifact base"),
		channel:         fs.String("channel", "stable", "release channel: stable or preview"),
	}
}

func run(args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	root := fs.String("dir", leasefence.DefaultRoot, "tmpfs directory shared with docker-daemon")
	cgroupRoot := fs.String("cgroup-root", leasefence.DefaultCgroupRoot, "cgroupfs mount")
	owner := fs.String("records-owner", "", "user that runs docker-daemon and writes deadline records")
	autoUpdate := fs.Bool("auto-update", false, "install new watchdog releases automatically")
	interval := fs.Duration("update-interval", 6*time.Hour, "average interval between update checks")
	updates := addUpdateFlags(fs)
	_ = fs.Parse(args)

	dir := leasefence.Dir{Root: *root}
	if err := prepareDirectories(dir, *owner); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logger.Info("lease watchdog started", "version", Version, "dir", *root, "cgroup_root", *cgroupRoot)
	restart := make(chan string, 1)
	if *autoUpdate {
		go updateLoop(ctx, updates, *interval, logger, restart)
	}
	enforcer := watchdog.New(watchdog.Config{Dir: dir, CgroupRoot: *cgroupRoot, Logger: logger, Build: Version})
	done := make(chan struct{})
	runCtx, cancel := context.WithCancel(context.Background())
	go func() {
		enforcer.Run(runCtx)
		close(done)
	}()
	select {
	case <-ctx.Done():
	case tag := <-restart:
		logger.Info("lease watchdog updated; exiting for the supervisor to restart it", "tag", tag)
	}
	// Deadline records stay on tmpfs; the next process enforces them at once.
	cancel()
	<-done
	return nil
}

func prepareDirectories(dir leasefence.Dir, owner string) error {
	if err := os.MkdirAll(dir.RecordsDir(), 0o700); err != nil {
		return fmt.Errorf("create lease record directory: %w", err)
	}
	if err := os.Chmod(filepath.Dir(dir.RecordsDir()), 0o755); err != nil {
		return err
	}
	if owner == "" {
		return nil
	}
	account, err := user.Lookup(owner)
	if err != nil {
		return fmt.Errorf("records owner %q: %w", owner, err)
	}
	uid, uidErr := strconv.Atoi(account.Uid)
	gid, gidErr := strconv.Atoi(account.Gid)
	if uidErr != nil || gidErr != nil {
		return fmt.Errorf("records owner %q has a non-numeric id", owner)
	}
	return os.Chown(dir.RecordsDir(), uid, gid)
}

func updateLoop(ctx context.Context, flags updateFlags, interval time.Duration, logger *slog.Logger, restart chan<- string) {
	if interval < time.Minute {
		interval = time.Minute
	}
	for {
		// Jitter spreads a fleet over the interval so a bad release cannot
		// take every node's watchdog down at once.
		wait := interval/2 + time.Duration(rand.Int64N(int64(interval)))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		result, err := checkUpdate(ctx, flags, logger)
		if err != nil {
			logger.Warn("lease watchdog update check failed", "error", err)
			continue
		}
		if result.Updated {
			restart <- result.Tag
			return
		}
	}
}

func checkUpdate(ctx context.Context, flags updateFlags, logger *slog.Logger) (update.Result, error) {
	executable, err := os.Executable()
	if err != nil {
		return update.Result{}, err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}
	return update.Check(ctx, update.Config{
		ReleasesURL: *flags.releasesURL, ArtifactBaseURL: *flags.artifactBaseURL, Channel: *flags.channel,
		Current: Version, Executable: executable, Replace: lifecycle.ReplaceBinaryAtPath, Logger: logger,
		SelfTest: func(ctx context.Context, path string) error {
			return exec.CommandContext(ctx, path, "self-test").Run()
		},
	})
}

func updateOnce(args []string, logger *slog.Logger) error {
	fs := flag.NewFlagSet("update", flag.ExitOnError)
	flags := addUpdateFlags(fs)
	_ = fs.Parse(args)
	result, err := checkUpdate(context.Background(), flags, logger)
	if err != nil {
		return err
	}
	if !result.Updated {
		fmt.Println("lease-watchdog is up to date")
		return nil
	}
	fmt.Printf("lease-watchdog updated to %s; restart the gateway-lease-watchdog service\n", result.Tag)
	return nil
}

func status(args []string) error {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	root := fs.String("dir", leasefence.DefaultRoot, "tmpfs directory shared with docker-daemon")
	_ = fs.Parse(args)
	dir := leasefence.Dir{Root: *root}
	now := leasefence.Now()
	heartbeat, err := dir.ReadHeartbeat()
	switch {
	case err != nil:
		fmt.Printf("heartbeat: missing (%v)\n", err)
	case heartbeat.Fresh(now):
		fmt.Printf("heartbeat: fresh (pid %d, build %s)\n", heartbeat.PID, heartbeat.Build)
	default:
		fmt.Printf("heartbeat: stale by %s\n", now-time.Duration(heartbeat.NowNs))
	}
	records, problems, err := dir.ReadRecords()
	if err != nil {
		return err
	}
	for _, record := range records {
		state := "armed, " + (record.Deadline() - now).Round(time.Millisecond).String() + " left"
		if record.Stale(now) {
			state = "stale: enforcing"
		}
		fmt.Printf("%s policy=%s slot=%d %s\n", record.ContainerID[:12], record.PolicyID, record.Slot, state)
	}
	for _, problem := range problems {
		fmt.Printf("malformed: %s\n", problem)
	}
	return nil
}

// selfTest proves a staged binary starts and can use this host's clock.
func selfTest(_ []string) error {
	if leasefence.Now() <= 0 {
		return errors.New("CLOCK_BOOTTIME is unavailable")
	}
	fmt.Printf("lease-watchdog %s ok\n", Version)
	return nil
}
