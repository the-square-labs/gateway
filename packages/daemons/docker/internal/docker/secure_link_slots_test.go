package docker

import (
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
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

// A third connector image within the hour, while both other slots hold a connector finishing its sessions: the
// replacement does not wait (the serving connector used to keep its image until a retirement ended). The connector
// whose retirement ends first goes with its sessions, the log says how many, and the new connector serves at once in
// its slot; the other retiring connector keeps its session.
func TestThirdReplacementWithinTheHourCutsTheOldestRetirement(t *testing.T) {
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
	if manager.slot != 2 {
		t.Fatalf("second replacement in slot %d, want the third", manager.slot)
	}

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply while both other slots retire: %v", err)
	}
	view := manager.currentView()
	serving := engine.byIDOrNameLocked(view.connectorID)
	if view.connectorID == third || manager.slot != 0 || serving == nil || serving.image != replaceTestNewImage || view.bindings[replaceTestLinkID].port != 20000 {
		t.Fatalf("links served by %+v (%+v) in slot %d, want the new connector in the oldest retirement's slot", view, serving, manager.slot)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != first || secondCut() || thirdCut() {
		t.Fatalf("removed %v, want only the oldest retiring connector", removed)
	}
	if logs.count("the oldest was removed for a new one") != 1 || logs.count("connector="+first+" sessions_cut=1") != 1 {
		t.Fatalf("the cut was not logged with its sessions: %s", logs.String())
	}
	for _, id := range []string{second, third} {
		if _, retiring := manager.retiring.deadline(id); !retiring {
			t.Fatalf("connector %s is not retiring", id)
		}
	}
}

// A replaced connector without sessions goes at once, not at the end of its hour.
func TestReplacedConnectorWithoutSessionsGoesAtOnce(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := manager.currentView().connectorID
	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatal(err)
	}
	waitRemovedID(t, engine, previous)
}

// The connector a replacement kept accepting until every egress listened on its successor retires by the limit from
// its replacement, not from the moment it stopped accepting: it is gone an hour after it was replaced at the latest.
func TestPendingRetirementEndsAnHourFromTheReplacement(t *testing.T) {
	manager, _ := replaceTestManager(t)
	replacedFile := filepath.Join(t.TempDir(), secureLinkReplacedFile)
	manager.replaced.file = replacedFile
	previous := manager.currentView().connectorID
	release, _ := holdSession(manager, previous)
	defer release()
	manager.mu.Lock()
	manager.setPendingRetireLocked(connectorRuntime{id: previous, slot: manager.slot, socketPath: manager.socketPath})
	since := manager.pendingRetireSince
	manager.mu.Unlock()
	// Recorded for a daemon start while it still accepts.
	if until, ok := (&retiringConnectors{file: replacedFile}).deadline(previous); !ok || !until.Equal(since.Add(time.Hour)) {
		t.Fatalf("replaced connector recorded until %v (%v), want an hour from its replacement", until, ok)
	}

	replacedAt := time.Now().Add(-40 * time.Minute)
	manager.mu.Lock()
	manager.pendingRetireSince = replacedAt
	manager.retirePendingLocked()
	manager.mu.Unlock()
	if until, ok := manager.retiring.deadline(previous); !ok || !until.Equal(replacedAt.Add(time.Hour)) {
		t.Fatalf("retirement until %v (recorded %v), want an hour from the replacement", until, ok)
	}
	if _, err := os.Stat(replacedFile); !os.IsNotExist(err) {
		t.Fatalf("the replaced record outlived the wait: %v", err)
	}
}

// A daemon restart while a replaced connector still accepted (it waits until every egress listens on its successor)
// used to give it a fresh hour from the daemon start. It retires by the deadline recorded at its replacement instead:
// the sessions still open then are cut with a log, and the record goes.
func TestDaemonStartRetiresAReplacedConnectorFromItsReplacement(t *testing.T) {
	poll := secureLinkConnectorDrainPoll
	secureLinkConnectorDrainPoll = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkConnectorDrainPoll = poll })
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	replaced := &fakeConnectorContainer{id: "replaced-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, active: 2}
	serving := &fakeConnectorContainer{id: "serving-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	for _, current := range []*fakeConnectorContainer{anchor, replaced, serving} {
		engine.containers[current.name] = current
	}
	engine.serveControl(replaced)
	engine.serveControl(serving)
	replacedFile := filepath.Join(t.TempDir(), secureLinkReplacedFile)
	// Recorded by the process that replaced it almost an hour before the restart.
	until := time.Now().Add(time.Second)
	if err := (&retiringConnectors{file: replacedFile}).record(replaced.id, until); err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	manager := &dockerSecureLinkManager{
		plugin:     &DockerPlugin{client: engine.client(), logger: slog.New(slog.NewTextHandler(logs, nil))},
		controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings:   map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.replaced.file = replacedFile
	manager.publishViewLocked()

	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if view := manager.currentView(); view.connectorID != serving.id || manager.slot != 1 {
		t.Fatalf("restored view %+v slot %d, want the connector running the image", view, manager.slot)
	}
	if retiring, ok := manager.retiring.deadline(replaced.id); !ok || !retiring.Equal(until) {
		t.Fatalf("replaced connector retires until %v (%v), want the deadline recorded at its replacement %v", retiring, ok, until)
	}
	if _, err := os.Stat(replacedFile); !os.IsNotExist(err) {
		t.Fatalf("the replaced record was kept after the start settled it: %v", err)
	}
	waitRemoved(t, engine, replaced.id)
	if logs.count("reached its retirement limit") != 1 || logs.count("connector="+replaced.id+" sessions_cut=2") != 1 {
		t.Fatalf("the cut at the recorded deadline was not logged with its sessions: %s", logs.String())
	}
}

// An egress sync that sends a connector image without the anchor (an earlier release) to a node whose serving
// connector runs in one, while both other slots hold a connector finishing its sessions: the sync would discard the
// replacement, so none starts, and no retiring connector is cut for it.
func TestDiscardedReplacementLeavesTheRetiringConnectorsAlone(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.legacyImages = map[string]bool{replaceTestOldImage: true}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if status := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))[egressTestLinkID]; status.State != egressStateReady {
		t.Fatalf("egress on the first connector %+v", status)
	}
	anchor := engine.container(secureLinkAnchorName)
	for slot, id := range map[int]string{1: "retiring-1", 2: "retiring-2"} {
		retiring := &fakeConnectorContainer{id: id, name: secureLinkConnectorSlots[slot].name, image: replaceTestNewImage,
			groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: slot, networkMode: "container:" + anchor.id, draining: true, active: 1}
		engine.mu.Lock()
		engine.containers[retiring.name] = retiring
		engine.mu.Unlock()
		engine.serveControl(retiring)
		if _, _, err := manager.retiring.start(id, filepath.Join(engine.controlDir, secureLinkConnectorSlots[slot].socket), time.Now().Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	engine.mu.Lock()
	created := engine.created
	engine.mu.Unlock()

	legacy := egressTestAssignment(egressTestLinkID, egressTestNetwork)
	legacy.SecureLinkEgress.ConnectorImage = replaceTestOldImage
	if status := manager.syncEgress(egressTestBundle(legacy))[egressTestLinkID]; status.State != egressStatePending || status.Error != connectorImageTooOld {
		t.Fatalf("egress with a connector image too old: %+v", status)
	}
	engine.mu.Lock()
	createdAfter := engine.created
	engine.mu.Unlock()
	if removed := engine.removedIDs(); len(removed) != 0 || createdAfter != created {
		t.Fatalf("removed %v and created %d connectors for a replacement the sync discards", removed, createdAfter-created)
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

// The rc.2 stand: the connector a relay update replaced still carried 4 storage link sessions when its retirement
// limit came, and it was removed with them without a log line (only busy tunnels were logged, and at Info). The
// removal now logs the sessions it cut, egress sessions included; a connector whose sessions ended goes quietly.
func TestRetirementLimitLogsTheSessionsItCuts(t *testing.T) {
	withRetireLimit(t, 300*time.Millisecond)
	poll := secureLinkConnectorDrainPoll
	secureLinkConnectorDrainPoll = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkConnectorDrainPoll = poll })
	engine := newFakeConnectorEngine(t)
	busy := &fakeConnectorContainer{id: "busy-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: "10.99.0.2", running: true, active: 4}
	idle := &fakeConnectorContainer{id: "idle-id", name: secureLinkConnectorSlots[1].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: "10.99.0.3", running: true, slot: 1}
	for _, current := range []*fakeConnectorContainer{busy, idle} {
		engine.containers[current.name] = current
		engine.serveControl(current)
	}
	logs := &lockedBuffer{}
	// The daemon's JSON log, which rendered the limit as nanoseconds on the rc.3 stand (O-d).
	manager := &dockerSecureLinkManager{
		plugin:     &DockerPlugin{client: engine.client(), logger: slog.New(slog.NewJSONHandler(logs, nil))},
		controlDir: engine.controlDir,
	}
	for _, current := range []*fakeConnectorContainer{busy, idle} {
		manager.retireConnector(connectorRuntime{id: current.id, slot: current.slot,
			socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[current.slot].socket)})
	}
	waitRemovedID(t, engine, idle.id)
	waitRemovedID(t, engine, busy.id)
	if logs.count("reached its retirement limit") != 1 || logs.count(`"connector":"`+busy.id+`","sessions_cut":4,"limit":"300ms"`) != 1 {
		t.Fatalf("the cut at the retirement limit was not logged with its sessions and a readable limit: %s", logs.String())
	}
}

func (e *fakeConnectorEngine) byIDOrNameLocked(value string) *fakeConnectorContainer {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.byIDOrName(value)
}

// A daemon restart while a replaced connector still accepted (it waits until every egress listens on its successor,
// which no record keeps) used to remove it with its sessions as a leftover. A connector found next to the one to
// serve now drains in its slot when it carries sessions and goes once they ended; one without any, or that does not
// answer, goes at once.
func TestDaemonStartRetiresALeftoverThatCarriesSessions(t *testing.T) {
	withRetireLimit(t, time.Minute)
	poll := secureLinkConnectorDrainPoll
	secureLinkConnectorDrainPoll = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkConnectorDrainPoll = poll })
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	anchor := fakeAnchor(replaceTestOldImage, "10.99.0.2")
	replaced := &fakeConnectorContainer{id: "replaced-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, networkMode: "container:" + anchor.id, active: 2}
	serving := &fakeConnectorContainer{id: "serving-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 1, networkMode: "container:" + anchor.id}
	// Running, but its control socket is gone: it does not answer.
	silent := &fakeConnectorContainer{id: "silent-id", name: secureLinkConnectorSlots[2].name, image: replaceTestOldImage,
		groups: connectorGroupAdd(), ip: anchor.ip, running: true, slot: 2, networkMode: "container:" + anchor.id}
	for _, current := range []*fakeConnectorContainer{anchor, replaced, serving, silent} {
		engine.containers[current.name] = current
	}
	engine.serveControl(replaced)
	engine.serveControl(serving)
	manager := &dockerSecureLinkManager{
		plugin: &DockerPlugin{client: engine.client()}, controlDir: engine.controlDir,
		socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings:   map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()

	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if view := manager.currentView(); view.connectorID != serving.id || manager.slot != 1 {
		t.Fatalf("restored view %+v slot %d, want the connector running the image", view, manager.slot)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != silent.id {
		t.Fatalf("removed %v, want only the connector that did not answer", removed)
	}
	if _, retiring := manager.retiring.deadline(replaced.id); !retiring || !receivedDrain(engine, replaced) {
		t.Fatal("the connector with sessions does not retire")
	}
	if requests := connectorRequests(engine, replaced); !onlyDrains(requests) {
		t.Fatalf("the retiring connector was synced: %+v", requests)
	}
	// Its sessions end: it goes.
	engine.mu.Lock()
	replaced.active = 0
	engine.mu.Unlock()
	waitRemovedID(t, engine, replaced.id)
}
