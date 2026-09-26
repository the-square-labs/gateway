package docker

import (
	"reflect"
	"testing"
)

func TestDuplicateContainerLabelsDropsPlacementAndVisibilityLabels(t *testing.T) {
	source := map[string]string{
		"com.docker.compose.project":           "payments",
		"com.docker.compose.service":           "api",
		"wiolett.gateway.availability.managed": "true",
		"wiolett.gateway.deployment.managed":   "true",
		"wiolett.gateway.compose.sidecar":      "true",
		"net.wiolett.gateway.managed":          "clickhouse",
		"com.wiolett.gateway.managed-service":  "redis",
		"gateway.sandbox":                      "true",
		archiveImageReferenceLabel:             "registry.example.com/app:1",
		gatewayGPUGroupIDsLabel:                "44",
		gatewayGPUGroupIDsVersionLabel:         "1",
		"traefik.enable":                       "true",
		"com.example.team":                     "payments",
	}

	got := duplicateContainerLabels(source)

	want := map[string]string{
		archiveImageReferenceLabel:     "registry.example.com/app:1",
		gatewayGPUGroupIDsLabel:        "44",
		gatewayGPUGroupIDsVersionLabel: "1",
		"traefik.enable":               "true",
		"com.example.team":             "payments",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("duplicate labels = %#v, want %#v", got, want)
	}
	if source["com.docker.compose.project"] != "payments" {
		t.Fatalf("the source labels must not be modified")
	}
}

func TestDuplicateContainerLabelsKeepsNil(t *testing.T) {
	if got := duplicateContainerLabels(nil); got != nil {
		t.Fatalf("duplicate labels of a label-less container = %#v, want nil", got)
	}
}
