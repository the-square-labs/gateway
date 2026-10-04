package lifecycle

import (
	"context"
	"log/slog"
	"sort"
	"sync/atomic"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

func runProcessRelayPool(
	ctx context.Context,
	connector *connector.Connector,
	plugin RelayPoolTunnelPlugin,
	nodeID string,
	identityChanged <-chan struct{},
	logger *slog.Logger,
) {
	go runRelayLatencyProbes(ctx, connector, plugin)
	// Each relay target runs on its own. A grant refresh that adds, removes or
	// changes one relay must not reconnect the lanes to the others: every tunnel
	// on those lanes (database, storage and backup streams) would drop with them.
	type targetRun struct {
		target *atomic.Pointer[RelayTunnelTarget]
		cancel context.CancelFunc
		done   chan struct{}
	}
	running := map[string]*targetRun{}
	laneCount := 0
	stop := func(ids ...string) {
		for _, id := range ids {
			if run := running[id]; run != nil {
				run.cancel()
				<-run.done
				delete(running, id)
			}
		}
	}
	stopAll := func() {
		ids := make([]string, 0, len(running))
		for id := range running {
			ids = append(ids, id)
		}
		stop(ids...)
	}
	defer stopAll()
	for ctx.Err() == nil {
		lanes := plugin.RelayTunnelLaneCount()
		if lanes < 1 {
			lanes = 1
		}
		if lanes > 16 {
			lanes = 16
		}
		if lanes != laneCount {
			stopAll()
			laneCount = lanes
		}
		targets := plugin.RelayTunnelTargets()
		if len(targets) == 0 {
			targets = []RelayTunnelTarget{{ID: "local"}}
		}
		runningIDs := make(map[string]bool, len(running))
		for id := range running {
			runningIDs[id] = true
		}
		plan := planRelayTargets(runningIDs, targets)
		stop(plan.stop...)
		for _, target := range plan.update {
			// A changed address or certificate (a renewal) applies to the next
			// connection; lanes that are up stay up.
			next := target
			running[target.ID].target.Store(&next)
		}
		for _, target := range plan.start {
			id := target.ID
			current := &atomic.Pointer[RelayTunnelTarget]{}
			initial := target
			current.Store(&initial)
			targetCtx, cancel := context.WithCancel(ctx)
			run := &targetRun{target: current, cancel: cancel, done: make(chan struct{})}
			running[id] = run
			go func() {
				defer close(run.done)
				runRelayPoolTarget(targetCtx, connector, plugin, nodeID, current.Load, lanes, logger)
			}()
		}
		select {
		case <-ctx.Done():
			return
		case <-identityChanged:
			// This daemon's own certificate changed: every lane must reconnect with it.
			logger.Info("relay tunnel identity changed, reconnecting pool lanes")
			stopAll()
		case <-plugin.RelayTunnelRuntimeChanged():
			logger.Info("relay tunnel targets changed, reconciling pool lanes")
		}
	}
}

type relayTargetPlan struct {
	start  []RelayTunnelTarget
	update []RelayTunnelTarget
	stop   []string
}

// planRelayTargets compares running relay targets with the desired ones: only
// new targets start and only removed ones stop. A target whose address or
// certificate changed keeps its lanes and uses the new data to reconnect.
func planRelayTargets(running map[string]bool, desired []RelayTunnelTarget) relayTargetPlan {
	plan := relayTargetPlan{}
	wanted := make(map[string]bool, len(desired))
	for _, target := range desired {
		if wanted[target.ID] {
			continue
		}
		wanted[target.ID] = true
		if running[target.ID] {
			plan.update = append(plan.update, target)
		} else {
			plan.start = append(plan.start, target)
		}
	}
	for id := range running {
		if !wanted[id] {
			plan.stop = append(plan.stop, id)
		}
	}
	sort.Strings(plan.stop)
	return plan
}

func runRelayPoolTarget(
	ctx context.Context,
	connector *connector.Connector,
	plugin RelayPoolTunnelPlugin,
	nodeID string,
	currentTarget func() *RelayTunnelTarget,
	laneCount int,
	logger *slog.Logger,
) {
	for ctx.Err() == nil {
		target := *currentTarget()
		targetCtx, cancelTarget := context.WithCancel(ctx)
		connections := make([]*grpc.ClientConn, 0, laneCount)
		laneEnded := make(chan struct{}, laneCount)
		// Each lane carries tunnels as soon as it is up: right after a start (a restart or update of the daemon) the
		// connections the previous process handed over wait for the first lane, not for every lane of the relay.
		for len(connections) < laneCount && ctx.Err() == nil {
			var conn *grpc.ClientConn
			var err error
			if len(target.Addresses) == 0 {
				conn, err = connector.ConnectLaneWithRetry(ctx)
			} else {
				conn, err = connector.ConnectTargetAttempt(ctx, target.Addresses, target.CertificateIdentity, target.CertificateFingerprint)
			}
			if err != nil {
				logger.Warn("relay target lane connection failed", "relay_instance_id", target.ID, "error", err)
				break
			}
			if len(connections) == 0 {
				liveRelayTransports.set(target.ID, conn)
			}
			connections = append(connections, conn)
			go keepRelayLaneConnected(targetCtx, conn)
			go func() {
				plugin.RunRelayTargetTunnels(targetCtx, conn, nodeID, target.ID)
				laneEnded <- struct{}{}
			}()
		}
		if len(connections) == 0 {
			cancelTarget()
			if !waitForControlSessionReconnect(ctx) {
				return
			}
			continue
		}
		select {
		case <-ctx.Done():
		case <-laneEnded:
		}
		cancelTarget()
		liveRelayTransports.clear(target.ID, connections[0])
		for _, conn := range connections {
			_ = conn.Close()
		}
		if ctx.Err() == nil && !waitForControlSessionReconnect(ctx) {
			return
		}
	}
}

// keepRelayLaneConnected reconnects a lane whose transport dropped. gRPC
// leaves such a connection idle until the next call on it, but tunnels are
// only opened on lanes that are connected: a relay that was unreachable for a
// while would stay out of use after it came back.
func keepRelayLaneConnected(ctx context.Context, conn *grpc.ClientConn) {
	for {
		state := conn.GetState()
		if state == connectivity.Idle {
			conn.Connect()
		}
		if !conn.WaitForStateChange(ctx, state) {
			return
		}
	}
}
