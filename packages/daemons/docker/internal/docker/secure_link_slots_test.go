package docker

import (
	"log/slog"
	"slices"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

// holdSession keeps a container link session open through a connector until the returned release.
func holdSession(manager *dockerSecureLinkManager, connectorID string) (release func(), cut func() bool) {
	cancelled := make(chan struct{})
	session := newDrainConn(&connectorConn{Conn: nopConn{}, connectorID: connectorID})
	untrack := manager.plugin.proxyTunnels.addHeld(session, func() { close(cancelled) })
	return untrack, func() bool {
		select {
		case <-cancelled:
			return true
		default:
			return false
		}
	}
}

func withRetireLimit(t *testing.T, limit time.Duration) {
	previous := secureLinkConnectorRetireLimit
	secureLinkConnectorRetireLimit = limit
	t.Cleanup(func() { secureLinkConnectorRetireLimit = previous })
}

func setDraining(engine *fakeConnectorEngine, slot int) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.containers[secureLinkConnectorSlots[slot].name].draining = true
}

func waitRemovedID(t *testing.T, engine *fakeConnectorEngine, id string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !slices.Contains(engine.removedIDs(), id) {
		if time.Now().After(deadline) {
			t.Fatalf("connector %s was not removed (removed %v)", id, engine.removedIDs())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The rc.1 stand: a relay update replaced the connector, and while the replaced one still retired with 4 container
// link sessions, the new one was told to drain and replaced in turn. Its replacement took the retiring connector's
// slot and cut the 4 sessions without a word. The replacement now starts in a free slot, and both replaced
// connectors finish their sessions.
func TestReplacementInTheRetireWindowKeepsTheRetiringConnector(t *testing.T) {
	withRetireLimit(t, time.Minute)
	manager, engine := replaceTestManager(t)
	first := manager.currentView().connectorID
	releaseFirst, firstCut := holdSession(manager, first)
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}
	second := manager.currentView().connectorID
	if second == first || manager.slot != 1 {
		t.Fatalf("replacement %s in slot %d", second, manager.slot)
	}
	releaseSecond, secondCut := holdSession(manager, second)
	defer releaseSecond()

	// The serving connector is told to drain (SIGUSR1); the next sync replaces it.
	setDraining(engine, 1)
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply on the draining connector: %v", err)
	}
	view := manager.currentView()
	if view.connectorID == first || view.connectorID == second || manager.slot != 2 || view.bindings[replaceTestLinkID].port != 20200 {
		t.Fatalf("links served by %+v in slot %d, want a new connector in the third slot", view, manager.slot)
	}
	if removed := engine.removedIDs(); len(removed) != 0 || firstCut() || secondCut() {
		t.Fatalf("removed %v (sessions cut %v %v), want both replaced connectors finishing their sessions", removed, firstCut(), secondCut())
	}
	for _, id := range []string{first, second} {
		if _, retiring := manager.retiring.deadline(id); !retiring {
			t.Fatalf("connector %s is not retiring", id)
		}
	}
	// Its session ended: the first replaced connector goes, the second keeps its own.
	releaseFirst()
	waitRemovedID(t, engine, first)
	if slices.Contains(engine.removedIDs(), second) {
		t.Fatal("the connector still carrying a session was removed")
	}
}

// A further connector image while every other slot holds a connector finishing its sessions: the serving connector
// keeps its image and its links, nothing is cut, and the replacement starts once a retirement ended.
func TestConnectorImageChangeWaitsForAFreeSlot(t *testing.T) {
	withRetireLimit(t, time.Minute)
	manager, engine := replaceTestManager(t)
	logs := &lockedBuffer{}
	manager.plugin.logger = slog.New(slog.NewTextHandler(logs, nil))
	store, err := securelink.NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager.plugin.secureLinkState = store
	sync := func(image string) error {
		_, err := manager.syncWithPersistence(replaceTestCommand(image), store.Stage, store.Commit)
		return err
	}
	first := manager.currentView().connectorID
	releaseFirst, _ := holdSession(manager, first)
	if err := sync(replaceTestNewImage); err != nil {
		t.Fatal(err)
	}
	second := manager.currentView().connectorID
	releaseSecond, _ := holdSession(manager, second)
	defer releaseSecond()
	if err := sync(replaceTestOldImage); err != nil {
		t.Fatal(err)
	}
	third := manager.currentView().connectorID
	if manager.slot != 2 {
		t.Fatalf("second replacement in slot %d, want the third", manager.slot)
	}

	if err := sync(replaceTestNewImage); err != nil {
		t.Fatalf("sync while every other slot retires: %v", err)
	}
	if view := manager.currentView(); view.connectorID != third || view.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("links served by %+v, want the serving connector until a slot is free", view)
	}
	if removed := engine.removedIDs(); len(removed) != 0 {
		t.Fatalf("removed %v while their sessions went on", removed)
	}
	if logs.count("is replaced once a replaced connector finished its sessions") != 1 {
		t.Fatalf("the waiting replacement was not logged: %s", logs.String())
	}

	// The first replaced connector's session ends: its slot takes the replacement.
	releaseFirst()
	waitRemovedID(t, engine, first)
	deadline := time.Now().Add(5 * time.Second)
	for manager.currentView().connectorID == third {
		if time.Now().After(deadline) {
			t.Fatal("the waiting replacement did not start once a slot was free")
		}
		time.Sleep(10 * time.Millisecond)
	}
	manager.mu.Lock()
	slot := manager.slot
	manager.mu.Unlock()
	view := manager.currentView()
	if serving := engine.byIDOrNameLocked(view.connectorID); slot != 0 || serving == nil || serving.image != replaceTestNewImage {
		t.Fatalf("replacement %+v in slot %d", serving, slot)
	}
	if slices.Contains(engine.removedIDs(), second) {
		t.Fatal("the connector still carrying a session was removed")
	}
}

// The hard bound: a serving connector told to drain while both other slots retire leaves no slot. The connector whose
// retirement ends first goes, and the log says how many sessions it cut.
func TestFullConnectorSlotsCutTheOldestRetirementWithALog(t *testing.T) {
	withRetireLimit(t, time.Minute)
	manager, engine := replaceTestManager(t)
	logs := &lockedBuffer{}
	manager.plugin.logger = slog.New(slog.NewTextHandler(logs, nil))
	first := manager.currentView().connectorID
	releaseFirst, _ := holdSession(manager, first)
	defer releaseFirst()
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	second := manager.currentView().connectorID
	releaseSecond, secondCut := holdSession(manager, second)
	defer releaseSecond()
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	third := manager.currentView().connectorID
	releaseThird, thirdCut := holdSession(manager, third)
	defer releaseThird()

	setDraining(engine, 2)
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply on the draining connector: %v", err)
	}
	view := manager.currentView()
	if view.connectorID == first || view.connectorID == second || view.connectorID == third || manager.slot != 0 {
		t.Fatalf("links served by %+v in slot %d, want a new connector in the oldest retirement's slot", view, manager.slot)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != first || secondCut() || thirdCut() {
		t.Fatalf("removed %v, want only the oldest retiring connector", removed)
	}
	if logs.count("the oldest was removed for a new one") != 1 || logs.count("connector="+first+" sessions_cut=1") != 1 {
		t.Fatalf("the cut was not logged with its sessions: %s", logs.String())
	}
}

func (e *fakeConnectorEngine) byIDOrNameLocked(value string) *fakeConnectorContainer {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.byIDOrName(value)
}
