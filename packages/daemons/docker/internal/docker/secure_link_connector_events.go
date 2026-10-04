package docker

import (
	"context"
	"time"

	"github.com/moby/moby/api/types/events"
	mobyclient "github.com/moby/moby/client"
)

const (
	// connectorEventSettle gathers the events of one connector start (and dockerd's restart of every container).
	connectorEventSettle = time.Second
	// connectorEventsRetry spaces the subscriptions while dockerd does not answer.
	connectorEventsRetry = 2 * time.Second
	// connectorResyncSpacing is the least time between two resyncs started by connector events.
	connectorResyncSpacing = 5 * time.Second
)

// followConnectorStarts resyncs the connector as soon as its container starts again (D5): a connector that crashed
// and was restarted by its restart policy, or that dockerd started after its own restart, holds no listener, and
// workloads reach the egress listeners directly, without a dial through the daemon that would restore them. After
// the event stream broke (dockerd restarted) it resyncs as well: a start may have been missed.
func (m *dockerSecureLinkManager) followConnectorStarts(ctx context.Context) {
	if m.plugin == nil || m.plugin.client == nil {
		return
	}
	for {
		missed := m.watchConnectorStarts(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(connectorEventsRetry):
		}
		if missed {
			m.resyncAfterConnectorStart()
		}
	}
}

// watchConnectorStarts follows the connector's start events until the stream ends, and reports whether it ended
// with an error (events may have been missed).
func (m *dockerSecureLinkManager) watchConnectorStarts(ctx context.Context) bool {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	filters := mobyclient.Filters{}.
		Add("type", string(events.ContainerEventType)).
		Add("label", "wiolett.gateway.managed=secure-link-connector").
		Add("event", string(events.ActionStart)).
		Add("event", string(events.ActionRestart))
	stream := m.plugin.client.cli.Events(streamCtx, mobyclient.EventsListOptions{Filters: filters})
	var settle <-chan time.Time
	var resynced time.Time
	for {
		select {
		case <-ctx.Done():
			return false
		case err := <-stream.Err:
			return err != nil && ctx.Err() == nil
		case message := <-stream.Messages:
			if !isSecureLinkConnectorName(message.Actor.Attributes["name"]) {
				continue
			}
			if settle == nil {
				// A resync starts the connector itself when it had to replace it: that start is not resynced again
				// before connectorResyncSpacing.
				settle = time.After(max(connectorEventSettle, time.Until(resynced.Add(connectorResyncSpacing))))
			}
		case <-settle:
			settle = nil
			m.resyncAfterConnectorStart()
			resynced = time.Now()
		}
	}
}

// resyncAfterConnectorStart binds the committed ingress bindings and the egress listeners again.
func (m *dockerSecureLinkManager) resyncAfterConnectorStart() {
	ingress := m.plugin.secureLinkState != nil && len(m.plugin.secureLinkState.Get().Bindings) > 0
	if ingress {
		// The restore applies the egress listeners too.
		if err := m.restoreBindingsCoalesced(true); err == nil {
			return
		} else if m.plugin.logger != nil {
			m.plugin.logger.Warn("secure-link connector started again; its links could not all be bound yet", "error", err)
		}
	}
	m.resyncEgress()
}
