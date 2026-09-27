package availabilitylease

import "time"

func (n *simNode) startContainer(key Key, c *simContainer) {
	c.starting = true
	n.armWatchdog(false)
	delay := n.w.randDuration(100*time.Millisecond, 1500*time.Millisecond)
	if n.hung() {
		delay += n.hangUntil - n.w.now
	}
	n.w.after(delay, func() {
		if n.containers[key] != c || !c.starting {
			return
		}
		if n.frozen {
			n.frozenInbox = append(n.frozenInbox, func() { n.finishStart(key, c) })
			return
		}
		n.finishStart(key, c)
	})
}

func (n *simNode) finishStart(key Key, c *simContainer) {
	if n.containers[key] != c || !c.starting {
		return
	}
	c.starting = false
	deadline, ok := n.watchdog[key]
	if !ok || n.local() >= deadline {
		n.w.tracef("%s start of %s refused by watchdog", n.id, key)
	} else {
		c.live = true
		// Started on a lease established before a freeze: A2.5 residual.
		if n.resumedLocal != 0 && deadline <= n.resumedLocal+FenceCompleteAfter {
			c.residual = true
		}
		n.w.tracef("%s container %s started", n.id, key)
	}
	if n.processUp() && n.node != nil && !n.frozen {
		n.after()
	}
}

func (n *simNode) stopContainer(key Key, c *simContainer) {
	c.stopping = true
	delay := n.w.randDuration(200*time.Millisecond, 10*time.Second)
	if n.stopDelay > 0 {
		delay = n.stopDelay
	}
	if n.hung() {
		delay += n.hangUntil - n.w.now
	}
	n.w.tracef("%s stopping %s", n.id, key)
	n.w.after(delay, func() {
		if n.containers[key] != c || !c.stopping {
			return
		}
		finish := func() {
			if n.containers[key] != c || !c.stopping {
				return
			}
			c.live, c.stopping = false, false
			n.w.tracef("%s container %s stopped", n.id, key)
			if n.processUp() && n.node != nil {
				n.after()
			}
		}
		if n.frozen {
			n.frozenInbox = append(n.frozenInbox, finish)
			return
		}
		finish()
	})
}

// beginDrain models a planned handoff or a health release: stop, then
// release; if the stop does not finish in 10 s, abandon instead (A6).
func (n *simNode) beginDrain(key Key, successor string) bool {
	c := n.containers[key]
	if c == nil || !c.live || c.stopping || c.draining || c.legacy || n.node == nil || !n.node.HolderStatus(key).Holding {
		return false
	}
	c.draining, c.successor, c.drainStarted = true, successor, true
	n.stopContainer(key, c)
	gen := n.gen
	n.w.after(10*time.Second, func() {
		if n.gen != gen || n.containers[key] != c || !c.draining || !c.live {
			return
		}
		c.draining, c.successor, c.drainStarted = false, "", false
		n.w.tracef("%s stop hung, abandoning %s", n.id, key)
		n.node.Abandon(key)
		n.after()
	})
	return true
}
