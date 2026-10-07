package relaybridge

import (
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	// A relay that failed to open a route's tunnel is tried after the others
	// of its role for penaltyInitial; each further failure once that ran out
	// doubles it, up to penaltyMax. A success forgets it.
	penaltyInitial = 10 * time.Second
	penaltyMax     = 2 * time.Minute
	// penaltyEntries bounds the remembered failures of a daemon.
	penaltyEntries = 4096
)

// RelayPenalties remembers relays that recently failed to open a source
// tunnel for a route: one whose lane is up but that refuses or never answers
// for this route (the target not registered there, a stale policy, a hung
// accept) would otherwise stay first for every new connection, each paying a
// failed attempt before the next relay. A penalized relay is only tried later,
// never left out: a lone relay is still tried. The zero value is ready to use.
type RelayPenalties struct {
	mu sync.Mutex
	// now replaces time.Now when set (tests).
	now     func() time.Time
	entries map[penaltyKey]*relayPenalty
}

type penaltyKey struct{ relay, route string }

type relayPenalty struct {
	until  time.Time
	length time.Duration
}

func (p *RelayPenalties) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// Failed records a failed open of route on relay. Failures while the relay is
// penalized already (concurrent connections) do not lengthen it.
func (p *RelayPenalties) Failed(relayID, route string) {
	if p == nil || relayID == "" || route == "" {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	key := penaltyKey{relay: relayID, route: route}
	entry := p.entries[key]
	switch {
	case entry == nil || now.Sub(entry.until) > penaltyMax:
		if p.entries == nil {
			p.entries = map[penaltyKey]*relayPenalty{}
		}
		if len(p.entries) >= penaltyEntries {
			for stale, old := range p.entries {
				if now.Sub(old.until) > 0 {
					delete(p.entries, stale)
				}
			}
			if len(p.entries) >= penaltyEntries {
				return
			}
		}
		entry = &relayPenalty{length: penaltyInitial}
		p.entries[key] = entry
	case now.Before(entry.until):
		return
	default:
		entry.length = min(entry.length*2, penaltyMax)
	}
	entry.until = now.Add(entry.length)
}

// Succeeded forgets the failures of route on relay.
func (p *RelayPenalties) Succeeded(relayID, route string) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.entries) > 0 {
		delete(p.entries, penaltyKey{relay: relayID, route: route})
	}
}

// Penalized reports a relay to try after the others for route.
func (p *RelayPenalties) Penalized(relayID, route string) bool {
	if p == nil || route == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.entries[penaltyKey{relay: relayID, route: route}]
	return entry != nil && p.clock().Before(entry.until)
}

// PenalizesRelay reports an open failure that tells about the relay's path to
// the route, unlike a capacity refusal: the route's or endpoint's session
// limit is the same on every relay.
func PenalizesRelay(err error) bool {
	return err != nil && status.Code(err) != codes.ResourceExhausted
}
