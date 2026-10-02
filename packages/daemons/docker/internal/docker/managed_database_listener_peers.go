package docker

import (
	"context"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/events"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// A database binding's host listener authorises each connection by the container behind its source address. Asking
// dockerd for every connection made the link depend on dockerd: with dockerd frozen (stand run X1, SIGSTOP 90 s) the
// workload and its held connections were fine, and every new connection waited out the inspect budget and was refused.
// listenerPeers keeps what dockerd said about each address of a binding network, so a known workload's new connection
// costs no dockerd call. dockerd is asked only for an address it has not named yet (a miss).
//
// An address can only pass to another container through dockerd, and dockerd reports every such change on its event
// stream before the new container runs: the stream's disconnect, connect, die, destroy and rename events drop the
// entries they may concern (a connect on a network drops that network's other containers, which also covers a
// release whose event comes after the new container's connect). An entry is therefore trusted only while the event
// stream is open: when it ends (dockerd restarts) every entry goes, and a miss stores an answer only if no event came
// in while dockerd was asked. A frozen dockerd keeps the stream open and hands no address to anybody, so its known
// workloads keep connecting.

const (
	// listenerPeerEventsRetry is how soon a lost Docker event stream is opened again.
	listenerPeerEventsRetry = time.Second
)

type listenerPeerKey struct {
	networkID string
	address   netip.Addr
}

// listenerPeer is what a source selector reads of a container: its name and labels.
type listenerPeer struct {
	containerID string
	name        string
	labels      map[string]string
}

// listenerPeerLabels are the labels the source selectors read (managedDatabaseListenerSourceAllowed).
var listenerPeerLabels = []string{deploymentManagedLabel, deploymentIDLabel, "com.docker.compose.project", "com.docker.compose.service"}

func listenerPeerFromInspect(containerID string, inspected mobyclient.ContainerInspectResult) listenerPeer {
	peer := listenerPeer{containerID: containerID, name: strings.TrimPrefix(inspected.Container.Name, "/"), labels: map[string]string{}}
	if inspected.Container.Config != nil {
		for _, label := range listenerPeerLabels {
			if value, present := inspected.Container.Config.Labels[label]; present {
				peer.labels[label] = value
			}
		}
	}
	return peer
}

// listenerPeers is the address book of the binding networks. The zero value trusts nothing until the event stream
// opens (streamOpened).
type listenerPeers struct {
	mu   sync.Mutex
	live bool
	// generation changes with every event that may concern an entry and with every opening or loss of the stream:
	// an answer dockerd gave while it changed is not stored.
	generation uint64
	entries    map[listenerPeerKey]listenerPeer
}

// lookup returns the container dockerd named for address on the network, while the event stream vouches for it.
func (c *listenerPeers) lookup(networkID string, address netip.Addr) (listenerPeer, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.live || networkID == "" {
		return listenerPeer{}, false
	}
	peer, ok := c.entries[listenerPeerKey{networkID: networkID, address: address}]
	return peer, ok
}

// begin returns the generation to hand store once dockerd answered.
func (c *listenerPeers) begin() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation
}

// store remembers dockerd's answer for address, unless the stream is closed or an event came in since begin.
func (c *listenerPeers) store(networkID string, address netip.Addr, peer listenerPeer, generation uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.live || networkID == "" || generation != c.generation {
		return false
	}
	if c.entries == nil {
		c.entries = map[listenerPeerKey]listenerPeer{}
	}
	c.entries[listenerPeerKey{networkID: networkID, address: address}] = peer
	return true
}

func (c *listenerPeers) streamOpened() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.live = true
	c.generation++
}

// streamClosed forgets every entry: events may be missed until the stream is open again.
func (c *listenerPeers) streamClosed() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.live = false
	c.generation++
	c.entries = nil
}

// apply drops the entries an event may concern.
func (c *listenerPeers) apply(message events.Message) {
	matches := listenerPeerEventMatch(message)
	if matches == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation++
	for key, peer := range c.entries {
		if matches(key, peer) {
			delete(c.entries, key)
		}
	}
}

// listenerPeerEventMatch returns which entries an event concerns, nil for an event that concerns none.
func listenerPeerEventMatch(message events.Message) func(listenerPeerKey, listenerPeer) bool {
	id := message.Actor.ID
	switch message.Type {
	case events.ContainerEventType:
		switch message.Action {
		case events.ActionDie, events.ActionDestroy, events.ActionRename:
			return func(_ listenerPeerKey, peer listenerPeer) bool { return peer.containerID == id }
		}
	case events.NetworkEventType:
		container := message.Actor.Attributes["container"]
		switch message.Action {
		case events.ActionDisconnect:
			return func(key listenerPeerKey, peer listenerPeer) bool {
				return key.networkID == id && peer.containerID == container
			}
		case events.ActionConnect:
			// The connecting container may have an address another container held a moment ago.
			return func(key listenerPeerKey, peer listenerPeer) bool {
				return key.networkID == id && peer.containerID != container
			}
		case events.ActionDestroy:
			return func(key listenerPeerKey, _ listenerPeer) bool { return key.networkID == id }
		}
	}
	return nil
}

// retain drops the entries of a network that an inspect of it contradicts.
func (c *listenerPeers) retain(networkID string, inspected network.Inspect) {
	endpoints := listenerNetworkEndpoints(inspected)
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, peer := range c.entries {
		if key.networkID == networkID && endpoints[key.address] != peer.containerID {
			delete(c.entries, key)
		}
	}
}

// missing lists the endpoints of an inspected network the book has no entry for.
func (c *listenerPeers) missing(networkID string, inspected network.Inspect) map[netip.Addr]string {
	endpoints := listenerNetworkEndpoints(inspected)
	c.mu.Lock()
	defer c.mu.Unlock()
	for address, containerID := range endpoints {
		if peer, ok := c.entries[listenerPeerKey{networkID: networkID, address: address}]; ok && peer.containerID == containerID {
			delete(endpoints, address)
		}
	}
	return endpoints
}

func listenerNetworkEndpoints(inspected network.Inspect) map[netip.Addr]string {
	endpoints := make(map[netip.Addr]string, len(inspected.Containers))
	for containerID, endpoint := range inspected.Containers {
		if endpoint.IPv4Address.IsValid() {
			endpoints[endpoint.IPv4Address.Addr().Unmap()] = containerID
		}
	}
	return endpoints
}

// watchPeers follows Docker's events for the life of the process (see listenerPeers).
func (m *managedDatabaseHostListenerManager) watchPeers(ctx context.Context) {
	for {
		m.followPeerEvents(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(listenerPeerEventsRetry):
		}
	}
}

func (m *managedDatabaseHostListenerManager) followPeerEvents(ctx context.Context) {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Events returns once dockerd answered the request: the stream is open from here on.
	stream := m.events(streamCtx, mobyclient.EventsListOptions{
		Filters: mobyclient.Filters{}.
			Add("type", string(events.ContainerEventType), string(events.NetworkEventType)).
			Add("event", string(events.ActionDie), string(events.ActionDestroy), string(events.ActionRename),
				string(events.ActionConnect), string(events.ActionDisconnect)),
	})
	select {
	case err := <-stream.Err:
		m.logger.Debug("managed database listeners could not open the Docker event stream", "error", err)
		return
	default:
	}
	m.peers.streamOpened()
	defer m.peers.streamClosed()
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-stream.Err:
			if err != nil && ctx.Err() == nil {
				m.logger.Info("managed database listeners lost the Docker event stream; new link connections are checked with dockerd until it is open again",
					"error", err)
			}
			return
		case message := <-stream.Messages:
			m.peers.apply(message)
		}
	}
}

// peerSnapshot is an inspect of a listener network and the address book's generation from before it was taken.
type peerSnapshot struct {
	networks   map[string]network.Inspect
	generation uint64
}

// refreshPeers brings the address book of the listeners' networks in line with an inspect of them: entries the
// inspect contradicts go, and the containers it lists that the book does not know yet are asked for, so a workload
// that has not connected since this process started is known before dockerd may stop answering. Nothing is stored
// when an event came in since the inspect (snapshot.generation).
func (m *managedDatabaseHostListenerManager) refreshPeers(snapshot peerSnapshot) {
	if len(snapshot.networks) == 0 {
		return
	}
	for networkID, inspected := range snapshot.networks {
		m.peers.retain(networkID, inspected)
	}
	m.peerRefreshMu.Lock()
	if m.peerRefreshRunning {
		m.peerRefreshPending = &snapshot
		m.peerRefreshMu.Unlock()
		return
	}
	m.peerRefreshRunning = true
	m.peerRefreshMu.Unlock()
	go func() {
		for next := &snapshot; next != nil; {
			m.learnPeers(*next)
			m.peerRefreshMu.Lock()
			next, m.peerRefreshPending = m.peerRefreshPending, nil
			if next == nil {
				m.peerRefreshRunning = false
			}
			m.peerRefreshMu.Unlock()
		}
	}()
}

func (m *managedDatabaseHostListenerManager) learnPeers(snapshot peerSnapshot) {
	for networkID, inspected := range snapshot.networks {
		for address, containerID := range m.peers.missing(networkID, inspected) {
			if m.peers.begin() != snapshot.generation {
				return
			}
			inspectCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseHostListenerInspectTimeout)
			containerInspect, err := m.inspectContainer(inspectCtx, containerID)
			cancel()
			if err != nil {
				continue
			}
			m.peers.store(networkID, address, listenerPeerFromInspect(containerID, containerInspect), snapshot.generation)
		}
	}
}
