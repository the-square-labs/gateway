package docker

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
)

// legacyDeploymentRouterConfig is the config an older daemon's router keeps on
// disk: its writes replaced the file, its start command rewrote it.
func legacyDeploymentRouterConfig(slot string) string {
	return "server {\n  listen 18080;\n  location / {\n    proxy_pass http://" + slot + ":3000;\n  }\n}\n"
}

// legacyRouter is a router an older daemon created while blue was active,
// then switched to served: no restart policy, the slot baked into its command.
func legacyRouter(t *testing.T, served string, running bool) *fakeContainer {
	t.Helper()
	return &fakeContainer{
		Name:         "gwdep-dep-1-router",
		Image:        "nginx:alpine",
		Cmd:          legacyDeploymentRouterCommand("blue"),
		Labels:       deploymentLabels("router", ""),
		Running:      running,
		PortBindings: testRouterPortBindings(t),
		NetworkMode:  "gwdep-dep-1",
		Files:        map[string]string{deploymentRouterConfigPath: legacyDeploymentRouterConfig(served)},
	}
}

func currentRouter(t *testing.T, policy container.RestartPolicyMode, running bool) *fakeContainer {
	t.Helper()
	options, err := deploymentRouterCreateOptions(deploymentCommandPayload{
		DeploymentID: "dep-1", RouterName: "gwdep-dep-1-router", NetworkName: "gwdep-dep-1", Routes: testDeploymentRoutes,
	}, "blue")
	if err != nil {
		t.Fatal(err)
	}
	return &fakeContainer{
		Name:          "gwdep-dep-1-router",
		Image:         defaultDeploymentRouterImage,
		Cmd:           options.Config.Cmd,
		Labels:        options.Config.Labels,
		Running:       running,
		RestartPolicy: policy,
		PortBindings:  options.HostConfig.PortBindings,
		NetworkMode:   "gwdep-dep-1",
	}
}

// addDeploymentSlots adds the blue and green app slots; running lists the
// slots Docker brought back after the reboot.
func addDeploymentSlots(engine *fakeDockerEngine, extraLabels map[string]string, running ...string) {
	for _, slot := range []string{"blue", "green"} {
		labels := deploymentLabels("app", slot)
		for key, value := range extraLabels {
			labels[key] = value
		}
		up := false
		for _, name := range running {
			up = up || name == slot
		}
		engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-" + slot, Labels: labels, Running: up})
	}
}

func assertNoRouterSetAside(t *testing.T, engine *fakeDockerEngine) {
	t.Helper()
	for _, name := range engine.names() {
		if strings.Contains(name, "-replaced-") {
			t.Fatalf("a replaced router was left behind: %v", engine.names())
		}
	}
}

// TestRepairRecreatesALegacyRouterAfterAReboot reproduces the upgrade from an
// older daemon followed by a node reboot: Docker brought the active slot back,
// the router (restart policy "no") stayed exited, and the route answered 502
// until a deployment action. A router that still runs is replaced as well, so
// it survives the next reboot.
func TestRepairRecreatesALegacyRouterAfterAReboot(t *testing.T) {
	for _, running := range []bool{false, true} {
		t.Run(map[bool]string{false: "exited", true: "running"}[running], func(t *testing.T) {
			engine, client := newFakeDockerEngine(t)
			configs, _ := simulateNginxRouter(engine)
			addDeploymentSlots(engine, nil, "green")
			legacy := engine.addContainer(legacyRouter(t, "green", running))

			repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
			if err != nil {
				t.Fatalf("repair: %v", err)
			}
			if len(repairs) != 1 || repairs[0].Action != "recreated" || repairs[0].Router != "gwdep-dep-1-router" {
				t.Fatalf("repairs = %+v", repairs)
			}
			router := engine.byName("gwdep-dep-1-router")
			if router == nil || router.ID == legacy.ID || !router.Running {
				t.Fatalf("router after repair = %+v, want a running replacement", router)
			}
			if router.RestartPolicy != container.RestartPolicyUnlessStopped {
				t.Fatalf("replacement restart policy = %q", router.RestartPolicy)
			}
			if !deploymentRouterCommandCurrent(container.InspectResponse{Config: &container.Config{Cmd: router.Cmd}, HostConfig: &container.HostConfig{}}) {
				t.Fatalf("replacement keeps the legacy start command: %q", router.Cmd)
			}
			// It serves the slot the old router served, not the one in its command.
			if !strings.Contains(configs[router.ID], "set $deployment_upstream green:3000;") {
				t.Fatalf("replacement serves %q, want green", configs[router.ID])
			}
			if router.NetworkMode != "gwdep-dep-1" || router.Image != "nginx:alpine" {
				t.Fatalf("replacement network %q image %q", router.NetworkMode, router.Image)
			}
			port, _ := network.ParsePort("18080/tcp")
			if bindings := router.PortBindings[port]; len(bindings) != 1 || bindings[0].HostPort != "18080" || bindings[0].HostIP != netip.MustParseAddr("0.0.0.0") {
				t.Fatalf("replacement publishes %+v", router.PortBindings)
			}
			if router.Labels[deploymentIDLabel] != "dep-1" || router.Labels[deploymentRoleLabel] != "router" || router.Labels[deploymentManagedLabel] != "true" {
				t.Fatalf("replacement labels = %v", router.Labels)
			}
			assertNoRouterSetAside(t, engine)
			if engine.byName(legacy.ID) != nil {
				t.Fatal("the legacy router was not removed")
			}
		})
	}
}

// TestRepairStartsACurrentRouterAndRestoresItsRestartPolicy covers a router
// of the current shape whose restart policy was set to "no" (a migration
// source, or lease mode on the stand): it is started in place with the config
// it last served, and restarts with Docker from now on.
func TestRepairStartsACurrentRouterAndRestoresItsRestartPolicy(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, _ := simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green")
	router := engine.addContainer(currentRouter(t, container.RestartPolicyDisabled, false))
	configs[router.ID] = renderDeploymentNginx(testDeploymentRoutes, "green")
	router.Files = map[string]string{deploymentRouterConfigPath: configs[router.ID]}

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if len(repairs) != 1 || repairs[0].Action != "restart policy, started" {
		t.Fatalf("repairs = %+v", repairs)
	}
	current := engine.byName("gwdep-dep-1-router")
	if current.ID != router.ID || !current.Running || current.RestartPolicy != container.RestartPolicyUnlessStopped {
		t.Fatalf("router after repair = %+v", current)
	}
	if engine.countCalls("POST /containers/create") != 0 {
		t.Fatal("a current-shape router must not be recreated")
	}
	if !strings.Contains(configs[router.ID], "green:3000") {
		t.Fatalf("router serves %q after the repair", configs[router.ID])
	}
}

// TestRepairLeavesAStoppedDeploymentStopped: stop and kill stop every slot,
// and a lease standby's slots stay stopped until it holds the lease. Neither
// may get its router started.
func TestRepairLeavesAStoppedDeploymentStopped(t *testing.T) {
	for name, labels := range map[string]map[string]string{
		"stopped deployment": nil,
		"lease standby":      {availabilityPolicyLabel: "policy-1", availabilityPlacementLabel: "placement-1"},
	} {
		t.Run(name, func(t *testing.T) {
			engine, client := newFakeDockerEngine(t)
			simulateNginxRouter(engine)
			addDeploymentSlots(engine, labels)
			legacy := engine.addContainer(legacyRouter(t, "green", false))
			current := engine.addContainer(&fakeContainer{
				Name: "gwdep-dep-2-router", Cmd: currentRouter(t, container.RestartPolicyDisabled, false).Cmd,
				Labels: map[string]string{deploymentManagedLabel: "true", deploymentIDLabel: "dep-2", deploymentRoleLabel: "router"},
			})
			engine.addContainer(&fakeContainer{
				Name:   "gwdep-dep-2-blue",
				Labels: map[string]string{deploymentManagedLabel: "true", deploymentIDLabel: "dep-2", deploymentRoleLabel: "app", deploymentSlotLabel: "blue"},
			})

			repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
			if err != nil || len(repairs) != 0 {
				t.Fatalf("repairs = %+v, err = %v; a stopped deployment must be left alone", repairs, err)
			}
			for _, router := range []*fakeContainer{legacy, current} {
				if got := engine.byName(router.Name); got == nil || got.ID != router.ID || got.Running {
					t.Fatalf("router %s was changed: %+v", router.Name, got)
				}
			}
			for _, call := range []string{"POST /containers/create", "POST /containers/" + legacy.ID + "/start", "POST /containers/" + current.ID + "/start", "POST /containers/" + current.ID + "/update"} {
				if engine.countCalls(call) != 0 {
					t.Fatalf("unexpected %s: %v", call, engine.callLog())
				}
			}
		})
	}
}

func TestRepairKeepsARunningCurrentRouter(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	addDeploymentSlots(engine, nil, "blue")
	router := engine.addContainer(currentRouter(t, container.RestartPolicyUnlessStopped, true))

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil || len(repairs) != 0 {
		t.Fatalf("repairs = %+v, err = %v", repairs, err)
	}
	for _, call := range []string{"POST /containers/create", "POST /containers/" + router.ID + "/start", "POST /containers/" + router.ID + "/update", "POST /containers/" + router.ID + "/stop"} {
		if engine.countCalls(call) != 0 {
			t.Fatalf("a running current router must not be touched: %v", engine.callLog())
		}
	}
}

// TestRepairLeavesARouterDockerKeptStopped: Docker brings every router with
// the restart policy back with the engine unless a deployment stop stopped it;
// an app slot with restart policy "always" comes back even then. At startup
// such a router stays down; a lease holder serving the deployment starts it.
func TestRepairLeavesARouterDockerKeptStopped(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	addDeploymentSlots(engine, nil, "blue")
	router := engine.addContainer(currentRouter(t, container.RestartPolicyUnlessStopped, false))

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil || len(repairs) != 0 {
		t.Fatalf("repairs = %+v, err = %v", repairs, err)
	}
	if engine.byName(router.Name).Running || engine.countCalls("POST /containers/"+router.ID+"/start") != 0 {
		t.Fatal("a router Docker kept stopped must stay stopped at startup")
	}

	repairs, err = client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{serving: true}, nil)
	if err != nil || len(repairs) != 1 || repairs[0].Action != "started" {
		t.Fatalf("serving repairs = %+v, err = %v", repairs, err)
	}
	if current := engine.byName(router.Name); current.ID != router.ID || !current.Running {
		t.Fatalf("a serving node must start its router, got %+v", current)
	}
}

// TestRepairPutsTheLegacyRouterBackWhenItsReplacementFails: a running router
// is only set aside, so a failed replacement leaves the deployment as it was.
func TestRepairPutsTheLegacyRouterBackWhenItsReplacementFails(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green", "blue")
	legacy := engine.addContainer(legacyRouter(t, "green", true))
	engine.failCall = func(method, path string) bool {
		return method == "POST" && path == "/containers/create"
	}

	if _, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil); err == nil || !strings.Contains(err.Error(), "injected failure") {
		t.Fatalf("repair error = %v, want the create failure", err)
	}
	router := engine.byName("gwdep-dep-1-router")
	if router == nil || router.ID != legacy.ID || !router.Running {
		t.Fatalf("the legacy router must be back under its name and running, got %+v", router)
	}
	assertNoRouterSetAside(t, engine)
}

func TestRepairRefusesALegacyRouterWhoseConfigDoesNotMatchItsPorts(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	addDeploymentSlots(engine, nil, "green")
	legacy := legacyRouter(t, "green", false)
	legacy.Files[deploymentRouterConfigPath] = strings.Replace(legacy.Files[deploymentRouterConfigPath], "listen 18080;", "listen 18081;", 1)
	engine.addContainer(legacy)

	if _, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil); err == nil || !strings.Contains(err.Error(), "published ports") {
		t.Fatalf("repair error = %v, want a port mismatch", err)
	}
	if router := engine.byName("gwdep-dep-1-router"); router.ID != legacy.ID || router.Running {
		t.Fatalf("an unreadable legacy router must be left as it is, got %+v", router)
	}
	if engine.countCalls("POST /containers/create") != 0 || engine.countCalls("POST /containers/"+legacy.ID+"/rename") != 0 {
		t.Fatalf("unexpected changes: %v", engine.callLog())
	}
}

// TestLeaseHolderBringsBackItsDeploymentRouterBeforeServing reproduces stand
// finding c2: after the holder rebooted, the lease runtime started its copy
// but nothing started the router (not lease-governed, restart policy "no"),
// so every lease route on the node answered 502. Opening the endpoints now
// brings back the routers of the policy's deployments, and only those.
func TestLeaseHolderBringsBackItsDeploymentRouterBeforeServing(t *testing.T) {
	plugin := leasePluginForTest(t)
	engine, client := newFakeDockerEngine(t)
	plugin.client = client
	configs, _ := simulateNginxRouter(engine)
	addDeploymentSlots(engine, map[string]string{availabilityPolicyLabel: "policy-1", availabilityPlacementLabel: "placement-1"}, "green")
	legacy := engine.addContainer(legacyRouter(t, "green", false))
	other := engine.addContainer(&fakeContainer{
		Name: "gwdep-dep-2-router", Cmd: currentRouter(t, container.RestartPolicyDisabled, false).Cmd,
		Labels: map[string]string{deploymentManagedLabel: "true", deploymentIDLabel: "dep-2", deploymentRoleLabel: "router"},
	})
	engine.addContainer(&fakeContainer{
		Name: "gwdep-dep-2-blue", Running: true,
		Labels: map[string]string{
			deploymentManagedLabel: "true", deploymentIDLabel: "dep-2", deploymentRoleLabel: "app", deploymentSlotLabel: "blue",
			availabilityPolicyLabel: "policy-2",
		},
	})

	plugin.lease.SetServing("policy-1", true)

	router := engine.byName("gwdep-dep-1-router")
	if router == nil || router.ID == legacy.ID || !router.Running || router.RestartPolicy != container.RestartPolicyUnlessStopped {
		t.Fatalf("the holder's router must run before its endpoints open, got %+v", router)
	}
	if !strings.Contains(configs[router.ID], "green:3000") {
		t.Fatalf("router serves %q", configs[router.ID])
	}
	if got := engine.byName("gwdep-dep-2-router"); got.ID != other.ID || got.Running {
		t.Fatal("another policy's router must not be touched")
	}
}

func TestDeploymentRouterConfigRoutes(t *testing.T) {
	first, _ := network.ParsePort("18080/tcp")
	second, _ := network.ParsePort("18443/tcp")
	bindings := network.PortMap{
		first:  {{HostIP: netip.MustParseAddr("127.0.0.1"), HostPort: "18080"}},
		second: {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: "18443"}},
	}
	routes := []deploymentRouteConfig{{HostPort: 18080, ContainerPort: 3000}, {HostPort: 18443, ContainerPort: 8443}}
	for name, config := range map[string]string{
		"current": renderDeploymentNginx(routes, "green"),
		"legacy":  legacyDeploymentRouterConfig("green") + strings.ReplaceAll(strings.ReplaceAll(legacyDeploymentRouterConfig("green"), "18080", "18443"), "3000", "8443"),
	} {
		slot, parsed, err := deploymentRouterConfigRoutes(config, bindings)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		want := []deploymentRouteConfig{
			{HostPort: 18080, HostIP: "127.0.0.1", ContainerPort: 3000, IsPrimary: true},
			{HostPort: 18443, HostIP: "0.0.0.0", ContainerPort: 8443},
		}
		if slot != "green" || len(parsed) != 2 || parsed[0] != want[0] || parsed[1] != want[1] {
			t.Fatalf("%s: slot %q routes %+v", name, slot, parsed)
		}
	}
	if _, _, err := deploymentRouterConfigRoutes(renderDeploymentNginx(routes[:1], "blue"), bindings); err == nil {
		t.Fatal("a config that does not cover every published port must be refused")
	}
	mixed := renderDeploymentNginx(routes[:1], "blue") + renderDeploymentNginx(routes[1:], "green")
	if _, _, err := deploymentRouterConfigRoutes(mixed, bindings); err == nil {
		t.Fatal("a config naming two slots must be refused")
	}
}

// perRequestDeploymentRouterConfig is the config rc.20 and earlier daemons
// rendered: the slot resolved per request through Docker's embedded DNS.
func perRequestDeploymentRouterConfig(slot string) string {
	return "map $http_upgrade $connection_upgrade {\n  default upgrade;\n  '' close;\n}\n" +
		"server {\n  listen 18080;\n  resolver 127.0.0.11 valid=10s ipv6=off;\n  client_max_body_size 0;\n  location / {\n" +
		"    set $deployment_upstream " + slot + ":3000;\n    proxy_pass http://$deployment_upstream;\n" +
		"    proxy_redirect http://$deployment_upstream/ /;\n    proxy_connect_timeout 5s;\n  }\n}\n"
}

// B-8: routers of earlier daemons resolve their slot per request through
// dockerd's DNS; a daemon start (and a lease holder before it serves) rewrites
// their config in place for the same slot and routes, without a recreate.
func TestRepairUpgradesAPerRequestRouterConfig(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, writes := simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green")
	router := currentRouter(t, container.RestartPolicyUnlessStopped, true)
	router.Files = map[string]string{deploymentRouterConfigPath: perRequestDeploymentRouterConfig("green")}
	added := engine.addContainer(router)

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if len(repairs) != 1 || repairs[0].Action != "config upgraded" {
		t.Fatalf("repairs = %+v", repairs)
	}
	if engine.countCalls("POST /containers/create") != 0 {
		t.Fatal("a config upgrade must not recreate the router")
	}
	written := configs[added.ID]
	if len(*writes) != 1 || !deploymentRouterConfigCurrent(written) || !strings.Contains(written, "  server green:3000 resolve;") ||
		!strings.Contains(written, "listen 18080;") {
		t.Fatalf("upgraded config = %q", written)
	}

	// A router that serves the current config is left alone.
	added.Files[deploymentRouterConfigPath] = written
	repairs, err = client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil || len(repairs) != 0 || len(*writes) != 1 {
		t.Fatalf("second repair = %+v, %v, writes %d", repairs, err, len(*writes))
	}
}

// Item 3 of the rc.20 review (B-8 for nginx before 1.27.3): the router config
// carries the active slot's address, and a slot that comes back at another
// address gets its router re-rendered, so the fallback variant never asks
// dockerd's DNS.
func TestRouterFollowsItsActiveSlotsAddress(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, writes := simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green")
	green := engine.byName("gwdep-dep-1-green")
	green.Networks = map[string]netip.Addr{"gwdep-dep-1": netip.MustParseAddr("172.21.0.9")}
	router := currentRouter(t, container.RestartPolicyUnlessStopped, true)
	router.Files = map[string]string{deploymentRouterConfigPath: renderDeploymentNginxAt(testDeploymentRoutes, "green", "172.21.0.5")}
	added := engine.addContainer(router)
	plugin := &DockerPlugin{client: client, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}

	plugin.reconcileDeploymentRouterAddresses(context.Background())
	written := configs[added.ID]
	if len(*writes) != 1 || deploymentRouterConfigAddress(written) != "172.21.0.9" || deploymentRouterConfigSlot(written) != "green" ||
		!strings.Contains(written, "# gateway:fallback upstream gateway_deployment_green_3000 { server 172.21.0.9:3000; }") {
		t.Fatalf("config after the slot moved = %q (%d writes)", written, len(*writes))
	}

	// Unchanged address: nothing is written.
	added.Files[deploymentRouterConfigPath] = written
	plugin.reconcileDeploymentRouterAddresses(context.Background())
	if len(*writes) != 1 {
		t.Fatalf("an unchanged address was re-rendered: %d writes", len(*writes))
	}
	// The slot stopped: the last config stays, nothing to follow.
	green.Running = false
	plugin.reconcileDeploymentRouterAddresses(context.Background())
	if len(*writes) != 1 {
		t.Fatalf("a stopped slot changed the router: %d writes", len(*writes))
	}
}

// TestRepairBringsBackARouterCreatedByGateway2101 reproduces M-1 on the second
// stand instance: a blue/green deployment created by 2.10.1, switched to green
// (blue exited), router with restart policy "no" and the 2.10.1 start command
// that bakes blue in. After a node restart the router stayed exited while
// green ran, and the route answered 502 until an operator acted.
func TestRepairBringsBackARouterCreatedByGateway2101(t *testing.T) {
	const config2101 = "map $http_upgrade $connection_upgrade {\n  default upgrade;\n  '' close;\n}\n" +
		"server {\n  listen 18080;\n  location / {\n    proxy_pass http://%s:3000;\n    proxy_http_version 1.1;\n" +
		"    proxy_set_header Host $host;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection $connection_upgrade;\n  }\n}\n"
	for name, onDisk := range map[string]string{
		// The switch to green rewrote the file on disk.
		"config on disk names the running slot": "green",
		// The router was started once more after the switch, and its start
		// command put the creation-time slot back.
		"config on disk names the stopped slot": "blue",
	} {
		t.Run(name, func(t *testing.T) {
			engine, client := newFakeDockerEngine(t)
			configs, _ := simulateNginxRouter(engine)
			addDeploymentSlots(engine, nil, "green")
			legacy := engine.addContainer(&fakeContainer{
				Name:  "gwdep-dep-1-router",
				Image: "nginx:alpine",
				Cmd: []string{"sh", "-c", "cat > /etc/nginx/conf.d/default.conf <<'EOF'\n" +
					fmt.Sprintf(config2101, "blue") + "\nEOF\nnginx -g 'daemon off;'"},
				Labels:        deploymentLabels("router", ""),
				RestartPolicy: container.RestartPolicyDisabled,
				PortBindings:  testRouterPortBindings(t),
				NetworkMode:   "gwdep-dep-1-net",
				Files:         map[string]string{deploymentRouterConfigPath: fmt.Sprintf(config2101, onDisk)},
			})

			plugin := &DockerPlugin{client: client, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			if err := plugin.runDeploymentRouterRepair("", deploymentRouterRepairStartupTimeout); err != nil {
				t.Fatalf("repair: %v", err)
			}
			router := engine.byName("gwdep-dep-1-router")
			if router == nil || router.ID == legacy.ID || !router.Running {
				t.Fatalf("router after repair = %+v, want a running replacement", router)
			}
			if router.RestartPolicy != container.RestartPolicyUnlessStopped || router.NetworkMode != "gwdep-dep-1-net" {
				t.Fatalf("replacement restart policy %q network %q", router.RestartPolicy, router.NetworkMode)
			}
			if !strings.Contains(configs[router.ID], "set $deployment_upstream green:3000;") {
				t.Fatalf("replacement serves %q, want the running green slot", configs[router.ID])
			}
			assertNoRouterSetAside(t, engine)
		})
	}
}

// TestRepairPointsARestartedRouterAtTheRunningSlot: a current-shape router
// whose config on disk still names the slot a later switch stopped is started
// and pointed at the slot that runs, in place.
func TestRepairPointsARestartedRouterAtTheRunningSlot(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, writes := simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green")
	router := engine.addContainer(currentRouter(t, container.RestartPolicyDisabled, false))
	configs[router.ID] = renderDeploymentNginx(testDeploymentRoutes, "blue")
	router.Files = map[string]string{deploymentRouterConfigPath: configs[router.ID]}

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil {
		t.Fatalf("repair: %v", err)
	}
	if len(repairs) != 1 || repairs[0].Action != "restart policy, started, serves green" {
		t.Fatalf("repairs = %+v", repairs)
	}
	current := engine.byName("gwdep-dep-1-router")
	if current.ID != router.ID || !current.Running || engine.countCalls("POST /containers/create") != 0 {
		t.Fatalf("router after repair = %+v; it must be kept, not recreated", current)
	}
	if len(*writes) != 1 || !strings.Contains(configs[router.ID], "set $deployment_upstream green:3000;") {
		t.Fatalf("router serves %q after writes %v", configs[router.ID], *writes)
	}
}

// TestRepairKeepsTheRouterSlotWhileBothSlotsRun: during a deploy both slots
// run and only the router's own config knows which one is active.
func TestRepairKeepsTheRouterSlotWhileBothSlotsRun(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, writes := simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "blue", "green")
	router := engine.addContainer(currentRouter(t, container.RestartPolicyDisabled, false))
	configs[router.ID] = renderDeploymentNginx(testDeploymentRoutes, "blue")
	router.Files = map[string]string{deploymentRouterConfigPath: configs[router.ID]}

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil || len(repairs) != 1 || repairs[0].Action != "restart policy, started" {
		t.Fatalf("repairs = %+v, err = %v", repairs, err)
	}
	if len(*writes) != 0 || !strings.Contains(configs[router.ID], "blue:3000") {
		t.Fatalf("router config changed to %q", configs[router.ID])
	}
}

// TestRouterRepairLoopRetriesAFailedRepair: a repair that failed at startup is
// retried without an operator.
func TestRouterRepairLoopRetriesAFailedRepair(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green")
	engine.addContainer(legacyRouter(t, "green", false))
	var failing atomic.Bool
	failing.Store(true)
	engine.failCall = func(method, path string) bool {
		return failing.Load() && method == "POST" && path == "/containers/create"
	}
	plugin := &DockerPlugin{client: client, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := plugin.runDeploymentRouterRepair("", deploymentRouterRepairStartupTimeout); err == nil {
		t.Fatal("the first repair must fail")
	}
	failing.Store(false)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go plugin.deploymentRouterRepairLoop(ctx, 10*time.Millisecond)
	deadline := time.Now().Add(5 * time.Second)
	for {
		router := engine.byName("gwdep-dep-1-router")
		if router != nil && router.Running && router.RestartPolicy == container.RestartPolicyUnlessStopped {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the repair loop did not bring the router back: %+v", router)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// M-1 slot alignment and the B-8 address pass work on one config: a router
// brought back and pointed at the running slot gets that slot's address in the
// same write, and the address pass that follows finds nothing to undo.
func TestRepairAlignsARestartedRouterWithTheRunningSlotsAddress(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	configs, writes := simulateNginxRouter(engine)
	addDeploymentSlots(engine, nil, "green")
	green := engine.byName("gwdep-dep-1-green")
	green.Networks = map[string]netip.Addr{"gwdep-dep-1": netip.MustParseAddr("172.21.0.9")}
	router := engine.addContainer(currentRouter(t, container.RestartPolicyDisabled, false))
	configs[router.ID] = renderDeploymentNginx(testDeploymentRoutes, "blue")
	router.Files = map[string]string{deploymentRouterConfigPath: configs[router.ID]}

	repairs, err := client.repairServingDeploymentRouters(context.Background(), deploymentRouterRepairScope{}, nil)
	if err != nil || len(repairs) != 1 || repairs[0].Action != "restart policy, started, serves green" {
		t.Fatalf("repairs = %+v, err = %v", repairs, err)
	}
	written := configs[router.ID]
	if len(*writes) != 1 || deploymentRouterConfigSlot(written) != "green" || deploymentRouterConfigAddress(written) != "172.21.0.9" {
		t.Fatalf("aligned config = %q (%d writes)", written, len(*writes))
	}
	router.Files[deploymentRouterConfigPath] = written
	plugin := &DockerPlugin{client: client, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	plugin.reconcileDeploymentRouterAddresses(context.Background())
	if err := plugin.runDeploymentRouterRepair("", deploymentRouterRepairStartupTimeout); err != nil || len(*writes) != 1 {
		t.Fatalf("a later pass rewrote the aligned router: err %v, %d writes", err, len(*writes))
	}
}
