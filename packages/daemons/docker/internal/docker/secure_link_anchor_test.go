package docker

import (
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func waitRemoved(t *testing.T, engine *egressFakeEngine, id string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !slices.Contains(engine.removedIDs(), id) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !slices.Contains(engine.removedIDs(), id) {
		t.Fatalf("%s was not removed: %v", id, engine.removedIDs())
	}
}

// The daemon is updated before Gateway, which still sends the connector image of its release: an image without the
// anchor label runs the connector in its own namespace as before (proxy ingress works, egress waits as pending). The
// first image with the label moves the connector into a new anchor once, next to the serving one; an image without
// it again (a Gateway rollback) moves it out, and the anchor no connector runs in goes.
func TestConnectorAnchorFollowsTheImage(t *testing.T) {
	engine := &egressFakeEngine{fakeConnectorEngine: newFakeConnectorEngine(t)}
	engine.legacyImages = map[string]bool{replaceTestOldImage: true}
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{}}
	manager.publishViewLocked()
	plugin.secureLinks = manager

	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply with an image without the anchor: %v", err)
	}
	if engine.containers[secureLinkAnchorName] != nil {
		t.Fatal("an anchor was created for an image without the pause subcommand")
	}
	view := manager.currentView()
	if view.connectorID != "created-1" || view.managementIP != "10.99.0.11" || view.bindings[replaceTestLinkID].port == 0 ||
		engine.containers[secureLinkConnectorSlots[0].name].networkMode != "" {
		t.Fatalf("proxy ingress on a connector in its own namespace: %+v", view)
	}
	statuses := manager.syncEgress(egressTestBundle(egressTestAssignment(egressTestLinkID, egressTestNetwork)))
	if status := statuses[egressTestLinkID]; status.State != egressStatePending || status.Error != connectorImageTooOld {
		t.Fatalf("egress with a connector image too old: %+v", status)
	}

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with an image with the anchor: %v", err)
	}
	anchor := engine.containers[secureLinkAnchorName]
	view = manager.currentView()
	if anchor == nil || view.connectorID != "created-3" || view.managementIP != anchor.ip ||
		engine.containers[secureLinkConnectorSlots[1].name].networkMode != "container:"+anchor.id {
		t.Fatalf("the connector did not move into the anchor: %+v (anchor %+v)", view, anchor)
	}
	if status := manager.egress.currentStatuses()[egressTestLinkID]; status.State != egressStateReady || status.Address != "10.213.0.2" {
		t.Fatalf("egress after the move into the anchor: %+v", status)
	}
	waitRemoved(t, engine, "created-1")

	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the earlier image again: %v", err)
	}
	if view = manager.currentView(); view.connectorID != "created-4" || view.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("proxy ingress after the move out of the anchor: %+v", view)
	}
	waitRemoved(t, engine, "created-3")
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply after the previous connector was retired: %v", err)
	}
	if !slices.Contains(engine.removedIDs(), anchor.id) {
		t.Fatalf("the anchor no connector runs in stayed: %v", engine.removedIDs())
	}
}
