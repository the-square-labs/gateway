package docker

import (
	"context"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

var testDeploymentRoutes = []deploymentRouteConfig{{HostPort: 18080, ContainerPort: 3000, IsPrimary: true}}

// legacyDeploymentRouterCommand is the start command routers were created with
// before the config marker: it rewrote the creation-time config on every start.
func legacyDeploymentRouterCommand(activeSlot string) []string {
	config := "server {\n  listen 18080;\n  location / {\n    proxy_pass http://" + activeSlot + ":3000;\n  }\n}\n"
	return []string{"sh", "-c", "cat > /etc/nginx/conf.d/default.conf <<'EOF'\n" + config + "\nEOF\nnginx -g 'daemon off;'"}
}

func testRouterPortBindings(t *testing.T) network.PortMap {
	t.Helper()
	port, err := network.ParsePort("18080/tcp")
	if err != nil {
		t.Fatal(err)
	}
	return network.PortMap{port: {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: "18080"}}}
}

func testDeploymentSnapshot(activeSlot string) deploymentSnapshot {
	return deploymentSnapshot{
		ID:          "dep-1",
		RouterName:  "gwdep-dep-1-router",
		RouterImage: "nginx:alpine",
		NetworkName: "gwdep-dep-1",
		ActiveSlot:  activeSlot,
		Routes:      testDeploymentRoutes,
		DesiredConfig: deploymentDesiredConfig{
			Image: "registry.example/app:v2",
		},
		Slots: []struct {
			Slot          string `json:"slot"`
			ContainerName string `json:"containerName"`
		}{
			{Slot: "blue", ContainerName: "gwdep-dep-1-blue"},
			{Slot: "green", ContainerName: "gwdep-dep-1-green"},
		},
	}
}

func deploymentLabels(role, slot string) map[string]string {
	labels := map[string]string{
		deploymentManagedLabel: "true",
		deploymentIDLabel:      "dep-1",
		deploymentRoleLabel:    role,
	}
	if slot != "" {
		labels[deploymentSlotLabel] = slot
	}
	return labels
}

var heredocConfig = regexp.MustCompile(`<<'EOF'[^\n]*\n([\s\S]*?)\nEOF\n`)

// simulateNginxRouter makes router containers behave like nginx: a start loads
// the config the start command leaves on disk and fails on a static upstream
// whose host does not resolve; router execs write the config they carry.
func simulateNginxRouter(engine *fakeDockerEngine) (configs map[string]string, writes *[]string) {
	configs = map[string]string{} // router ID -> config on disk
	writes = &[]string{}
	staticUpstream := regexp.MustCompile(`proxy_pass http://([a-z]+):`)
	engine.onStart = func(ctr *fakeContainer) bool {
		if ctr.Labels[deploymentRoleLabel] != "router" {
			return true
		}
		script := routerScript(ctr.Cmd)
		engine.mu.Lock()
		defer engine.mu.Unlock()
		_, written := configs[ctr.ID]
		guarded := strings.Contains(script, "if [ ! -f "+deploymentRouterConfigMarker+" ]")
		if !written || !guarded {
			if match := heredocConfig.FindStringSubmatch(script); match != nil {
				configs[ctr.ID] = match[1]
			}
		}
		if match := staticUpstream.FindStringSubmatch(configs[ctr.ID]); match != nil {
			upstream := engine.lookupLocked("gwdep-dep-1-" + match[1])
			if upstream == nil || !upstream.Running {
				return false // [emerg] host not found in upstream
			}
		}
		return true
	}
	engine.onExec = func(ctr *fakeContainer, cmd []string) ([]byte, int) {
		match := heredocConfig.FindStringSubmatch(routerScript(cmd))
		if match == nil {
			return dockerStreamFrame(2, "unexpected router exec"), 1
		}
		engine.mu.Lock()
		configs[ctr.ID] = match[1]
		*writes = append(*writes, match[1])
		engine.mu.Unlock()
		return nil, 0
	}
	return configs, writes
}

func TestRenderDeploymentNginxResolvesActiveSlotPerRequest(t *testing.T) {
	config := renderDeploymentNginx([]deploymentRouteConfig{
		{HostPort: 18080, ContainerPort: 3000, IsPrimary: true},
		{HostPort: 18443, ContainerPort: 8443},
	}, "green")
	for _, want := range []string{
		"listen 18080;",
		"listen 18443;",
		"resolver 127.0.0.11 valid=10s ipv6=off;",
		"set $deployment_upstream green:3000;",
		"set $deployment_upstream green:8443;",
		"proxy_pass http://$deployment_upstream;",
		"proxy_redirect http://$deployment_upstream/ /;",
		"proxy_connect_timeout 5s;",
		"proxy_http_version 1.1;",
		"proxy_set_header Host $host;",
		"proxy_set_header X-Real-IP $remote_addr;",
		"proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
		"proxy_set_header X-Forwarded-Proto $scheme;",
		"proxy_set_header Upgrade $http_upgrade;",
		"proxy_set_header Connection $connection_upgrade;",
	} {
		if !strings.Contains(config, want) {
			t.Fatalf("router config is missing %q:\n%s", want, config)
		}
	}
	// A static upstream is resolved once when nginx loads the config, and
	// nginx refuses to start while the slot container does not resolve.
	if strings.Contains(config, "proxy_pass http://green:") {
		t.Fatalf("router config still uses a static upstream:\n%s", config)
	}
	// A URI part in proxy_pass would replace the request URI.
	if strings.Contains(config, "proxy_pass http://$deployment_upstream/") {
		t.Fatalf("proxy_pass must not carry a URI part:\n%s", config)
	}
}

func TestDeploymentRouterCreateOptionsKeepConfigAcrossRestarts(t *testing.T) {
	options, err := deploymentRouterCreateOptions(deploymentCommandPayload{
		DeploymentID: "dep-1",
		RouterName:   "gwdep-dep-1-router",
		NetworkName:  "gwdep-dep-1",
		Routes:       testDeploymentRoutes,
	}, "blue")
	if err != nil {
		t.Fatal(err)
	}
	if options.HostConfig.RestartPolicy.Name != container.RestartPolicyUnlessStopped {
		t.Fatalf("router restart policy = %q, want unless-stopped", options.HostConfig.RestartPolicy.Name)
	}
	if options.Config.Image != defaultDeploymentRouterImage {
		t.Fatalf("router image = %q", options.Config.Image)
	}
	script := routerScript(options.Config.Cmd)
	if !strings.HasPrefix(script, "if [ ! -f "+deploymentRouterConfigMarker+" ]; then\n") ||
		!strings.HasSuffix(script, "exec nginx -g 'daemon off;'") {
		t.Fatalf("router start command does not guard the initial config:\n%s", script)
	}
	if !strings.Contains(script, "set $deployment_upstream blue:3000;") {
		t.Fatalf("router start command lacks the initial config:\n%s", script)
	}
	current := container.InspectResponse{
		Config:     options.Config,
		HostConfig: options.HostConfig,
	}
	if deploymentRouterContainerNeedsRecreate(current, testDeploymentRoutes) {
		t.Fatal("a freshly created router must not be recreated")
	}
}

func TestDeploymentRouterContainerNeedsRecreate(t *testing.T) {
	current := func(cmd []string, policy container.RestartPolicyMode, bindings network.PortMap) container.InspectResponse {
		return container.InspectResponse{
			Config:     &container.Config{Cmd: cmd},
			HostConfig: &container.HostConfig{RestartPolicy: container.RestartPolicy{Name: policy}, PortBindings: bindings},
		}
	}
	bindings := testRouterPortBindings(t)
	createdForBlue := deploymentRouterCommand(renderDeploymentNginx(testDeploymentRoutes, "blue"))

	// The embedded config goes stale after every switch; comparing it would
	// recreate the router on each route update.
	if deploymentRouterContainerNeedsRecreate(current(createdForBlue, container.RestartPolicyUnlessStopped, bindings), testDeploymentRoutes) {
		t.Fatal("a current-shape router with matching ports must be kept")
	}
	if !deploymentRouterContainerNeedsRecreate(current(legacyDeploymentRouterCommand("blue"), "", bindings), testDeploymentRoutes) {
		t.Fatal("a router created by an older daemon must be recreated")
	}
	if !deploymentRouterContainerNeedsRecreate(current(createdForBlue, "", bindings), testDeploymentRoutes) {
		t.Fatal("a router without the restart policy must be recreated")
	}
	moved := []deploymentRouteConfig{{HostPort: 18081, ContainerPort: 3000, IsPrimary: true}}
	if !deploymentRouterContainerNeedsRecreate(current(createdForBlue, container.RestartPolicyUnlessStopped, bindings), moved) {
		t.Fatal("a router publishing other ports must be recreated")
	}
	if !deploymentRouterContainerNeedsRecreate(container.InspectResponse{}, testDeploymentRoutes) {
		t.Fatal("a router without configuration must be recreated")
	}
}

// TestDeploymentRouterScriptsKeepLastWrittenConfig runs the real start and
// reload scripts against a stand-in nginx.
func TestDeploymentRouterScriptsKeepLastWrittenConfig(t *testing.T) {
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is not available")
	}
	dir := t.TempDir()
	confDir := filepath.Join(dir, "conf.d")
	binDir := filepath.Join(dir, "bin")
	for _, path := range []string{confDir, binDir} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	nginx := "#!/bin/sh\n" +
		"if [ \"$1\" = \"-s\" ]; then\n" +
		"  if [ -n \"$NGINX_RELOAD_FAIL\" ]; then echo 'nginx: [emerg] invalid config' >&2; exit 1; fi\n" +
		"  echo reload >> \"$NGINX_LOG\"; exit 0\n" +
		"fi\n" +
		"echo \"start $*\" >> \"$NGINX_LOG\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "nginx"), []byte(nginx), 0o755); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "nginx.log")
	run := func(script string, env ...string) error {
		cmd := exec.Command(shell, "-c", strings.ReplaceAll(script, "/etc/nginx/conf.d", confDir))
		cmd.Env = append(os.Environ(), "PATH="+binDir+":"+os.Getenv("PATH"), "NGINX_LOG="+logPath)
		cmd.Env = append(cmd.Env, env...)
		output, err := cmd.CombinedOutput()
		if err != nil {
			return &exec.ExitError{ProcessState: cmd.ProcessState, Stderr: output}
		}
		return nil
	}
	conf := filepath.Join(confDir, "default.conf")
	readConf := func() string {
		data, err := os.ReadFile(conf)
		if err != nil {
			t.Fatalf("read router config: %v", err)
		}
		return string(data)
	}
	blue := renderDeploymentNginx(testDeploymentRoutes, "blue")
	green := renderDeploymentNginx(testDeploymentRoutes, "green")
	start := routerScript(deploymentRouterCommand(blue))

	if err := run(start); err != nil {
		t.Fatalf("first router start: %v", err)
	}
	if got := readConf(); got != blue+"\n" {
		t.Fatalf("first start wrote %q, want the creation config", got)
	}
	if err := run(deploymentRouterWriteScript(green)); err != nil {
		t.Fatalf("write green config: %v", err)
	}
	if got := readConf(); got != green+"\n" {
		t.Fatalf("config after switch = %q", got)
	}
	if err := run(start); err != nil {
		t.Fatalf("router restart: %v", err)
	}
	if got := readConf(); got != green+"\n" {
		t.Fatalf("restart reverted the router to its creation config: %q", got)
	}
	if err := run(deploymentRouterWriteScript(blue), "NGINX_RELOAD_FAIL=1"); err == nil {
		t.Fatal("a rejected reload must fail the write")
	}
	if got := readConf(); got != green+"\n" {
		t.Fatalf("a rejected config must be rolled back, got %q", got)
	}
	for _, leftover := range []string{conf + ".next", conf + ".prev"} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Fatalf("temporary router config %s left behind: %v", leftover, err)
		}
	}
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if want := "start -g daemon off;\nreload\nstart -g daemon off;\n"; string(log) != want {
		t.Fatalf("nginx invocations = %q, want %q", log, want)
	}
}

func TestWriteRouterConfigDemultiplexesReloadOutput(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-router", Running: true, Labels: deploymentLabels("router", "")})
	engine.onExec = func(*fakeContainer, []string) ([]byte, int) {
		// A 178-byte frame has the length byte 0xb2, which is not valid UTF-8.
		message := "nginx: [emerg] host not found in upstream \"blue\" in /etc/nginx/conf.d/default.conf:8"
		message += strings.Repeat(".", 178-len(message))
		return append(dockerStreamFrame(2, message), dockerStreamFrame(1, "nginx: configuration file test failed")...), 1
	}

	err := client.writeRouterConfig(context.Background(), "gwdep-dep-1-router", renderDeploymentNginx(testDeploymentRoutes, "blue"))
	if err == nil {
		t.Fatal("expected the failed reload to be reported")
	}
	text := err.Error()
	if !utf8.ValidString(text) {
		t.Fatalf("reload error is not valid UTF-8: %q", text)
	}
	if strings.ContainsAny(text, "\x00\x01\x02") {
		t.Fatalf("reload error still carries Docker stream headers: %q", text)
	}
	if !strings.HasPrefix(text, "reload router failed: nginx: [emerg] host not found in upstream \"blue\"") ||
		!strings.HasSuffix(text, "\nnginx: configuration file test failed") {
		t.Fatalf("reload error = %q", text)
	}
}

func TestWriteRouterConfigRetriesWhileNginxStarts(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-router", Running: true, Labels: deploymentLabels("router", "")})
	attempts := 0
	engine.onExec = func(*fakeContainer, []string) ([]byte, int) {
		attempts++
		if attempts == 1 {
			return dockerStreamFrame(2, "nginx: [error] open() \"/run/nginx.pid\" failed (2: No such file or directory)\n"), 1
		}
		return nil, 0
	}
	if err := client.writeRouterConfig(context.Background(), "gwdep-dep-1-router", "server {}"); err != nil {
		t.Fatalf("write router config: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("reload attempts = %d, want 2", attempts)
	}
}

// TestStartDeploymentRecreatesLegacyRouter reproduces create (blue) → deploy
// (green) → Stop → Start with a router created by an older daemon.
func TestStartDeploymentRecreatesLegacyRouter(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, writes := simulateNginxRouter(engine)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Image: "registry.example/app:v1", Labels: deploymentLabels("app", "blue")})
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Image: "registry.example/app:v2", Labels: deploymentLabels("app", "green")})
	legacy := engine.addContainer(&fakeContainer{
		Name:         "gwdep-dep-1-router",
		Image:        "nginx:alpine",
		Cmd:          legacyDeploymentRouterCommand("blue"),
		Labels:       deploymentLabels("router", ""),
		PortBindings: testRouterPortBindings(t),
	})

	_, err := client.StartDeployment(context.Background(), deploymentCommandPayload{
		DeploymentID: "dep-1",
		Force:        true,
		Deployment:   testDeploymentSnapshot("green"),
	})
	if err != nil {
		t.Fatalf("start deployment: %v", err)
	}
	router := engine.byName("gwdep-dep-1-router")
	if router == nil || !router.Running {
		t.Fatal("router is not running after start")
	}
	if router.ID == legacy.ID {
		t.Fatal("the legacy router was restarted instead of recreated")
	}
	if router.RestartPolicy != container.RestartPolicyUnlessStopped {
		t.Fatalf("recreated router restart policy = %q", router.RestartPolicy)
	}
	if !strings.Contains(configs[router.ID], "set $deployment_upstream green:3000;") {
		t.Fatalf("recreated router serves %q, want the active green slot", configs[router.ID])
	}
	if len(*writes) != 1 || !strings.Contains((*writes)[0], "green:3000") {
		t.Fatalf("router config writes = %q", *writes)
	}
	if blue := engine.byName("gwdep-dep-1-blue"); blue.Running {
		t.Fatal("inactive blue slot must stay stopped")
	}
}

func TestStartDeploymentRestartsCurrentRouterWithLastConfig(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, _ := simulateNginxRouter(engine)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Labels: deploymentLabels("app", "blue")})
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Labels: deploymentLabels("app", "green")})

	// Created while blue was active, then switched to green.
	options, err := deploymentRouterCreateOptions(deploymentCommandPayload{
		DeploymentID: "dep-1", RouterName: "gwdep-dep-1-router", NetworkName: "gwdep-dep-1", Routes: testDeploymentRoutes,
	}, "blue")
	if err != nil {
		t.Fatal(err)
	}
	router := engine.addContainer(&fakeContainer{
		Name:          "gwdep-dep-1-router",
		Cmd:           options.Config.Cmd,
		Labels:        options.Config.Labels,
		RestartPolicy: options.HostConfig.RestartPolicy.Name,
		PortBindings:  options.HostConfig.PortBindings,
	})
	configs[router.ID] = renderDeploymentNginx(testDeploymentRoutes, "green")

	if _, err := client.StartDeployment(context.Background(), deploymentCommandPayload{
		DeploymentID: "dep-1",
		Force:        true,
		Deployment:   testDeploymentSnapshot("green"),
	}); err != nil {
		t.Fatalf("start deployment: %v", err)
	}
	current := engine.byName("gwdep-dep-1-router")
	if current.ID != router.ID || !current.Running {
		t.Fatalf("current-shape router should be started in place, got %+v", current)
	}
	if engine.countCalls("POST /containers/create") != 0 {
		t.Fatal("current-shape router must not be recreated")
	}
	if !strings.Contains(configs[router.ID], "green:3000") {
		t.Fatalf("router serves %q after restart", configs[router.ID])
	}
}

func TestStartDeploymentRefusesToReplaceForeignRouter(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	simulateNginxRouter(engine)
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Labels: deploymentLabels("app", "green")})
	foreign := engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-router", Cmd: []string{"nginx"}})

	_, err := client.StartDeployment(context.Background(), deploymentCommandPayload{
		DeploymentID: "dep-1",
		Force:        true,
		Deployment:   testDeploymentSnapshot("green"),
	})
	if err == nil || !strings.Contains(err.Error(), "not owned by deployment dep-1") {
		t.Fatalf("start error = %v, want an ownership error", err)
	}
	if engine.byName("gwdep-dep-1-router") != foreign {
		t.Fatal("an unowned container must never be removed")
	}
}
