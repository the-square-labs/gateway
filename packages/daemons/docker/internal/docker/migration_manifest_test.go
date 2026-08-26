package docker

import (
	"strings"
	"testing"

	"github.com/moby/moby/api/types/container"
)

func TestApplyMigrationCreateImageUsesVerifiedImageID(t *testing.T) {
	imageID := "sha256:" + strings.Repeat("a", 64)
	original := "127.0.0.1:5443/gateway/builds/source@sha256:" + strings.Repeat("b", 64)
	config := &container.Config{Image: original}

	if err := applyMigrationCreateImage(config, dockerMigrationManifest{
		ImageID: imageID, ImageReference: original,
	}); err != nil {
		t.Fatal(err)
	}
	if config.Image != imageID {
		t.Fatalf("create image = %q, want verified ID %q", config.Image, imageID)
	}
	if config.Labels[archiveImageReferenceLabel] != original {
		t.Fatalf("preserved image reference = %q, want %q", config.Labels[archiveImageReferenceLabel], original)
	}
}

func TestApplyMigrationCreateImageRejectsUnverifiedImageID(t *testing.T) {
	if err := applyMigrationCreateImage(&container.Config{}, dockerMigrationManifest{ImageID: "latest"}); err == nil {
		t.Fatal("expected invalid image ID to be rejected")
	}
}
