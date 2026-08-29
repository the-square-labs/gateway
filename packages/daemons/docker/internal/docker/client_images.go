package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	imagetypes "github.com/moby/moby/api/types/image"
	"github.com/moby/moby/client"
)

func (c *Client) ListImages(ctx context.Context) (json.RawMessage, error) {
	result, err := c.cli.ImageList(ctx, client.ImageListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("image list: %w", err)
	}
	containers, err := c.cli.ContainerList(ctx, client.ContainerListOptions{All: true})
	if err == nil {
		result.Items = annotateImageUsage(result.Items, containers.Items)
	} else if c.logger != nil {
		c.logger.Warn("failed to calculate Docker image usage", "error", err)
	}
	data, err := json.Marshal(result.Items)
	if err != nil {
		return nil, fmt.Errorf("marshal images: %w", err)
	}
	return data, nil
}

func annotateImageUsage(images []imagetypes.Summary, containers []container.Summary) []imagetypes.Summary {
	for idx := range images {
		var count int64
		for _, ctr := range containers {
			if containerUsesImage(ctr, images[idx]) {
				count++
			}
		}
		images[idx].Containers = count
	}
	return images
}

func containerUsesImage(ctr container.Summary, image imagetypes.Summary) bool {
	if sameDockerImageID(ctr.ImageID, image.ID) {
		return true
	}
	for _, tag := range image.RepoTags {
		if tag != "" && tag != "<none>:<none>" && ctr.Image == tag {
			return true
		}
	}
	return false
}

func sameDockerImageID(left string, right string) bool {
	if left == "" || right == "" {
		return false
	}
	return left == right || strings.TrimPrefix(left, "sha256:") == strings.TrimPrefix(right, "sha256:")
}

// PullImage pulls an image from a registry. registryAuth is base64-encoded
// JSON credentials (may be empty for public images).
func (c *Client) PullImage(ctx context.Context, imageRef string, registryAuth string) error {
	opts := client.ImagePullOptions{}
	if registryAuth != "" {
		opts.RegistryAuth = registryAuth
	}

	resp, err := c.cli.ImagePull(ctx, imageRef, opts)
	if err != nil {
		return fmt.Errorf("image pull: %w", err)
	}
	defer resp.Close()

	// Docker streams JSON progress; errors are embedded in the stream.
	// Read and check each message for error fields.
	decoder := json.NewDecoder(resp)
	var lastErr string
	for {
		var msg struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
		}
		if err := decoder.Decode(&msg); err != nil {
			break // EOF or parse error — done reading
		}
		if msg.Error != "" {
			lastErr = msg.Error
		}
	}
	if lastErr != "" {
		return fmt.Errorf("image pull: %s", lastErr)
	}
	return nil
}

// EnsureImage keeps an already-present exact image reference available without
// contacting a registry. Callers that require immutable image references can
// use this for local/offline nodes while retaining digest pinning themselves.
func (c *Client) EnsureImage(ctx context.Context, imageRef string, registryAuth string) error {
	if _, err := c.cli.ImageInspect(ctx, imageRef); err == nil {
		return nil
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("inspect image: %w", err)
	}
	return c.PullImage(ctx, imageRef, registryAuth)
}

// RemoveImage removes an image by ID or reference.
func (c *Client) RemoveImage(ctx context.Context, id string, force bool) error {
	_, err := c.cli.ImageRemove(ctx, id, client.ImageRemoveOptions{
		Force:         force,
		PruneChildren: true,
	})
	if err != nil {
		return fmt.Errorf("image remove: %w", err)
	}
	return nil
}

// PruneImages removes unused images and returns bytes reclaimed.
func (c *Client) PruneImages(ctx context.Context) (int64, error) {
	result, err := c.cli.ImagePrune(ctx, client.ImagePruneOptions{})
	if err != nil {
		return 0, fmt.Errorf("image prune: %w", err)
	}
	return int64(result.Report.SpaceReclaimed), nil
}

// ── Volume Operations ─────────────────────────────────────────────
