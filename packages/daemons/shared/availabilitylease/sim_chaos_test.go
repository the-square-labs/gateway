package availabilitylease

import (
	"time"
)

type faultKind int

const (
	faultPartition faultKind = iota
	faultIsolateHolder
	faultLossBurst
	faultDelaySpike
	faultAcceptorRestart
	faultProposerRestart
	faultFreeze
	faultHostReboot
	faultDockerHang
	faultEpochChange
	faultManifestBump
	faultHandoff
	faultHealthRelease
	faultKeyRotation
	faultRateChange
	faultKinds
)

var faultNames = [...]string{
	"partition", "isolate-holder", "loss-burst", "delay-spike", "acceptor-restart", "proposer-restart",
	"freeze", "host-reboot", "docker-hang", "epoch-change", "manifest-bump", "handoff", "health-release",
	"key-rotation", "rate-change",
}

// scheduleChaos places random faults between 3 s and chaosEnd-5 s. The
// Gateway dies at a random time in 30% of seeds.
func scheduleChaos(w *simWorld, topo simTopology) {
	if w.rng.Float64() < 0.3 {
		w.at(w.randDuration(10*time.Second, chaosEnd), func() {
			w.gw.alive = false
			w.tracef("gateway dies")
		})
	}
	w.after(5*time.Second, func() { gatewayBootstrapLoop(w) })
	at := 3 * time.Second
	minGap, maxGap := 3*time.Second, 12*time.Second
	if w.rng.Float64() < 0.25 {
		// Fault storm.
		minGap, maxGap = 500*time.Millisecond, 4*time.Second
	}
	for {
		at += w.randDuration(minGap, maxGap)
		if at >= chaosEnd-5*time.Second {
			return
		}
		kind := faultKind(w.rng.Intn(int(faultKinds)))
		w.at(at, func() { applyFault(w, topo, kind) })
	}
}

// gatewayBootstrapLoop drops the bootstrap reservation once its holder
// reported acquiring (A5), like the Gateway does on the lease report.
func gatewayBootstrapLoop(w *simWorld) {
	policy := w.gw.policies["p1"]
	if policy.bootstrap[0] == "" || !w.gw.alive {
		return
	}
	for _, acquired := range w.acquired {
		if acquired.node == policy.bootstrap[0] && acquired.key == w.keys[0] {
			policy.bootstrap = map[uint32]string{}
			w.gw.republish("p1", 1)
			w.tracef("gateway drops bootstrap reservation")
			return
		}
	}
	w.after(5*time.Second, func() { gatewayBootstrapLoop(w) })
}

func (w *simWorld) pick(ids []string) string { return ids[w.rng.Intn(len(ids))] }

func (w *simWorld) currentHolderOr(topo simTopology) string {
	if holder := w.holder(w.keys[0]); holder != "" {
		return holder
	}
	return w.pick(topo.candidates)
}

func (w *simWorld) downLinks(links []*simLink, duration time.Duration) {
	for _, l := range links {
		l.downCount++
		l.up = false
	}
	w.after(duration, func() {
		for _, l := range links {
			if l.downCount > 0 {
				l.downCount--
			}
			l.up = l.downCount == 0
		}
	})
}

func applyFault(w *simWorld, topo simTopology, kind faultKind) {
	w.tracef("fault %s", faultNames[kind])
	switch kind {
	case faultPartition:
		isolated := map[string]bool{}
		for _, id := range w.ids {
			isolated[id] = w.rng.Float64() < 0.35
		}
		var links []*simLink
		for _, d := range w.daemons {
			for _, r := range w.relays {
				if isolated[d] != isolated[r] {
					links = append(links, w.link(d, r))
				}
			}
		}
		w.downLinks(links, w.randDuration(5*time.Second, 60*time.Second))
	case faultIsolateHolder:
		holder := w.currentHolderOr(topo)
		keep := ""
		if w.rng.Intn(2) == 0 {
			keep = w.pick(w.relays)
		}
		var links []*simLink
		for _, r := range w.relays {
			if r != keep {
				links = append(links, w.link(holder, r))
			}
		}
		w.tracef("isolate %s keep=%q", holder, keep)
		w.downLinks(links, w.randDuration(5*time.Second, 60*time.Second))
	case faultLossBurst:
		w.net.loss += 0.3
		w.after(w.randDuration(5*time.Second, 20*time.Second), func() { w.net.loss -= 0.3 })
	case faultDelaySpike:
		var links []*simLink
		for _, d := range w.daemons {
			for _, r := range w.relays {
				if w.rng.Intn(3) == 0 {
					links = append(links, w.link(d, r))
				}
			}
		}
		for _, l := range links {
			l.minDelay, l.maxDelay = 500*time.Millisecond, w.randDuration(time.Second, 4*time.Second)
		}
		w.after(w.randDuration(5*time.Second, 30*time.Second), func() {
			for _, l := range links {
				l.minDelay, l.maxDelay = w.net.minDelay, w.net.maxDelay
			}
		})
	case faultAcceptorRestart:
		n := w.nodes[w.pick(w.gw.sets[len(w.gw.sets)-1])]
		wipe := w.rng.Float64() < 0.4
		restartProcess(w, n, wipe, w.randDuration(500*time.Millisecond, 15*time.Second))
	case faultProposerRestart:
		restartProcess(w, w.nodes[w.pick(topo.candidates)], false, w.randDuration(500*time.Millisecond, 30*time.Second))
	case faultFreeze:
		id := w.pick(topo.candidates)
		if w.rng.Float64() < 0.7 {
			id = w.currentHolderOr(topo)
		}
		n := w.nodes[id]
		n.freeze()
		w.after(w.randDuration(2*time.Second, 60*time.Second), n.resume)
	case faultHostReboot:
		n := w.nodes[w.pick(w.daemons)]
		if !n.hostUp {
			return
		}
		n.crashHost()
		w.after(w.randDuration(5*time.Second, 40*time.Second), func() {
			if !n.hostUp && !w.chaosOver {
				n.bootHost()
			}
		})
	case faultDockerHang:
		n := w.nodes[w.pick(topo.candidates)]
		n.hangUntil = w.now + w.randDuration(5*time.Second, 30*time.Second)
	case faultEpochChange:
		w.gw.changeVoters(pickVoters(w, len(w.relays)), 0.6)
	case faultManifestBump:
		policy := w.gw.policies["p1"]
		if w.rng.Intn(2) == 0 {
			order := append([]string(nil), policy.candidates...)
			w.rng.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
			policy.candidates = order
		}
		w.gw.republish("p1", 0.5)
	case faultHandoff, faultHealthRelease:
		if !w.gw.alive && kind == faultHandoff {
			return
		}
		holder := w.holder(w.keys[0])
		if holder == "" {
			return
		}
		successor := ""
		if kind == faultHandoff {
			for _, id := range w.rng.Perm(len(topo.candidates)) {
				if c := topo.candidates[id]; c != holder && w.nodes[c].processUp() {
					successor = c
					break
				}
			}
		}
		if w.nodes[holder].beginDrain(w.keys[0], successor) {
			w.tracef("drain %s successor=%q", holder, successor)
		}
	case faultKeyRotation:
		w.gw.rotateKey(0.7)
		if w.rng.Float64() < 0.4 {
			// A14 scenario: the Gateway signs one manifest with the new key,
			// reaches only a few nodes, and dies.
			w.after(w.randDuration(2*time.Second, 6*time.Second), func() {
				if w.gw.alive && w.gw.signIdx == len(w.gw.keys)-1 {
					w.gw.republish("p1", 0.25)
					w.gw.alive = false
					w.tracef("gateway dies after rotated manifest")
				}
			})
		}
	case faultRateChange:
		n := w.nodes[w.pick(w.ids)]
		n.setRate(1 - MaxClockDrift + w.rng.Float64()*2*MaxClockDrift)
	}
}

func restartProcess(w *simWorld, n *simNode, wipe bool, downtime time.Duration) {
	if !n.processUp() {
		return
	}
	w.tracef("%s process restart wipe=%v downtime=%s", n.id, wipe, downtime)
	n.stopProcess()
	if wipe {
		n.store.Wipe()
	}
	w.after(downtime, func() {
		if n.hostUp && !n.procUp && !w.chaosOver {
			n.start()
		}
	})
}

// quiet heals every fault: links, loss, freezes, crashed hosts and processes.
func quiet(w *simWorld, topo simTopology) {
	w.tracef("quiet phase")
	w.chaosOver = true
	w.net.loss, w.net.dup = 0, 0
	for _, l := range w.links {
		l.downCount = 0
	}
	w.healAll()
	for _, id := range w.ids {
		n := w.nodes[id]
		n.hangUntil = 0
		if n.frozen {
			n.resume()
		}
		if !n.hostUp {
			n.bootHost()
		} else if !n.procUp {
			n.start()
		}
	}
	if w.gw.alive {
		// Reconnected streams get the current state again.
		for _, id := range w.ids {
			if n := w.nodes[id]; n.processUp() {
				w.gw.onNodeStart(n)
				n.after()
			}
		}
	}
	policy := w.gw.policies["p1"]
	if holder := policy.bootstrap[0]; holder != "" && w.gw.alive {
		if c := w.nodes[holder].containers[w.keys[0]]; c == nil || !c.live || !c.legacy {
			policy.bootstrap = map[uint32]string{}
			w.gw.republish("p1", 1)
		}
	}
}
