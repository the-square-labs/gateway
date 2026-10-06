package daemon

import (
	"context"
	"errors"
	"net"
	"sort"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/logepisode"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

// Resumable Secure Link streams (RSv1). A connect assignment that carries
// stream_resume makes the stream of every new connection resumable: it moves
// to another relay (or to the same relay after its restart) on a drain
// notice, a lane GOAWAY, a path failure or a hint from the target, without
// nginx or the upstream seeing the connection break. Assignments without it,
// and routes whose target turned out not to be resume-aware, keep raw
// streams exactly as before.

// relayStreamTag names the link a resumable stream belongs to.
type relayStreamTag struct {
	ownerKind string
	linkID    string
}

func newRelayStreamManager(plugin *NginxPlugin) *relayresume.Manager {
	manager := relayresume.NewManager(nil)
	manager.OnMigration = plugin.relayStreamMigrated
	manager.OnEnd = plugin.relayStreamEnded
	return manager
}

func relayStreamSubject(tag any) (logepisode.Subject, bool) {
	link, ok := tag.(relayStreamTag)
	if !ok {
		return logepisode.Subject{}, false
	}
	name := "proxy secure-link streams"
	if link.ownerKind == registrySecureLinkOwnerKind {
		name = "registry ingress streams"
	}
	return logepisode.Subject{Name: name, IDAttr: "link_id", ID: link.linkID}, true
}

// relayStreamMigrated logs moves per link and state change: a moved stream
// was served, but its relay path was not healthy.
func (p *NginxPlugin) relayStreamMigrated(event relayresume.MigrationEvent) {
	subject, ok := relayStreamSubject(event.Session.Tag())
	if !ok || p.logger == nil {
		return
	}
	if !event.OK {
		p.logger.Debug("relay stream did not move", "link_id", subject.ID, "trigger", string(event.Trigger),
			"relay_instance_id", event.From, "error", errorText(event.Err))
		return
	}
	p.relayStreamOutcomes.Retried(p.logger, subject, "trigger", string(event.Trigger), "from_relay", event.From,
		"to_relay", event.To, "paused", event.Stall.Round(time.Millisecond).String())
}

// relayStreamEnded logs a resumable stream that ended because it could not
// move (no relay came back, the target refused the resume).
func (p *NginxPlugin) relayStreamEnded(session *relayresume.Session, err error) {
	if err == nil || p.logger == nil {
		return
	}
	var reset *relayresume.ResetError
	if !errors.As(err, &reset) || reset.Remote || !relayStreamCut(err, reset) {
		return
	}
	subject, ok := relayStreamSubject(session.Tag())
	if !ok {
		return
	}
	p.relayStreamOutcomes.Failed(p.logger, subject, "stage", "resume", "error", err.Error())
}

func relayStreamCut(err error, reset *relayresume.ResetError) bool {
	return reset.Reject != 0 || errors.Is(err, relayresume.ErrSuspendTimeout) || errors.Is(err, relayresume.ErrNotResumable) ||
		errors.Is(err, relayresume.ErrRevoked)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// resumeConfig returns the source configuration of a link's new streams, or
// false when they stay raw.
func (p *NginxPlugin) resumeConfig(ownerKind, linkID string, assignment *pb.RelayGrantAssignment) (relayresume.SourceConfig, bool) {
	resume := assignment.GetStreamResume()
	routeID := assignment.GetRouteId()
	if p.relayStreams == nil || !usableStreamResume(resume) || routeID == "" || p.relayStreams.Legacy(routeID) {
		return relayresume.SourceConfig{}, false
	}
	return relayresume.SourceConfig{
		RouteID: routeID,
		// The latest bundle's key signs every RESUME (rotation); a link whose
		// route lost resumability cannot move any more.
		Key: func() (string, []byte, bool) {
			current := p.relayGrants.lookup("connect", ownerKind, linkID)
			resume := current.GetStreamResume()
			if current == nil || current.GetRouteId() != routeID || !usableStreamResume(resume) {
				return "", nil, false
			}
			return resume.GetKeyId(), resume.GetKey(), true
		},
		HalfCloseTimeout: time.Duration(resume.GetHalfCloseTimeoutMs()) * time.Millisecond,
		Dial: func(ctx context.Context, avoidRelayID string) (relayresume.OpenedPath, error) {
			return p.dialRelayStreamPath(ctx, ownerKind, linkID, avoidRelayID)
		},
		Tag: relayStreamTag{ownerKind: ownerKind, linkID: linkID},
	}, true
}

func usableStreamResume(resume *pb.RelayStreamResume) bool {
	return resume != nil && resume.GetVersion() == relayresume.Version && resume.GetKeyId() != "" &&
		len(resume.GetKeyId()) <= relayresume.MaxKeyIDLen && len(resume.GetKey()) == relayresume.KeyLen
}

// dialRelayStreamPath opens a fresh tunnel for a moving stream on the link's
// current assignment: active candidates first, then staging ones (registered
// on both ends: when the only active relay drains or was force-disconnected
// the stream moves there instead of being cut), the relay it leaves last.
func (p *NginxPlugin) dialRelayStreamPath(ctx context.Context, ownerKind, linkID, avoidRelayID string) (relayresume.OpenedPath, error) {
	assignment := p.relayGrants.lookup("connect", ownerKind, linkID)
	if assignment == nil {
		return relayresume.OpenedPath{}, errors.New("the link has no relay grant")
	}
	candidates := relaybridge.PoolCandidates(assignment, true)
	if len(candidates) == 0 {
		candidates = []*pb.RelayDataCandidate{{RelayInstanceId: relaybridge.LegacyTargetID, Grant: assignment.Grant}}
	}
	ordered := relayStreamDialOrder(p.orderRelayCandidates(candidates), avoidRelayID, p.relayLaneConnected)
	lastErr := errors.New("no relay lane is ready")
	for _, candidate := range ordered {
		if ctx.Err() != nil {
			return relayresume.OpenedPath{}, ctx.Err()
		}
		tunnel := p.selectRelayTunnel(candidate.GetRelayInstanceId())
		if tunnel == nil {
			continue
		}
		grant := relaybridge.GrantForCandidate(candidate)
		if grant == nil {
			tunnel.active.Add(-1)
			continue
		}
		path, err := openRelayStreamPath(ctx, tunnel, grant)
		if err == nil {
			return path, nil
		}
		lastErr = err
	}
	return relayresume.OpenedPath{}, lastErr
}

// relayStreamDialOrder keeps the usual order within each rank: relays with a
// connected lane before the others (a dead lane costs a whole open timeout),
// active before staging, the relay being left last.
func relayStreamDialOrder(ordered []*pb.RelayDataCandidate, avoidRelayID string, connected func(string) bool) []*pb.RelayDataCandidate {
	rank := func(candidate *pb.RelayDataCandidate) int {
		rank := 0
		if avoidRelayID != "" && candidate.GetRelayInstanceId() == avoidRelayID {
			rank += 4
		}
		if !connected(candidate.GetRelayInstanceId()) {
			rank += 2
		}
		if candidate.GetAssignmentState() == "staging" {
			rank++
		}
		return rank
	}
	sort.SliceStable(ordered, func(i, j int) bool { return rank(ordered[i]) < rank(ordered[j]) })
	return ordered
}

// relayLaneConnected reports a relay with at least one connected lane.
func (p *NginxPlugin) relayLaneConnected(relayID string) bool {
	p.relayTunnelMu.Lock()
	defer p.relayTunnelMu.Unlock()
	for _, tunnel := range p.relayTunnels {
		if tunnel.targetID == relayID && tunnel.connected() {
			return true
		}
	}
	return false
}

// openRelayStreamPath opens one tunnel on a lane the caller selected (its
// active count already taken) within OpenTimeout. The stream lives on the
// lane, not on the dial: the path's Cancel ends it and gives the lane back.
func openRelayStreamPath(ctx context.Context, tunnel *nginxRelayTunnel, grant *pb.RelaySignedGrant) (relayresume.OpenedPath, error) {
	streamCtx, cancel := context.WithCancel(tunnel.ctx)
	release := relayStreamPathRelease(tunnel, cancel)
	setup := time.AfterFunc(relayresume.OpenTimeout, cancel)
	stopDial := context.AfterFunc(ctx, cancel)
	fail := func(err error) (relayresume.OpenedPath, error) {
		setup.Stop()
		stopDial()
		release()
		return relayresume.OpenedPath{}, err
	}
	stream, err := tunnel.client.OpenTunnel(streamCtx)
	if err != nil {
		return fail(err)
	}
	if err := stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Open{Open: &relayv1.OpenTunnel{Grant: relayGrant(grant)}}}); err != nil {
		return fail(err)
	}
	first, err := stream.Recv()
	if err != nil {
		return fail(err)
	}
	if first.GetReady() == nil {
		code := "unexpected_frame"
		if relayError := first.GetError(); relayError != nil {
			code = relayError.GetCode()
		}
		return fail(errors.New("relay refused the tunnel: " + code))
	}
	if !setup.Stop() || !stopDial() {
		return fail(errors.New("relay tunnel setup timed out"))
	}
	return relayresume.OpenedPath{
		Stream: stream, Cancel: release, CloseSend: stream.CloseSend,
		RelayID: tunnel.targetID, MaxFrame: int(first.GetReady().GetMaxFrameBytes()),
	}, nil
}

// relayStreamPathRelease ends a path's stream and gives its lane slot back,
// once.
func relayStreamPathRelease(tunnel *nginxRelayTunnel, cancel context.CancelFunc) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			tunnel.active.Add(-1)
		})
	}
}

// bridgeRelayStream serves a connection over a resumable stream whose first
// path is the tunnel just opened. It reports false when the link's streams
// stay raw (the caller bridges the tunnel itself).
func (p *NginxPlugin) bridgeRelayStream(ownerKind, linkID string, connection net.Conn, tunnel *nginxRelayTunnel, stream relayv1.TunnelBroker_OpenTunnelClient, cancel context.CancelFunc, maxFrame, readChunk int) bool {
	assignment := p.relayGrants.lookup("connect", ownerKind, linkID)
	config, ok := p.resumeConfig(ownerKind, linkID, assignment)
	if !ok {
		return false
	}
	first := relayresume.OpenedPath{
		Stream: stream, Cancel: relayStreamPathRelease(tunnel, cancel), CloseSend: stream.CloseSend,
		RelayID: tunnel.targetID, MaxFrame: maxFrame,
	}
	session, err := p.relayStreams.NewSource(config, first)
	if err != nil {
		p.logger.Debug("relay stream stays raw", "link_id", linkID, "error", err)
		return false
	}
	// The stream outlives this lane: only the connection and the session end it.
	_ = relaybridge.BridgeWithChunk(context.Background(), connection, session, session.MaxFrame(), relayresume.ReadChunk(readChunk), session.Cancel)
	return true
}

// moveRelayStreams answers a grant bundle change: a resumable stream whose
// relay candidate turned draining (or left its assignment) moves, paced to
// the drain deadline Gateway set.
func (p *NginxPlugin) moveRelayStreams() {
	if p.relayStreams == nil || p.relayGrants == nil {
		return
	}
	// A route Gateway turned on again (a new key) is tried resumable again
	// even if its target answered raw before (the legacy latch).
	bundle := p.relayGrants.get()
	routes := map[string]bool{}
	for _, assignment := range bundle.GetGrants() {
		if assignment.GetRole() != "connect" || assignment.GetRouteId() == "" {
			continue
		}
		keyID := ""
		if resume := assignment.GetStreamResume(); usableStreamResume(resume) {
			keyID = resume.GetKeyId()
		}
		routes[assignment.GetRouteId()] = true
		p.relayStreams.NoteRouteKey(assignment.GetRouteId(), keyID)
	}
	p.relayStreams.ForgetRoutes(func(routeID string) bool { return routes[routeID] })
	for _, session := range p.relayStreams.Sessions() {
		link, ok := session.Tag().(relayStreamTag)
		relayID := session.RelayID()
		if !ok || relayID == "" {
			continue
		}
		assignment := p.relayGrants.lookup("connect", link.ownerKind, link.linkID)
		if assignment == nil {
			// The link is gone: closeActive ends its connections.
			continue
		}
		state, deadline := relayCandidateState(assignment, relayID)
		// A stream on a staging relay (moved there when no active one took it) stays.
		if state == "active" || state == "staging" {
			continue
		}
		p.relayStreams.Migrate(session, relayresume.TriggerDrain, deadline)
	}
}

// relayCandidateState is the assignment state of relayID for the link and
// its drain deadline ("" when the relay is no longer a candidate).
func relayCandidateState(assignment *pb.RelayGrantAssignment, relayID string) (string, time.Time) {
	candidates := assignment.GetCandidates()
	if len(candidates) == 0 && relayID == relaybridge.LegacyTargetID {
		return "active", time.Time{}
	}
	for _, candidate := range candidates {
		if candidate.GetRelayInstanceId() != relayID {
			continue
		}
		var deadline time.Time
		if ms := candidate.GetDrainDeadlineUnixMs(); ms > 0 {
			deadline = time.UnixMilli(ms)
		}
		return candidate.GetAssignmentState(), deadline
	}
	return "", time.Time{}
}

var _ lifecycle.RelayLaneStatePlugin = (*NginxPlugin)(nil)

// RelayLaneLeftReady moves the streams on a relay at once when a pool lane to
// it stops being ready: GOAWAY from a stopping relay (its open streams live a
// few seconds more), or a lane that broke. Every lane to a relay goes through
// it, so the whole relay is left; a planned move that finds no other relay
// keeps the stream where it is.
func (p *NginxPlugin) RelayLaneLeftReady(relayInstanceID string, _ *grpc.ClientConn) {
	if p.relayStreams != nil {
		p.relayStreams.RelayLost(relayInstanceID)
	}
}

// watchRelayLane does what RelayLaneLeftReady does for the pre-pool lane,
// which the lifecycle does not report.
func (p *NginxPlugin) watchRelayLane(ctx context.Context, conn *grpc.ClientConn, relayID string) {
	if conn == nil || p.relayStreams == nil {
		return
	}
	state := conn.GetState()
	for conn.WaitForStateChange(ctx, state) {
		next := conn.GetState()
		if state == connectivity.Ready && next != connectivity.Ready {
			p.relayStreams.RelayLost(relayID)
		}
		state = next
	}
}

// relayStreamStatsReport is the health report's view of the stream sessions.
func relayStreamStatsReport(stats relayresume.SourceStats) *pb.RelayStreamStats {
	report := &pb.RelayStreamStats{
		ResumableSessions:       stats.Resumable,
		LegacySessions:          stats.Legacy,
		SuspendedSessions:       stats.Suspended,
		MigrationsOkTotal:       stats.MigrationsOK,
		MigrationsFailedTotal:   stats.MigrationsFailed,
		CutTotal:                stats.Cut,
		RetransmittedBytesTotal: stats.Retransmitted,
		UnackedBytes:            stats.Unacked,
		MigrationStallP50Ms:     uint32(stats.StallP50.Milliseconds()),
		MigrationStallP95Ms:     uint32(stats.StallP95.Milliseconds()),
	}
	for relayID, counts := range stats.ByRelay {
		report.ByRelay = append(report.ByRelay, &pb.RelayStreamRelaySessions{RelayInstanceId: relayID, Resumable: counts[0], Legacy: counts[1]})
	}
	return report
}
