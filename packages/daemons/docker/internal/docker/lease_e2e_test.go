package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
)

const e2ePolicy = "policy-e2e"

type e2eClock struct{ now atomic.Int64 }

func (c *e2eClock) Now() time.Duration      { return time.Duration(c.now.Load()) }
func (c *e2eClock) advance(d time.Duration) { c.now.Add(int64(d)) }
func (c *e2eClock) wall() time.Time         { return time.Unix(1_800_000_000, 0).Add(c.Now()) }
func newE2EClock() *e2eClock                { c := &e2eClock{}; c.now.Store(int64(time.Hour)); return c }
func e2eDiscard() *slog.Logger              { return slog.New(slog.NewTextHandler(io.Discard, nil)) }
func e2eKey() *ecdsa.PrivateKey             { k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader); return k }
func e2eDER(key *ecdsa.PrivateKey) []byte {
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return der
}
func e2eContainerID(host string) string { return fmt.Sprintf("%064x", []byte(host)) }

// e2eRelay is a minimal relay speaking T2's Coordinate RPC: it is an
// acceptor itself and routes other frames by destination to the newest
// stream of that member.
type e2eRelay struct {
	relayv1.UnimplementedTunnelBrokerServer
	id      string
	key     *ecdsa.PrivateKey
	node    *availabilitylease.Node
	mu      sync.Mutex
	streams map[string]chan *relayv1.CoordinationFrame
}

func (r *e2eRelay) Send(frame *relayv1.CoordinationFrame) {
	r.mu.Lock()
	out := r.streams[frame.GetDestinationId()]
	r.mu.Unlock()
	if out != nil {
		select {
		case out <- frame:
		default:
		}
	}
}

func (r *e2eRelay) Coordinate(stream grpc.BidiStreamingServer[relayv1.CoordinationFrame, relayv1.CoordinationFrame]) error {
	out := make(chan *relayv1.CoordinationFrame, 256)
	go func() {
		for {
			select {
			case <-stream.Context().Done():
				return
			case frame := <-out:
				if stream.Send(frame) != nil {
					return
				}
			}
		}
	}()
	for {
		frame, err := stream.Recv()
		if err != nil {
			return err
		}
		r.mu.Lock()
		r.streams[frame.GetSenderId()] = out
		r.mu.Unlock()
		if frame.GetDestinationId() == r.id {
			_ = r.node.ReceiveFrame(frame)
		} else {
			r.Send(frame)
		}
	}
}

// e2eEngine is a thread-safe fake Docker for one host.
type e2eEngine struct {
	mu        sync.Mutex
	container lease.Container
}

func (e *e2eEngine) running() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.container.Running
}

func (e *e2eEngine) ListLeaseContainers(context.Context) ([]lease.Container, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return []lease.Container{e.container}, nil
}
func (e *e2eEngine) Inspect(context.Context, string) (lease.Container, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.container, true, nil
}
func (e *e2eEngine) set(running bool) error {
	e.mu.Lock()
	e.container.Running = running
	e.mu.Unlock()
	return nil
}
func (e *e2eEngine) Start(context.Context, string) error               { return e.set(true) }
func (e *e2eEngine) Stop(context.Context, string, time.Duration) error { return e.set(false) }
func (e *e2eEngine) Kill(context.Context, string) error                { return e.set(false) }
func (e *e2eEngine) DisableRestart(context.Context, string) error {
	e.mu.Lock()
	e.container.RestartPolicy = "no"
	e.mu.Unlock()
	return nil
}
func (e *e2eEngine) CgroupEmpty(context.Context, lease.Container) (bool, error) {
	return !e.running(), nil
}

type e2eFence struct {
	mu      sync.Mutex
	records map[string]leasefence.Record
}

func (f *e2eFence) HeartbeatFresh(time.Duration) bool { return true }
func (f *e2eFence) Records() (map[string]leasefence.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]leasefence.Record{}
	for id, record := range f.records {
		out[id] = record
	}
	return out, nil
}
func (f *e2eFence) WriteRecord(record leasefence.Record) error {
	f.mu.Lock()
	f.records[record.ContainerID] = record
	f.mu.Unlock()
	return nil
}
func (f *e2eFence) DeleteRecord(id string) error {
	f.mu.Lock()
	delete(f.records, id)
	f.mu.Unlock()
	return nil
}

type e2eDaemon struct {
	id     string
	key    *ecdsa.PrivateKey
	dir    string
	keys   *identityKeys
	plugin *DockerPlugin
	engine *e2eEngine
}

func TestLeaseEndToEndThroughCommandHandlerAndCoordinateRPC(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	clock := newE2EClock()
	// Per-policy voters (A18/A19): the two candidates plus one witness relay.
	// relay-2 only routes and keeps shadow accepts for its gate.
	relays := []*e2eRelay{{id: "relay-witness"}, {id: "relay-2"}}
	daemons := []*e2eDaemon{{id: "node-1"}, {id: "node-2"}}
	for _, d := range daemons {
		d.key = e2eKey()
	}
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(rand.Reader)
	manifest := &relayv1.LeaseManifest{
		SchemaVersion: 1, PolicyId: e2ePolicy, ManifestVersion: 1, Slots: 1, VoterEpoch: 1, LeaseTermMs: 30000,
		Mode: relayv1.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: relayv1.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		QuorumSets: []*relayv1.LeaseQuorumSet{{VoterIds: []string{"node-1", "node-2", "relay-witness"}}},
	}
	for _, relay := range relays {
		relay.key = e2eKey()
		manifest.Members = append(manifest.Members, &relayv1.LeaseMember{Id: relay.id, PublicKey: e2eDER(relay.key), Role: relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY})
	}
	for _, d := range daemons {
		manifest.Candidates = append(manifest.Candidates, &relayv1.LeaseCandidate{Id: d.id, PublicKey: e2eDER(d.key)})
		manifest.Members = append(manifest.Members, &relayv1.LeaseMember{Id: d.id, PublicKey: e2eDER(d.key), Role: relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON})
	}
	manifestPayload, _ := proto.Marshal(manifest)
	manifestBlock := availabilitylease.SignPolicyBlock("k1", policyPrivate, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, manifestPayload)

	conns := map[string]*grpc.ClientConn{}
	for _, relay := range relays {
		relay.streams = map[string]chan *relayv1.CoordinationFrame{}
		node, err := availabilitylease.NewNode(availabilitylease.Config{
			ID: relay.id, Clock: clock, Store: availabilitylease.NewMemoryStore(), Transport: relay,
			Signer: availabilitylease.ECDSASigner{Key: relay.key}, IncarnationFloor: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		relay.node = node
		_ = node.TrustPolicyKey("k1", policyPublic)
		_, _ = node.AdoptManifest(manifestBlock)
		listener := bufconn.Listen(1 << 20)
		server := grpc.NewServer()
		relayv1.RegisterTunnelBrokerServer(server, relay)
		go func() { _ = server.Serve(listener) }()
		defer server.Stop()
		conn, err := grpc.NewClient("passthrough:///"+relay.id,
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return listener.DialContext(ctx) }),
			grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		conns[relay.id] = conn
	}

	for _, d := range daemons {
		d.plugin = availabilityPluginForTest(t)
		d.engine = &e2eEngine{container: lease.Container{
			ID: e2eContainerID(d.id), Name: "app-" + d.id, PolicyID: e2ePolicy, RestartPolicy: "unless-stopped", Labels: map[string]string{},
		}}
		// The production signer over mTLS files, so a certificate renewal
		// can happen mid-lease (H3).
		d.dir = t.TempDir()
		certPath, keyPath := writeIdentityFiles(t, d.dir, d.key)
		keys, err := newIdentityKeys(certPath, keyPath, filepath.Join(d.dir, "previous-identity.json"))
		if err != nil {
			t.Fatal(err)
		}
		d.keys = keys
		integration := &leaseIntegration{plugin: d.plugin, serving: map[string]bool{}, identity: keys.publicKeyDER}
		runtime, err := lease.New(lease.Options{
			NodeID: d.id, StateDir: t.TempDir(), Clock: clock, Wall: clock.wall, Signer: keys.InitialSigner(), Identity: keys,
			Engine: d.engine, Fence: &e2eFence{records: map[string]leasefence.Record{}}, Endpoints: integration, Placements: integration,
			Logger: e2eDiscard(),
		})
		if err != nil {
			t.Fatal(err)
		}
		integration.runtime = runtime
		d.plugin.lease = integration
		for id, conn := range conns {
			integration.attachRelay(ctx, conn, id)
		}
		// The manifest arrives through the real command handler (T3's
		// SyncAvailabilityLeaseCommand).
		result := d.plugin.HandleCommand(&pb.GatewayCommand{CommandId: "sync", Payload: &pb.GatewayCommand_SyncAvailabilityLease{
			SyncAvailabilityLease: &pb.SyncAvailabilityLeaseCommand{
				Revision: 1, MemberId: d.id, Manifests: [][]byte{mustMarshal(t, manifestBlock)},
				PolicyKeys: []*pb.AvailabilityLeasePolicyKey{{KeyId: "k1", PublicKey: policyPublic}},
			},
		}})
		if !result.Success {
			t.Fatalf("%s sync failed: %s", d.id, result.Error)
		}
	}

	bothRan := false
	step := func() {
		clock.advance(100 * time.Millisecond)
		for _, relay := range relays {
			relay.node.Tick()
		}
		for _, d := range daemons {
			d.plugin.lease.runtime.Step()
		}
		time.Sleep(3 * time.Millisecond)
		if daemons[0].engine.running() && daemons[1].engine.running() {
			bothRan = true
		}
	}
	runUntil := func(limit time.Duration, cond func() bool) bool {
		for end := clock.Now() + limit; clock.Now() < end; {
			if cond() {
				return true
			}
			step()
		}
		return cond()
	}

	serving := func(d *e2eDaemon) bool {
		d.plugin.lease.mu.Lock()
		defer d.plugin.lease.mu.Unlock()
		return d.engine.running() && d.plugin.lease.serving[e2ePolicy]
	}
	if !runUntil(60*time.Second, func() bool { return serving(daemons[0]) }) {
		t.Fatal("rank 0 did not acquire and serve over the Coordinate RPC")
	}
	activate := availabilityCommand(availabilityActionActivate, 1, "activate", "op", "")
	activate.PolicyId = e2ePolicy
	if result := daemons[1].plugin.HandleCommand(availabilityGatewayCommand(activate)); result.Success {
		t.Fatal("the standby accepted a backend serve command without the lease (A5)")
	}
	runUntil(20*time.Second, func() bool { return false })
	if !serving(daemons[0]) || daemons[1].engine.running() {
		t.Fatal("the holder must keep its lease through renewals")
	}
	report := daemons[0].plugin.availabilityLeaseReport()
	if report.GetMemberId() != "node-1" || !report.GetWatchdogReady() || report.GetLeaseRevision() != 1 || len(report.GetIdentityPublicKey()) == 0 ||
		len(report.GetHeld()) != 1 || report.GetHeld()[0].GetRole() != "holding" || report.GetHeld()[0].GetBallot().GetProposerId() != "node-1" ||
		len(report.GetManifests()) != 1 || report.GetManifests()[0].GetManifestVersion() != 1 || len(report.GetTrustedPolicyKeyIds()) != 1 {
		t.Fatalf("holder report incomplete: %v", report)
	}

	// H3: the holder's certificate renews mid-lease. The node dual-signs with
	// the old and the renewed key, so peers that still list the old key keep
	// accepting its frames and nothing fences.
	renewed := e2eKey()
	writeIdentityFiles(t, daemons[0].dir, renewed)
	holder := daemons[0].plugin.lease.runtime.Node()
	fencedDuringRenewal := false
	watch := func() bool {
		fencedDuringRenewal = fencedDuringRenewal || !daemons[0].engine.running()
		return false
	}
	runUntil(20*time.Second, watch)
	if fencedDuringRenewal || !serving(daemons[0]) || !holder.IdentityOverlap() {
		t.Fatal("a certificate renewal mid-lease must dual-sign and not fence the holder")
	}
	if string(daemons[0].plugin.availabilityLeaseReport().GetIdentityPublicKey()) != string(e2eDER(renewed)) {
		t.Fatal("the report must carry the renewed key so the Gateway republishes")
	}
	// The Gateway republishes the manifest with the renewed key (v2). The
	// relays and the other daemon adopt it BEFORE the holder: they now list
	// only the renewed key, and must still accept the holder's frames.
	manifest.ManifestVersion = 2
	for _, candidate := range manifest.Candidates {
		if candidate.GetId() == "node-1" {
			candidate.PublicKey = e2eDER(renewed)
		}
	}
	for _, member := range manifest.Members {
		if member.GetId() == "node-1" {
			member.PublicKey = e2eDER(renewed)
		}
	}
	renewedPayload, _ := proto.Marshal(manifest)
	renewedBlock := availabilitylease.SignPolicyBlock("k1", policyPrivate, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, renewedPayload)
	sync := func(d *e2eDaemon) {
		result := d.plugin.HandleCommand(&pb.GatewayCommand{CommandId: "sync-2", Payload: &pb.GatewayCommand_SyncAvailabilityLease{
			SyncAvailabilityLease: &pb.SyncAvailabilityLeaseCommand{
				Revision: 2, MemberId: d.id, Manifests: [][]byte{mustMarshal(t, renewedBlock)},
				PolicyKeys: []*pb.AvailabilityLeasePolicyKey{{KeyId: "k1", PublicKey: policyPublic}},
			},
		}})
		if !result.Success {
			t.Fatalf("%s sync v2 failed: %s", d.id, result.Error)
		}
	}
	for _, relay := range relays {
		if _, err := relay.node.AdoptManifest(renewedBlock); err != nil {
			t.Fatal(err)
		}
	}
	sync(daemons[1])
	if holder.ManifestVersion(e2ePolicy) != 1 {
		t.Fatal("the holder must still lag behind its peers here")
	}
	runUntil(40*time.Second, watch)
	if fencedDuringRenewal || !serving(daemons[0]) {
		t.Fatal("peers that adopted the renewed key first must keep accepting the holder's frames")
	}
	// Once the holder too lists only the renewed key, the overlap retires.
	sync(daemons[0])
	runUntil(10*time.Second, watch)
	if fencedDuringRenewal || !serving(daemons[0]) || holder.IdentityOverlap() {
		t.Fatal("after every manifest lists the renewed key the holder retires the old key and keeps its lease")
	}
	if _, err := os.Stat(filepath.Join(daemons[0].dir, "previous-identity.json")); !os.IsNotExist(err) {
		t.Fatal("the persisted previous key is removed when the overlap ends")
	}

	voterView := daemons[1].plugin.availabilityLeaseReport().GetAcceptor()
	// The holder completes rounds with the fastest majority, so this voter's
	// own hold may have lapsed; it must still show the policy's voter epoch
	// and the holder's ballots it promised.
	if len(voterView) != 1 || voterView[0].GetPolicyId() != e2ePolicy || voterView[0].GetEpoch() != 1 ||
		voterView[0].GetPromised().GetProposerId() != "node-1" || voterView[0].GetState() == "abstaining" {
		t.Fatalf("a candidate voter must report its per-policy acceptor view (A18): %v", voterView)
	}
	handoff := daemons[0].plugin.HandleCommand(&pb.GatewayCommand{CommandId: "handoff", Payload: &pb.GatewayCommand_AvailabilityLeaseHandoff{
		AvailabilityLeaseHandoff: &pb.AvailabilityLeaseHandoffCommand{PolicyId: e2ePolicy, SuccessorId: "node-2", OperationId: "op-1", ManifestVersion: 1},
	}})
	if !handoff.Success {
		t.Fatalf("handoff refused: %s", handoff.Error)
	}
	if !runUntil(20*time.Second, func() bool { return serving(daemons[1]) }) {
		t.Fatal("the designated successor did not take over")
	}
	if bothRan || daemons[0].engine.running() {
		t.Fatal("two copies ran during the handoff")
	}
	found := false
	for _, event := range daemons[0].plugin.availabilityLeaseReport().GetEvents() {
		found = found || (event.GetKind() == "handoff" && event.GetSuccessorId() == "node-2")
	}
	if !found {
		t.Fatal("the holder report must carry the handoff event")
	}
	if err := daemons[1].plugin.leaseGate(availabilityGatewayCommand(activate)); err != nil {
		t.Fatalf("the new holder must pass the backend serve gate: %v", err)
	}
	if err := daemons[0].plugin.leaseGate(availabilityGatewayCommand(activate)); err == nil {
		t.Fatal("the previous holder must refuse backend serve commands after the handoff")
	}
	standby := availabilityCommand(availabilityActionPrepare, 2, "re:standby", "op", `{"phase":"standby","runtimeIdentity":{"containerId":"c"}}`)
	standby.PolicyId = e2ePolicy
	if err := daemons[1].plugin.leaseGate(availabilityGatewayCommand(standby)); err == nil {
		t.Fatal("the holder must not be re-prepared as a standby")
	}
	if err := daemons[0].plugin.leaseGate(availabilityGatewayCommand(standby)); err != nil {
		t.Fatalf("the former holder is re-prepared as a standby after the handoff: %v", err)
	}
}

func mustMarshal(t *testing.T, message proto.Message) []byte {
	t.Helper()
	data, err := proto.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
