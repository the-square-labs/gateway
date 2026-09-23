package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// fakeDockerEngine is an in-memory Docker Engine API served over net.Pipe, so
// deployment code can be exercised end to end (hijacked exec streams included)
// without listening on a socket.
type fakeDockerEngine struct {
	t  *testing.T
	mu sync.Mutex

	seq        int
	containers map[string]*fakeContainer // by ID
	execs      map[string]*fakeExec
	calls      []string

	// onStart runs when a container is started; returning false leaves it
	// stopped, the way a container whose process exits at once ends up.
	onStart func(*fakeContainer) bool
	// onStop runs, without the engine lock held, before a container stops.
	onStop func(*fakeContainer)
	// onExec returns the raw attach stream and exit code of an exec.
	onExec func(ctr *fakeContainer, cmd []string) ([]byte, int)
}

type fakeContainer struct {
	ID            string
	Name          string
	Image         string
	Cmd           []string
	Labels        map[string]string
	Running       bool
	RestartPolicy container.RestartPolicyMode
	PortBindings  network.PortMap
	// Files holds file contents by absolute path, served by the archive API.
	Files map[string]string
}

type fakeExec struct {
	container *fakeContainer
	cmd       []string
	output    []byte
	exitCode  int
}

type pipeListener struct {
	conns  chan net.Conn
	closed chan struct{}
	once   sync.Once
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "docker.test" }

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.conns:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }

func (l *pipeListener) dial(ctx context.Context, _, _ string) (net.Conn, error) {
	server, client := net.Pipe()
	select {
	case l.conns <- server:
		return client, nil
	case <-l.closed:
		return nil, net.ErrClosed
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func newFakeDockerEngine(t *testing.T) (*fakeDockerEngine, *Client) {
	t.Helper()
	engine := &fakeDockerEngine{
		t:          t,
		containers: map[string]*fakeContainer{},
		execs:      map[string]*fakeExec{},
	}
	listener := &pipeListener{conns: make(chan net.Conn), closed: make(chan struct{})}
	server := &http.Server{Handler: http.HandlerFunc(engine.serve)}
	go func() { _ = server.Serve(listener) }()
	cli, err := mobyclient.New(
		mobyclient.WithHost("tcp://docker.test:2375"),
		mobyclient.WithDialContext(listener.dial),
		mobyclient.WithAPIVersion("1.43"),
	)
	if err != nil {
		t.Fatalf("create Docker client: %v", err)
	}
	t.Cleanup(func() {
		_ = cli.Close()
		_ = server.Close()
		_ = listener.Close()
	})
	return engine, &Client{cli: cli, logger: slog.Default()}
}

func (e *fakeDockerEngine) addContainer(ctr *fakeContainer) *fakeContainer {
	e.mu.Lock()
	defer e.mu.Unlock()
	if ctr.ID == "" {
		e.seq++
		ctr.ID = fmt.Sprintf("ctr-%d", e.seq)
	}
	e.containers[ctr.ID] = ctr
	return ctr
}

func (e *fakeDockerEngine) byName(name string) *fakeContainer {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lookupLocked(name)
}

func (e *fakeDockerEngine) lookupLocked(ref string) *fakeContainer {
	if ctr, ok := e.containers[ref]; ok {
		return ctr
	}
	for _, ctr := range e.containers {
		if ctr.Name == strings.TrimPrefix(ref, "/") {
			return ctr
		}
	}
	return nil
}

func (e *fakeDockerEngine) callLog() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.calls...)
}

func (e *fakeDockerEngine) countCalls(prefix string) int {
	count := 0
	for _, call := range e.callLog() {
		if strings.HasPrefix(call, prefix) {
			count++
		}
	}
	return count
}

var fakeDockerVersionPrefix = regexp.MustCompile(`^/v[0-9.]+`)

func (e *fakeDockerEngine) serve(w http.ResponseWriter, r *http.Request) {
	path := fakeDockerVersionPrefix.ReplaceAllString(r.URL.Path, "")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	e.mu.Lock()
	e.calls = append(e.calls, r.Method+" "+path)
	e.mu.Unlock()

	switch {
	case r.Method == http.MethodGet && path == "/containers/json":
		e.listContainers(w)
	case r.Method == http.MethodPost && path == "/containers/create":
		e.createContainer(w, r)
	case r.Method == http.MethodGet && len(parts) == 3 && parts[0] == "containers" && parts[2] == "json":
		e.inspectContainer(w, parts[1])
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "containers" && parts[2] == "start":
		e.startContainer(w, parts[1])
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "containers" && parts[2] == "stop":
		e.stopContainer(w, parts[1])
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "containers" && parts[2] == "kill":
		e.stopContainer(w, parts[1])
	case r.Method == http.MethodDelete && len(parts) == 2 && parts[0] == "containers":
		e.removeContainer(w, parts[1])
	case r.Method == http.MethodGet && len(parts) == 3 && parts[0] == "containers" && parts[2] == "archive":
		e.archiveFile(w, parts[1], r.URL.Query().Get("path"))
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "containers" && parts[2] == "exec":
		e.createExec(w, r, parts[1])
	case r.Method == http.MethodPost && len(parts) == 3 && parts[0] == "exec" && parts[2] == "start":
		e.startExec(w, r, parts[1])
	case r.Method == http.MethodGet && len(parts) == 3 && parts[0] == "exec" && parts[2] == "json":
		e.inspectExec(w, parts[1])
	case r.Method == http.MethodGet && len(parts) >= 3 && parts[0] == "images" && parts[len(parts)-1] == "json":
		writeFakeJSON(w, http.StatusOK, map[string]any{"Id": "sha256:image", "Os": "linux", "Architecture": "amd64"})
	case r.Method == http.MethodPost && path == "/networks/create":
		writeFakeJSON(w, http.StatusCreated, map[string]any{"Id": "network-1"})
	case r.Method == http.MethodDelete && len(parts) == 2 && parts[0] == "networks":
		w.WriteHeader(http.StatusNoContent)
	default:
		e.t.Errorf("fake Docker engine: unexpected request %s %s", r.Method, path)
		writeFakeJSON(w, http.StatusNotImplemented, map[string]string{"message": "not implemented"})
	}
}

func writeFakeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeNoSuchContainer(w http.ResponseWriter, ref string) {
	writeFakeJSON(w, http.StatusNotFound, map[string]string{"message": "No such container: " + ref})
}

func (e *fakeDockerEngine) listContainers(w http.ResponseWriter) {
	e.mu.Lock()
	items := make([]container.Summary, 0, len(e.containers))
	for _, ctr := range e.containers {
		state := container.StateExited
		if ctr.Running {
			state = container.StateRunning
		}
		items = append(items, container.Summary{ID: ctr.ID, Names: []string{"/" + ctr.Name}, Image: ctr.Image, Labels: ctr.Labels, State: state})
	}
	e.mu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	writeFakeJSON(w, http.StatusOK, items)
}

func (e *fakeDockerEngine) createContainer(w http.ResponseWriter, r *http.Request) {
	var request container.CreateRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeFakeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}
	name := r.URL.Query().Get("name")
	e.mu.Lock()
	if existing := e.lookupLocked(name); existing != nil {
		e.mu.Unlock()
		writeFakeJSON(w, http.StatusConflict, map[string]string{"message": fmt.Sprintf("Conflict. The container name %q is already in use by container %q.", "/"+name, existing.ID)})
		return
	}
	e.mu.Unlock()
	ctr := &fakeContainer{Name: name}
	if request.Config != nil {
		ctr.Image = request.Config.Image
		ctr.Cmd = request.Config.Cmd
		ctr.Labels = request.Config.Labels
	}
	if request.HostConfig != nil {
		ctr.RestartPolicy = request.HostConfig.RestartPolicy.Name
		ctr.PortBindings = request.HostConfig.PortBindings
	}
	e.addContainer(ctr)
	writeFakeJSON(w, http.StatusCreated, map[string]any{"Id": ctr.ID, "Warnings": []string{}})
}

func (e *fakeDockerEngine) inspectContainer(w http.ResponseWriter, ref string) {
	e.mu.Lock()
	ctr := e.lookupLocked(ref)
	if ctr == nil {
		e.mu.Unlock()
		writeNoSuchContainer(w, ref)
		return
	}
	response := container.InspectResponse{
		ID:    ctr.ID,
		Name:  "/" + ctr.Name,
		Image: ctr.Image,
		State: &container.State{Running: ctr.Running},
		Config: &container.Config{
			Image:  ctr.Image,
			Cmd:    ctr.Cmd,
			Labels: ctr.Labels,
		},
		HostConfig: &container.HostConfig{
			RestartPolicy: container.RestartPolicy{Name: ctr.RestartPolicy},
			PortBindings:  ctr.PortBindings,
		},
		NetworkSettings: &container.NetworkSettings{Networks: map[string]*network.EndpointSettings{}},
	}
	e.mu.Unlock()
	writeFakeJSON(w, http.StatusOK, response)
}

func (e *fakeDockerEngine) startContainer(w http.ResponseWriter, ref string) {
	e.mu.Lock()
	ctr := e.lookupLocked(ref)
	e.mu.Unlock()
	if ctr == nil {
		writeNoSuchContainer(w, ref)
		return
	}
	running := true
	if e.onStart != nil {
		running = e.onStart(ctr)
	}
	e.mu.Lock()
	ctr.Running = running
	e.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (e *fakeDockerEngine) stopContainer(w http.ResponseWriter, ref string) {
	e.mu.Lock()
	ctr := e.lookupLocked(ref)
	e.mu.Unlock()
	if ctr == nil {
		writeNoSuchContainer(w, ref)
		return
	}
	if e.onStop != nil {
		e.onStop(ctr)
	}
	e.mu.Lock()
	ctr.Running = false
	e.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (e *fakeDockerEngine) removeContainer(w http.ResponseWriter, ref string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	ctr := e.lookupLocked(ref)
	if ctr == nil {
		writeNoSuchContainer(w, ref)
		return
	}
	delete(e.containers, ctr.ID)
	w.WriteHeader(http.StatusNoContent)
}

// archiveFile serves one file of a running or stopped container as a tar
// archive, the way the Engine's archive endpoint does.
func (e *fakeDockerEngine) archiveFile(w http.ResponseWriter, ref, path string) {
	e.mu.Lock()
	ctr := e.lookupLocked(ref)
	var content string
	var exists bool
	if ctr != nil {
		content, exists = ctr.Files[path]
	}
	e.mu.Unlock()
	if ctr == nil {
		writeNoSuchContainer(w, ref)
		return
	}
	if !exists {
		writeFakeJSON(w, http.StatusNotFound, map[string]string{"message": "Could not find the file " + path + " in container " + ctr.ID})
		return
	}
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	name := path[strings.LastIndex(path, "/")+1:]
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		e.t.Errorf("write archive header: %v", err)
	}
	_, _ = tw.Write([]byte(content))
	_ = tw.Close()
	stat, _ := json.Marshal(container.PathStat{Name: name, Size: int64(len(content)), Mode: 0o644})
	w.Header().Set("X-Docker-Container-Path-Stat", base64.StdEncoding.EncodeToString(stat))
	w.Header().Set("Content-Type", "application/x-tar")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(archive.Bytes())
}

func (e *fakeDockerEngine) createExec(w http.ResponseWriter, r *http.Request, ref string) {
	var request container.ExecCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeFakeJSON(w, http.StatusBadRequest, map[string]string{"message": err.Error()})
		return
	}
	e.mu.Lock()
	ctr := e.lookupLocked(ref)
	if ctr == nil {
		e.mu.Unlock()
		writeNoSuchContainer(w, ref)
		return
	}
	if !ctr.Running {
		e.mu.Unlock()
		writeFakeJSON(w, http.StatusConflict, map[string]string{"message": fmt.Sprintf("container %s is not running", ctr.ID)})
		return
	}
	e.seq++
	id := fmt.Sprintf("exec-%d", e.seq)
	e.execs[id] = &fakeExec{container: ctr, cmd: request.Cmd}
	e.mu.Unlock()
	writeFakeJSON(w, http.StatusCreated, map[string]string{"Id": id})
}

func (e *fakeDockerEngine) startExec(w http.ResponseWriter, r *http.Request, id string) {
	// net.Pipe is unbuffered: the client finishes writing the request before
	// it reads the upgraded response, so the body must be consumed first.
	_, _ = io.Copy(io.Discard, r.Body)
	e.mu.Lock()
	exec := e.execs[id]
	e.mu.Unlock()
	if exec == nil {
		writeFakeJSON(w, http.StatusNotFound, map[string]string{"message": "No such exec instance: " + id})
		return
	}
	var output []byte
	exitCode := 0
	if e.onExec != nil {
		output, exitCode = e.onExec(exec.container, exec.cmd)
	}
	e.mu.Lock()
	exec.output, exec.exitCode = output, exitCode
	e.mu.Unlock()
	conn, buffered, err := w.(http.Hijacker).Hijack()
	if err != nil {
		e.t.Errorf("hijack exec stream: %v", err)
		return
	}
	defer conn.Close()
	_, _ = buffered.WriteString("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
	_, _ = buffered.Write(output)
	_ = buffered.Flush()
}

func (e *fakeDockerEngine) inspectExec(w http.ResponseWriter, id string) {
	e.mu.Lock()
	exec := e.execs[id]
	e.mu.Unlock()
	if exec == nil {
		writeFakeJSON(w, http.StatusNotFound, map[string]string{"message": "No such exec instance: " + id})
		return
	}
	writeFakeJSON(w, http.StatusOK, map[string]any{"ID": id, "Running": false, "ExitCode": exec.exitCode})
}

// dockerStreamFrame encodes one frame of Docker's multiplexed attach stream.
func dockerStreamFrame(stream byte, payload string) []byte {
	frame := make([]byte, 8, 8+len(payload))
	frame[0] = stream
	binary.BigEndian.PutUint32(frame[4:], uint32(len(payload)))
	return append(frame, payload...)
}

func routerScript(cmd []string) string {
	if len(cmd) == 3 && cmd[0] == "sh" && cmd[1] == "-c" {
		return cmd[2]
	}
	return strings.Join(cmd, " ")
}
