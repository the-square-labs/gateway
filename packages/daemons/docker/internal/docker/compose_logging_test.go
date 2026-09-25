package docker

import (
	"context"
	"strings"
	"sync"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestComposeServiceLoggingValidation(t *testing.T) {
	accepted := []string{
		"logging:\n      driver: json-file\n      options:\n        max-size: 200m\n        max-file: \"5\"\n",
		"logging:\n      driver: local\n      options:\n        max-size: 1g\n        compress: \"true\"\n",
		"logging:\n      options:\n        max-size: 10m\n",
		"logging:\n      driver: none\n",
		"logging:\n      driver: json-file\n",
		"logging:\n      options:\n        max-file: 3\n        compress: True\n",
	}
	for _, logging := range accepted {
		command := validComposeCommand("apply", "operation-1")
		command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    " + logging)
		if _, err := validateComposeCommand(command); err != nil {
			t.Errorf("logging rejected:\n%s\nerror: %v", logging, err)
		}
	}

	rejected := map[string]string{
		"logging:\n      driver: syslog\n":                                      "driver",
		"logging:\n      driver: json-file\n      options:\n        tag: web\n": "tag",
		"logging:\n      driver: none\n      options:\n        max-size: 1m\n":  "none",
		"logging:\n      options:\n        max-size: lots\n":                    "max-size",
		"logging:\n      options:\n        max-file: \"0\"\n":                   "max-file",
		"logging:\n      options:\n        compress: yes-please\n":              "compress",
		"logging:\n      driver: json-file\n      labels: web\n":                "labels",
		"logging: json-file\n":                                                  "mapping",
	}
	for logging, want := range rejected {
		command := validComposeCommand("apply", "operation-1")
		command.ComposeYaml = []byte("services:\n  web:\n    image: nginx:alpine\n    " + logging)
		if _, err := validateComposeCommand(command); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("logging accepted or wrong error for:\n%s\nerror: %v (want %q)", logging, err, want)
		}
	}
}

func TestInjectComposeLogLimitsKeepsServiceChoices(t *testing.T) {
	output, err := injectComposeLogLimits([]byte(`services:
  web:
    image: nginx:alpine
  worker:
    image: busybox
    logging:
      driver: local
`))
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Services map[string]struct {
			Logging *struct {
				Driver  string            `yaml:"driver"`
				Options map[string]string `yaml:"options"`
			} `yaml:"logging"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(output, &document); err != nil {
		t.Fatal(err)
	}
	web := document.Services["web"].Logging
	if web == nil || web.Driver != "json-file" || web.Options["max-size"] != "50m" || web.Options["max-file"] != "3" {
		t.Fatalf("web logging = %+v", web)
	}
	worker := document.Services["worker"].Logging
	if worker == nil || worker.Driver != "local" || len(worker.Options) != 0 {
		t.Fatalf("worker logging changed: %+v", worker)
	}
}

type recordingComposeSidecar struct {
	mu   sync.Mutex
	yaml []string
}

func (r *recordingComposeSidecar) run(_ context.Context, request composeRequest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.yaml = append(r.yaml, string(request.composeYAML))
	return nil
}

func (r *recordingComposeSidecar) cancelAll() {}

func TestComposeExecutorAddsLogLimitsOnlyForJSONFileHosts(t *testing.T) {
	for _, jsonFileHost := range []bool{true, false} {
		sidecar := &recordingComposeSidecar{}
		executor := newTestComposeExecutor(sidecar)
		executor.logLimits = func() bool { return jsonFileHost }
		if _, err := executor.handle(validComposeCommand("apply", "operation-1")); err != nil {
			t.Fatal(err)
		}
		staged := sidecar.yaml[0]
		if got := strings.Contains(staged, "max-size: 50m"); got != jsonFileHost {
			t.Fatalf("json-file host %v: staged compose has log limits = %v:\n%s", jsonFileHost, got, staged)
		}
		if !strings.Contains(staged, "wiolett.gateway.compose.managed") {
			t.Fatalf("staged compose lost the Gateway labels:\n%s", staged)
		}
	}
}
