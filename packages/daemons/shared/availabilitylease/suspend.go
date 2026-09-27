package availabilitylease

import "time"

// ObserveSuspend reports that the host was suspended (or RAM-snapshotted)
// for about d while the monotonic clock stood still, for example detected as
// a wall-clock jump that BOOTTIME did not follow under kvmclock.
//
// Holder anchors and deadlines and relay gate anchors move back by d, so a
// round that straddled the freeze cannot extend the lease and a resumed
// holder fences at once when its budget is gone. Both directions only fence
// or close earlier. Acceptor holds are deliberately left alone: shortening
// them would be unsafe if d were overestimated (A2.5 residual mitigation).
func (n *Node) ObserveSuspend(d time.Duration) {
	if d <= 0 {
		return
	}
	n.run(func(now time.Duration) {
		for _, pk := range n.proposers {
			pk.anchor -= d
			pk.lastProposeAt -= d
			if pk.deadline != 0 && pk.softAt != noDeadline {
				pk.deadline -= d
				pk.softAt -= d
			}
			if pk.round != nil {
				pk.round.anchor -= d
			}
		}
		for _, ak := range n.acceptors {
			for i := range ak.echoes {
				ak.echoes[i].at -= d
			}
			for i := range ak.accepts {
				ak.accepts[i].anchor -= d
			}
		}
		n.tickProposers(now)
	})
}
