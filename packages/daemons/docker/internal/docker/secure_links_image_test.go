package docker

import (
	"strings"
	"testing"
)

func TestAllowedSecureLinkConnectorImagePreservesOfficialReleaseCompatibility(t *testing.T) {
	digest := "ghcr.io/the-square-labs/gateway/secure-link-connector@sha256:" + strings.Repeat("a", 64)
	for _, image := range []string{
		developmentSecureLinkImage,
		digest,
		"ghcr.io/the-square-labs/gateway/secure-link-connector:v2.10.0-relay",
		"ghcr.io/the-square-labs/gateway/secure-link-connector:v2.10.0-rc.27-relay",
	} {
		if !allowedSecureLinkConnectorImage(image) {
			t.Fatalf("expected connector image %q to be accepted", image)
		}
	}
}

func TestAllowedSecureLinkConnectorImageRejectsMutableOrForeignTags(t *testing.T) {
	for _, image := range []string{
		"ghcr.io/the-square-labs/gateway/secure-link-connector:latest",
		"ghcr.io/other/gateway/secure-link-connector:v2.10.0-relay",
		"ghcr.io/the-square-labs/gateway/secure-link-connector:v2.10-relay",
		"registry.example.com/secure-link-connector:v2.10.0-relay",
	} {
		if allowedSecureLinkConnectorImage(image) {
			t.Fatalf("expected connector image %q to be rejected", image)
		}
	}
}
