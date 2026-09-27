package availabilitylease

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	defaultSimSeeds = 2000
	chaosEnd        = 150 * time.Second
	healTimeout     = 120 * time.Second
	failoverBudget  = 45 * time.Second
	convergeBudget  = 60 * time.Second
)

type simTopology struct {
	relays, daemons int
	candidates      []string
	voters          []string
	replicated      bool
	available       bool
	bootstrap       bool
	adversarial     bool
}

type seedResult struct {
	violation string
	kind      string
	failover  time.Duration
	delivered int
	gateOpen  float64
}

// buildRandomWorld creates a seeded topology, clocks, network and Gateway.
func buildRandomWorld(seed int64, wire bool) (*simWorld, simTopology) {
	w := newSimWorld(seed)
	w.wire = wire
	rng := w.rng
	topo := simTopology{relays: 1 + rng.Intn(3), daemons: 4 + rng.Intn(3)}
	topo.adversarial = rng.Float64() < 0.35
	topo.available = rng.Float64() < 0.15
	topo.replicated = !topo.available && rng.Float64() < 0.2
	topo.bootstrap = rng.Float64() < 0.3
	w.net.loss = rng.Float64() * 0.05
	w.net.dup = rng.Float64() * 0.03
	rate := func(fast bool) float64 {
		if topo.adversarial {
			if fast {
				return 1 + MaxClockDrift
			}
			return 1 - MaxClockDrift
		}
		return 1 - MaxClockDrift + rng.Float64()*2*MaxClockDrift
	}
	for i := 1; i <= topo.relays; i++ {
		w.newNode(fmt.Sprintf("r%d", i), true, rate(true))
	}
	candidates := 2 + rng.Intn(2)
	if topo.replicated {
		candidates = 3 + rng.Intn(2)
	}
	for i := 1; i <= topo.daemons; i++ {
		id := fmt.Sprintf("d%d", i)
		if i <= candidates {
			topo.candidates = append(topo.candidates, id)
		}
		w.newNode(id, false, rate(i > candidates)).detectSuspend = rng.Intn(2) == 0
	}
	topo.voters = pickVoters(w, topo.relays)
	w.gw = newSimGateway(w)
	policy := &simPolicy{id: "p1", slots: 1, available: topo.available, candidates: topo.candidates, bootstrap: map[uint32]string{}}
	if topo.replicated {
		policy.slots = 2
	}
	if topo.bootstrap {
		policy.bootstrapID = 1
		policy.bootstrap[0] = topo.candidates[0]
		w.nodes[topo.candidates[0]].containers[Key{PolicyID: "p1"}] = &simContainer{live: true, legacy: true}
	}
	w.gw.policies["p1"] = policy
	w.strict["p1"] = !topo.available
	for slot := uint32(0); slot < policy.slots; slot++ {
		w.keys = append(w.keys, Key{PolicyID: "p1", Slot: slot})
	}
	w.gw.buildConfig([][]string{topo.voters})
	w.gw.buildManifest(policy)
	if rng.Float64() < 0.35 {
		// A second strict failover policy with the reverse candidate order,
		// so holders batch renewals of several keys into shared frames.
		second := &simPolicy{id: "p2", slots: 1, bootstrap: map[uint32]string{}}
		for i := len(topo.candidates) - 1; i >= 0; i-- {
			second.candidates = append(second.candidates, topo.candidates[i])
		}
		w.gw.policies["p2"] = second
		w.strict["p2"] = true
		w.keys = append(w.keys, Key{PolicyID: "p2"})
		w.gw.buildManifest(second)
	}
	return w, topo
}

// pickVoters takes every relay and enough daemons for an odd count of at
// least three; with an even count the first (local) relay does not vote (D2).
func pickVoters(w *simWorld, relays int) []string {
	daemons := 2 + w.rng.Intn(3)
	if daemons > len(w.daemons) {
		daemons = len(w.daemons)
	}
	var voters []string
	start := 0
	if (relays+daemons)%2 == 0 {
		if relays > 1 {
			start = 1
		} else {
			daemons--
		}
	}
	voters = append(voters, w.relays[start:]...)
	for _, i := range w.rng.Perm(len(w.daemons))[:daemons] {
		voters = append(voters, w.daemons[i])
	}
	sort.Strings(voters)
	return voters
}

func startWorld(w *simWorld, deliverP float64) {
	w.gw.deliverP = deliverP
	for _, id := range w.ids {
		w.nodes[id].start()
	}
	w.gw.deliverP = 1
}

// runRandomSeed runs one seeded scenario: chaos, heal, then I3 (strict:
// kill the holder, a successor must commit within 45 s) or I4 (available:
// one copy after the heal).
func runRandomSeed(seed int64, trace, wire bool) (*simWorld, seedResult) {
	w, topo := buildRandomWorld(seed, wire)
	w.traceOn = trace
	startWorld(w, 0.85)
	scheduleChaos(w, topo)
	w.runUntil(chaosEnd)
	result := seedResult{}
	if w.violation == "" {
		quiet(w, topo)
		if topo.available {
			checkConvergence(w, topo, &result)
		} else {
			checkFailover(w, topo, &result)
		}
	}
	result.delivered = w.delivered
	if w.gateChecks > 0 {
		result.gateOpen = float64(w.gateOpenChecks) / float64(w.gateChecks)
	}
	if w.violation != "" {
		result.violation = w.violation
	}
	return w, result
}

func checkFailover(w *simWorld, topo simTopology, result *seedResult) {
	key := Key{PolicyID: "p1"}
	if !w.waitFor(healTimeout, func() bool { return w.holder(key) != "" }) {
		if w.violation == "" && !bootstrapStuck(w, topo) && w.canLearnManifest(topo) {
			w.fail("liveness: no holder %s after heal (live copies %v; %s)", healTimeout, w.liveCopies(key), w.describeCandidates(topo, key))
		}
		result.kind = "no-holder"
		return
	}
	// Let a candidate that restarted without state learn the blocks from
	// the holder's frames (A4 forwarding) before the kill.
	w.waitFor(30*time.Second, func() bool { return w.successorsInformed(topo, w.holder(key)) })
	w.runUntil(w.now + time.Duration(w.rng.Int63n(int64(5*time.Second))))
	holder := w.holder(key)
	if holder == "" {
		result.kind = "holder-moved"
		return
	}
	if !w.successorsInformed(topo, holder) {
		result.kind = "no-informed-successor"
		return
	}
	w.nodes[holder].crashHost()
	killedAt := w.now
	w.acquired = nil
	ok := w.waitFor(failoverBudget+10*time.Second, func() bool {
		for _, acquired := range w.acquired {
			if acquired.key == key && acquired.node != holder {
				result.failover = acquired.at - killedAt
				return true
			}
		}
		return false
	})
	if w.violation != "" {
		return
	}
	if !ok || result.failover > failoverBudget {
		w.fail("I3 violated: no successor for %s within %s of killing %s (took %s)", key, failoverBudget, holder, result.failover)
	}
	result.kind = "failover"
}

// successorsInformed reports whether every up candidate other than holder
// has the holder's manifest version and epoch.
func (w *simWorld) successorsInformed(topo simTopology, holder string) bool {
	if holder == "" {
		return false
	}
	h := w.nodes[holder].node
	for _, id := range topo.candidates {
		n := w.nodes[id]
		if id == holder || !n.processUp() {
			continue
		}
		if n.node.ManifestVersion("p1") < h.ManifestVersion("p1") || n.node.Epoch() < h.Epoch() {
			return false
		}
	}
	return true
}

// canLearnManifest is false when no ready candidate holds the manifest and
// config and no Gateway is left to deliver them: a daemon that lost its
// state while the Gateway is down waits for the Gateway (documented limit).
func (w *simWorld) canLearnManifest(topo simTopology) bool {
	if w.gw.alive {
		return true
	}
	for _, id := range topo.candidates {
		n := w.nodes[id]
		if n.processUp() && n.node.ManifestVersion("p1") > 0 && n.node.Epoch() > 0 {
			return true
		}
	}
	return false
}

func (w *simWorld) describeCandidates(topo simTopology, key Key) string {
	var parts []string
	for _, id := range topo.candidates {
		n := w.nodes[id]
		if !n.processUp() {
			parts = append(parts, id+":down")
			continue
		}
		st := n.node.HolderStatus(key)
		parts = append(parts, fmt.Sprintf("%s:%s v%d e%d", id, st.Role, n.node.ManifestVersion("p1"), n.node.Epoch()))
	}
	return strings.Join(parts, " ")
}

// bootstrapStuck reports the designed outcome where the named bootstrap
// holder died before acquiring and no Gateway is left to reissue (A5).
func bootstrapStuck(w *simWorld, topo simTopology) bool {
	return topo.bootstrap && !w.gw.alive && w.gw.policies["p1"].bootstrap[0] != ""
}

// checkConvergence: I4, within convergeBudget of the heal every key runs
// exactly one copy, and keeps running exactly one for another 30 s.
func checkConvergence(w *simWorld, topo simTopology, result *seedResult) {
	result.kind = "converge"
	w.runUntil(w.now + convergeBudget)
	end := w.now + 30*time.Second
	for w.violation == "" && w.now < end {
		for _, key := range w.keys {
			if copies := w.liveCopies(key); len(copies) != 1 {
				if len(copies) == 0 && (!w.canLearnManifest(topo) || bootstrapStuck(w, topo)) {
					result.kind = "no-manifest"
					return
				}
				w.fail("I4 violated: key %s runs %v copies %s after the heal (%s)", key, copies, convergeBudget, w.describeCandidates(topo, key))
			}
		}
		w.runUntil(w.now + 250*time.Millisecond)
	}
}

func envInt(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value > 0 {
		return value
	}
	return fallback
}

// TestSimulationRandomSeeds runs AVAILABILITY_LEASE_SIM_SEEDS seeded worlds
// (default 2000) starting at AVAILABILITY_LEASE_SIM_SEED_START. For a long
// soak set AVAILABILITY_LEASE_SIM_SEEDS=200000.
func TestSimulationRandomSeeds(t *testing.T) {
	seeds := envInt("AVAILABILITY_LEASE_SIM_SEEDS", defaultSimSeeds)
	first := int64(envInt("AVAILABILITY_LEASE_SIM_SEED_START", 1))
	var next atomic.Int64
	next.Store(first)
	var mu sync.Mutex
	var failures []int64
	kinds := map[string]int{}
	var worst time.Duration
	var gateOpen float64
	var wg sync.WaitGroup
	// At most AVAILABILITY_LEASE_SIM_WORKERS (default 3) workers, never more
	// than GOMAXPROCS, so a run does not take over a developer machine.
	workers := min(envInt("AVAILABILITY_LEASE_SIM_WORKERS", 3), runtime.GOMAXPROCS(0))
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				seed := next.Add(1) - 1
				if seed >= first+int64(seeds) {
					return
				}
				_, result := runRandomSeed(seed, false, false)
				mu.Lock()
				kinds[result.kind]++
				gateOpen += result.gateOpen
				if result.failover > worst {
					worst = result.failover
				}
				if result.violation != "" {
					failures = append(failures, seed)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	t.Logf("seeds=%d outcomes=%v worst failover=%s mean gate-open share=%.1f%%", seeds, kinds, worst, 100*gateOpen/float64(seeds))
	if len(failures) > 0 {
		sort.Slice(failures, func(i, j int) bool { return failures[i] < failures[j] })
		for i, seed := range failures {
			if i == 12 {
				break
			}
			_, result := runRandomSeed(seed, false, false)
			t.Logf("seed %d: %s", seed, result.violation)
		}
		w, result := runRandomSeed(failures[0], true, false)
		t.Fatalf("%d/%d seeds violated invariants; first seed %d: %s\ntrace tail:\n%s",
			len(failures), seeds, failures[0], result.violation, w.dumpTrace(250))
	}
}

// TestSimulationWireSeeds runs seeds through real ECDSA frame sealing and
// verification and protobuf encoding.
func TestSimulationWireSeeds(t *testing.T) {
	for seed := int64(900001); seed < 900001+int64(envInt("AVAILABILITY_LEASE_SIM_WIRE_SEEDS", 6)); seed++ {
		w, result := runRandomSeed(seed, false, true)
		if result.violation != "" {
			w, result = runRandomSeed(seed, true, true)
			t.Fatalf("wire seed %d: %s\n%s", seed, result.violation, w.dumpTrace(250))
		}
	}
}

// TestSimulationTraceSeed writes the full trace of AVAILABILITY_LEASE_SIM_TRACE_SEED
// to AVAILABILITY_LEASE_SIM_TRACE_FILE, for debugging a failing seed.
func TestSimulationTraceSeed(t *testing.T) {
	seed := envInt("AVAILABILITY_LEASE_SIM_TRACE_SEED", 0)
	path := os.Getenv("AVAILABILITY_LEASE_SIM_TRACE_FILE")
	if seed == 0 || path == "" {
		t.Skip("set AVAILABILITY_LEASE_SIM_TRACE_SEED and AVAILABILITY_LEASE_SIM_TRACE_FILE")
	}
	w, result := runRandomSeed(int64(seed), true, os.Getenv("AVAILABILITY_LEASE_SIM_WIRE") != "")
	if err := os.WriteFile(path, []byte(w.dumpTrace(len(w.trace))), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("seed %d: kind=%s failover=%s delivered=%d violation=%q", seed, result.kind, result.failover, result.delivered, result.violation)
}
