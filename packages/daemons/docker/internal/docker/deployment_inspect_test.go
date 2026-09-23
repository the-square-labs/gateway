package docker

import (
	"encoding/json"
	"testing"
)

const defaultNginxConfig = "server {\n  listen 80;\n  location / {\n    root /usr/share/nginx/html;\n  }\n}\n"

func inspectDeploymentResult(t *testing.T, plugin *DockerPlugin, dep deploymentSnapshot) map[string]json.RawMessage {
	t.Helper()
	result := awaitDeploymentResult(t, runDeploymentCommand(plugin, deploymentCommand(t, "inspect", dep)))
	if !result.Success {
		t.Fatalf("inspect failed: %s", result.Error)
	}
	var detail map[string]json.RawMessage
	if err := json.Unmarshal([]byte(result.Detail), &detail); err != nil {
		t.Fatalf("decode inspect detail %q: %v", result.Detail, err)
	}
	return detail
}

func inspectedRouter(t *testing.T, detail map[string]json.RawMessage) deploymentRouterInspect {
	t.Helper()
	var router deploymentRouterInspect
	if err := json.Unmarshal(detail["router"], &router); err != nil {
		t.Fatalf("decode router %s: %v", detail["router"], err)
	}
	return router
}

func addDeploymentContainers(engine *fakeDockerEngine, router *fakeContainer) {
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-blue", Running: true, Labels: deploymentLabels("app", "blue")})
	engine.addContainer(&fakeContainer{Name: "gwdep-dep-1-green", Running: true, Labels: deploymentLabels("app", "green")})
	if router != nil {
		router.Labels = deploymentLabels("router", "")
		engine.addContainer(router)
	}
}

func TestInspectDeploymentReportsTheSlotTheRouterServes(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	// Created while blue was active, then switched to green: the creation
	// command is stale, the config on disk is what nginx serves.
	addDeploymentContainers(engine, &fakeContainer{
		Name:    "gwdep-dep-1-router",
		Running: true,
		Cmd:     deploymentRouterCommand(renderDeploymentNginx(testDeploymentRoutes, "blue")),
		Files:   map[string]string{deploymentRouterConfigPath: renderDeploymentNginx(testDeploymentRoutes, "green") + "\n"},
	})
	plugin := &DockerPlugin{client: client}

	detail := inspectDeploymentResult(t, plugin, testDeploymentSnapshot("blue"))
	router := inspectedRouter(t, detail)
	if !router.Found || !router.Running || router.ServedSlot != "green" || router.ConfigSource != "file" || router.Error != "" {
		t.Fatalf("router = %+v, want running router serving green from its config file", router)
	}
	var containers []ContainerInfo
	if err := json.Unmarshal(detail["containers"], &containers); err != nil || len(containers) != 3 {
		t.Fatalf("containers = %s (%v), want router and both slots", detail["containers"], err)
	}
	if string(detail["operationInProgress"]) != "false" {
		t.Fatalf("operationInProgress = %s, want false", detail["operationInProgress"])
	}
}

func TestInspectDeploymentReadsTheConfigOfAStoppedRouter(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	addDeploymentContainers(engine, &fakeContainer{
		Name:  "gwdep-dep-1-router",
		Cmd:   deploymentRouterCommand(renderDeploymentNginx(testDeploymentRoutes, "blue")),
		Files: map[string]string{deploymentRouterConfigPath: renderDeploymentNginx(testDeploymentRoutes, "green") + "\n"},
	})

	router := inspectedRouter(t, inspectDeploymentResult(t, &DockerPlugin{client: client}, testDeploymentSnapshot("blue")))
	if !router.Found || router.Running || router.ServedSlot != "green" || router.ConfigSource != "file" {
		t.Fatalf("router = %+v, want stopped router that restarts serving green", router)
	}
}

func TestInspectDeploymentUsesTheStartCommandOfARouterThatNeverStarted(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	// The image's default config is on disk until the first start writes ours.
	addDeploymentContainers(engine, &fakeContainer{
		Name:  "gwdep-dep-1-router",
		Cmd:   deploymentRouterCommand(renderDeploymentNginx(testDeploymentRoutes, "green")),
		Files: map[string]string{deploymentRouterConfigPath: defaultNginxConfig},
	})

	router := inspectedRouter(t, inspectDeploymentResult(t, &DockerPlugin{client: client}, testDeploymentSnapshot("blue")))
	if router.ServedSlot != "green" || router.ConfigSource != "command" {
		t.Fatalf("router = %+v, want the slot from the start command", router)
	}
}

func TestInspectDeploymentReportsAMissingRouter(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	addDeploymentContainers(engine, nil)

	router := inspectedRouter(t, inspectDeploymentResult(t, &DockerPlugin{client: client}, testDeploymentSnapshot("blue")))
	if router.Found || router.ServedSlot != "" || router.Name != "gwdep-dep-1-router" {
		t.Fatalf("router = %+v, want a missing router", router)
	}
}

func TestInspectDeploymentReportsAnOperationInProgress(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	addDeploymentContainers(engine, &fakeContainer{
		Name:    "gwdep-dep-1-router",
		Running: true,
		Files:   map[string]string{deploymentRouterConfigPath: renderDeploymentNginx(testDeploymentRoutes, "blue")},
	})
	entered, release := blockFirstStop(engine, "gwdep-dep-1-router")
	plugin := &DockerPlugin{client: client}
	dep := testDeploymentSnapshot("blue")

	stopping := runDeploymentCommand(plugin, deploymentCommand(t, "stop", dep))
	<-entered
	// Inspect never waits for the deployment lock held by the stop.
	if detail := inspectDeploymentResult(t, plugin, dep); string(detail["operationInProgress"]) != "true" {
		close(release)
		t.Fatalf("operationInProgress = %s while a stop runs, want true", detail["operationInProgress"])
	}
	close(release)
	if result := awaitDeploymentResult(t, stopping); !result.Success {
		t.Fatalf("stop failed: %s", result.Error)
	}
	if detail := inspectDeploymentResult(t, plugin, dep); string(detail["operationInProgress"]) != "false" {
		t.Fatalf("operationInProgress = %s after the stop, want false", detail["operationInProgress"])
	}
}

func TestDeploymentRouterConfigSlot(t *testing.T) {
	twoRoutes := []deploymentRouteConfig{{HostPort: 18080, ContainerPort: 3000, IsPrimary: true}, {HostPort: 18081, ContainerPort: 3001}}
	cases := map[string]struct {
		config string
		want   string
	}{
		"current config":       {renderDeploymentNginx(twoRoutes, "green"), "green"},
		"legacy static config": {legacyDeploymentRouterCommand("blue")[2], "blue"},
		"image default":        {defaultNginxConfig, ""},
		"routes disagree": {
			renderDeploymentNginx(testDeploymentRoutes, "blue") + renderDeploymentNginx(testDeploymentRoutes, "green"),
			"",
		},
	}
	for name, tc := range cases {
		if got := deploymentRouterConfigSlot(tc.config); got != tc.want {
			t.Errorf("%s: slot = %q, want %q", name, got, tc.want)
		}
	}
}
