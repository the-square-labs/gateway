package docker

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

const (
	replaceTestOldImage = "ghcr.io/the-square-labs/gateway/secure-link-connector@sha256:1111111111111111111111111111111111111111111111111111111111111111"
	replaceTestNewImage = "ghcr.io/the-square-labs/gateway/secure-link-connector@sha256:2222222222222222222222222222222222222222222222222222222222222222"
	replaceTestLinkID   = "0f6c8d3e-5b1a-4c2d-9e8f-7a6b5c4d3e2f"
)

// fakeConnectorEngine is a Docker Engine API with a running connector and a
// link target "app". A started connector container serves its control socket
// like the real connector.
type fakeConnectorEngine struct {
	t          *testing.T
	controlDir string
	mu         sync.Mutex
	// containers maps a container name to its state.
	containers map[string]*fakeConnectorContainer
	created    int
	pulled     []string
	removed    []string
	// syncFails makes the control socket of a connector created from now on refuse syncs.
	syncFails bool
}

type fakeConnectorContainer struct {
	id, name, image, ip string
	groups              []string
	slot                int
	running             bool
	syncFails           bool
	listener            net.Listener
	// requests are the control requests the connector received; networks are the link networks it was attached to.
	requests []securelink.SyncRequest
	networks map[string]map[string]any
}

func newFakeConnectorEngine(t *testing.T) *fakeConnectorEngine {
	engine := &fakeConnectorEngine{t: t, controlDir: t.TempDir(), containers: map[string]*fakeConnectorContainer{}}
	t.Cleanup(func() {
		engine.mu.Lock()
		defer engine.mu.Unlock()
		for _, current := range engine.containers {
			if current.listener != nil {
				current.listener.Close()
			}
		}
	})
	return engine
}

func (e *fakeConnectorEngine) client() *Client {
	e.t.Helper()
	cli, err := client.NewClientWithOpts(client.WithHost("tcp://docker.test:2375"), client.WithAPIVersion("1.47"),
		client.WithHTTPClient(&http.Client{Transport: roundTripFunc(e.serve)}))
	if err != nil {
		e.t.Fatal(err)
	}
	return &Client{cli: cli}
}

// serveControl answers syncs like the connector: one port per binding.
func (e *fakeConnectorEngine) serveControl(current *fakeConnectorContainer) {
	path := filepath.Join(e.controlDir, secureLinkConnectorSlots[current.slot].socket)
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		e.t.Errorf("connector control socket: %v", err)
		return
	}
	current.listener = listener
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			var request securelink.SyncRequest
			if securelink.ReadJSON(connection, &request) == nil {
				e.mu.Lock()
				current.requests = append(current.requests, request)
				e.mu.Unlock()
				response := securelink.SyncResponse{Version: securelink.ProtocolVersion}
				for _, egress := range request.Egress {
					response.Egress = append(response.Egress, securelink.EgressStatus{ID: egress.ID, Generation: egress.Generation, State: securelink.EgressListening})
				}
				if current.syncFails {
					response.Error = "bind failed"
				}
				for index, binding := range request.Bindings {
					if binding.ListenHost != current.ip {
						response.Error = "listen host " + binding.ListenHost + " is not this connector"
					}
					response.Bindings = append(response.Bindings, securelink.BindingStatus{
						ID: binding.ID, Generation: binding.Generation, Port: uint16(20000 + current.slot*100 + index),
					})
				}
				_ = securelink.WriteJSON(connection, response)
			}
			connection.Close()
		}
	}()
}

func (e *fakeConnectorEngine) byIDOrName(value string) *fakeConnectorContainer {
	for _, current := range e.containers {
		if current.id == value || current.name == value {
			return current
		}
	}
	return nil
}

func (e *fakeConnectorEngine) connectorInspect(current *fakeConnectorContainer) map[string]any {
	networks := map[string]any{secureLinkManagementNetwork: map[string]any{"IPAddress": current.ip}}
	for name, endpoint := range current.networks {
		networks[name] = endpoint
	}
	return map[string]any{
		"Id": current.id, "Name": "/" + current.name,
		"Config": map[string]any{
			"Image": current.image, "User": "65532:65532", "Env": secureLinkConnectorEnv(current.slot),
			"Labels": map[string]string{"wiolett.gateway.managed": "secure-link-connector"},
		},
		"HostConfig": map[string]any{
			"Binds": []string{e.controlDir + ":/run/gateway"}, "ReadonlyRootfs": true, "CapDrop": []string{"ALL"},
			"SecurityOpt": []string{"no-new-privileges:true"}, "RestartPolicy": map[string]any{"Name": "unless-stopped"},
			"Memory": secureLinkConnectorMemory(), "NanoCpus": secureLinkConnectorNanoCPUs, "PidsLimit": secureLinkConnectorPidsLimit,
			"GroupAdd": current.groups,
		},
		"State":           map[string]any{"Running": current.running},
		"NetworkSettings": map[string]any{"Networks": networks},
	}
}

func (e *fakeConnectorEngine) serve(request *http.Request) (*http.Response, error) {
	respond := func(code int, body any) (*http.Response, error) {
		encoded, _ := json.Marshal(body)
		if text, ok := body.(string); ok {
			encoded = []byte(text)
		}
		return &http.Response{StatusCode: code, Header: http.Header{"Content-Type": []string{"application/json"}},
			Body: io.NopCloser(strings.NewReader(string(encoded))), Request: request}, nil
	}
	path, _ := url.PathUnescape(request.URL.Path)
	path = path[strings.Index(path[1:], "/")+1:]
	e.mu.Lock()
	defer e.mu.Unlock()
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case strings.HasPrefix(path, "/images/") && strings.HasSuffix(path, "/json"):
		image := strings.TrimSuffix(strings.TrimPrefix(path, "/images/"), "/json")
		e.pulled = append(e.pulled, image)
		return respond(http.StatusOK, map[string]any{"Id": "sha256:image"})
	case request.Method == http.MethodGet && path == "/networks/"+secureLinkManagementNetwork:
		return respond(http.StatusOK, map[string]any{
			"Name": secureLinkManagementNetwork, "Id": "management", "Driver": "bridge", "Internal": true,
			"Labels": map[string]string{"wiolett.gateway.managed": "secure-link"},
			"IPAM":   map[string]any{"Config": []map[string]string{{"Subnet": "10.99.0.0/24", "Gateway": "10.99.0.1"}}},
		})
	case parts[0] == "networks" && len(parts) == 3 && (parts[2] == "connect" || parts[2] == "disconnect"):
		return respond(http.StatusOK, map[string]any{})
	case request.Method == http.MethodPost && path == "/containers/create":
		name := request.URL.Query().Get("name")
		if e.containers[name] != nil {
			return respond(http.StatusConflict, `{"message":"name in use"}`)
		}
		var body struct {
			Image      string
			HostConfig struct{ GroupAdd []string }
		}
		_ = json.NewDecoder(request.Body).Decode(&body)
		e.created++
		slot := 0
		if name == secureLinkConnectorSlots[1].name {
			slot = 1
		}
		e.containers[name] = &fakeConnectorContainer{
			id: fmt.Sprintf("created-%d", e.created), name: name, image: body.Image, groups: body.HostConfig.GroupAdd, slot: slot,
			ip: fmt.Sprintf("10.99.0.%d", 10+e.created), syncFails: e.syncFails,
		}
		return respond(http.StatusCreated, map[string]any{"Id": e.containers[name].id})
	case parts[0] == "containers" && len(parts) >= 2:
		current := e.byIDOrName(parts[1])
		if current == nil {
			return respond(http.StatusNotFound, `{"message":"No such container: `+parts[1]+`"}`)
		}
		switch {
		case request.Method == http.MethodGet && len(parts) == 3 && parts[2] == "json":
			if current.name == "app" {
				return respond(http.StatusOK, map[string]any{
					"Id": current.id, "Name": "/app", "State": map[string]any{"Running": true},
					"HostConfig":      map[string]any{"NetworkMode": "app-net"},
					"NetworkSettings": map[string]any{"Networks": map[string]any{"app-net": map[string]any{"IPAddress": current.ip}}},
				})
			}
			return respond(http.StatusOK, e.connectorInspect(current))
		case request.Method == http.MethodPost && len(parts) == 3 && parts[2] == "start":
			current.running = true
			e.serveControl(current)
			return respond(http.StatusNoContent, "")
		case request.Method == http.MethodDelete && len(parts) == 2:
			if current.listener != nil {
				current.listener.Close()
			}
			delete(e.containers, current.name)
			e.removed = append(e.removed, current.id)
			return respond(http.StatusNoContent, "")
		}
	}
	e.t.Errorf("unexpected Docker API call %s %s", request.Method, path)
	return respond(http.StatusInternalServerError, `{"message":"unexpected"}`)
}

func (e *fakeConnectorEngine) removedIDs() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.removed...)
}

// replaceTestManager serves the link through a connector running the old
// image, as after an earlier Relay update.
func replaceTestManager(t *testing.T) (*dockerSecureLinkManager, *fakeConnectorEngine) {
	t.Helper()
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()
	plugin.secureLinks = manager
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	return manager, engine
}

func replaceTestCommand(image string) *pb.SyncProxySecureLinksCommand {
	return &pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{{
		LinkId: replaceTestLinkID, Role: "target", Generation: 1, TargetContainer: "app", TargetNetwork: "app-net",
		TargetPort: 8080, ConnectorImage: image,
	}}}
}

// The connector image a Relay update promoted used to replace the connector in place on every Docker node, and every
// Secure Link route failed for seconds until the new one was pulled, started and bound. The new connector
// now starts next to the serving one; dials switch once it is bound, and the previous one goes when its tunnels
// are idle.
func TestNewConnectorImageReplacesTheConnectorWithoutAGap(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := manager.currentView()
	if previous.connectorID != "created-1" || previous.bindings[replaceTestLinkID].port == 0 {
		t.Fatalf("serving view = %+v", previous)
	}
	// A request in flight through the serving connector when the update arrives.
	busyTunnel := newDrainConn(&connectorConn{Conn: nopConn{}, connectorID: previous.connectorID})
	busyTunnel.lastWrite.Store(time.Now().UnixNano())
	cancelled := make(chan struct{})
	release := manager.plugin.proxyTunnels.add(busyTunnel, func() { close(cancelled) })
	defer release()
	limit := secureLinkConnectorRetireLimit
	secureLinkConnectorRetireLimit = 5 * time.Second
	defer func() { secureLinkConnectorRetireLimit = limit }()

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err != nil {
		t.Fatalf("apply with the new image: %v", err)
	}

	current := manager.currentView()
	if current.connectorID != "created-2" || current.managementIP != "10.99.0.12" {
		t.Fatalf("dials use %+v, want the new connector", current)
	}
	if port := current.bindings[replaceTestLinkID].port; port != 20100 {
		t.Fatalf("link bound on port %d, want the new connector's port", port)
	}
	if removed := engine.removedIDs(); len(removed) != 0 {
		t.Fatalf("connectors removed before their tunnels finished: %v", removed)
	}
	// The answer went out: the tunnel is idle between requests and closes, then the previous connector goes.
	busyTunnel.lastRead.Store(time.Now().UnixNano())
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("the idle tunnel through the replaced connector was not closed")
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(engine.removedIDs()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != "created-1" {
		t.Fatalf("removed %v, want only the replaced connector", removed)
	}

	// The next image change takes the first slot again.
	if _, err := manager.apply(replaceTestCommand(replaceTestOldImage), nil, nil, false); err != nil {
		t.Fatalf("apply back to the first image: %v", err)
	}
	if view := manager.currentView(); view.connectorID != "created-3" || manager.slot != 0 {
		t.Fatalf("second replacement view %+v slot %d", view, manager.slot)
	}
}

// A replacement that cannot bind its links leaves the serving connector as it was.
func TestFailedConnectorReplacementKeepsTheServingConnector(t *testing.T) {
	manager, engine := replaceTestManager(t)
	previous := manager.currentView()
	engine.mu.Lock()
	engine.syncFails = true
	engine.mu.Unlock()

	if _, err := manager.apply(replaceTestCommand(replaceTestNewImage), nil, nil, false); err == nil {
		t.Fatal("apply succeeded although the new connector refused its links")
	}

	current := manager.currentView()
	if current.connectorID != previous.connectorID || current.bindings[replaceTestLinkID] != previous.bindings[replaceTestLinkID] {
		t.Fatalf("view after the failed replacement = %+v, want %+v", current, previous)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != "created-2" {
		t.Fatalf("removed %v, want only the failed replacement", removed)
	}
}

// After a daemon restart the connector already running the committed image is kept and a leftover of an
// interrupted replacement is removed.
func TestDaemonStartKeepsTheConnectorRunningTheImage(t *testing.T) {
	engine := newFakeConnectorEngine(t)
	engine.containers["app"] = &fakeConnectorContainer{id: "app-id", name: "app", ip: "10.50.0.5", running: true}
	// Both were created by this daemon before its restart, so they carry the groups it gives connectors.
	old := &fakeConnectorContainer{id: "old-id", name: secureLinkConnectorSlots[0].name, image: replaceTestOldImage, groups: connectorGroupAdd(), ip: "10.99.0.2", running: true}
	current := &fakeConnectorContainer{id: "next-id", name: secureLinkConnectorSlots[1].name, image: replaceTestNewImage, groups: connectorGroupAdd(), ip: "10.99.0.3", running: true, slot: 1}
	engine.containers[old.name], engine.containers[current.name] = old, current
	engine.serveControl(old)
	engine.serveControl(current)
	plugin := &DockerPlugin{client: engine.client()}
	manager := &dockerSecureLinkManager{
		plugin: plugin, socketPath: filepath.Join(engine.controlDir, secureLinkConnectorSlots[0].socket),
		bindings: map[string]dockerSecureLinkBinding{}, attached: map[string]struct{}{},
	}
	manager.publishViewLocked()

	if _, err := manager.restore(replaceTestCommand(replaceTestNewImage)); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if view := manager.currentView(); view.connectorID != "next-id" || manager.slot != 1 {
		t.Fatalf("restored view %+v slot %d, want the connector running the image", view, manager.slot)
	}
	if removed := engine.removedIDs(); len(removed) != 1 || removed[0] != "old-id" {
		t.Fatalf("removed %v, want the leftover connector", removed)
	}
}

type nopConn struct{ net.Conn }

func (nopConn) Close() error { return nil }
