package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/authconfig"
	"github.com/moby/moby/api/types/container"
	imagetypes "github.com/moby/moby/api/types/image"
	registrytypes "github.com/moby/moby/api/types/registry"
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

	// Some Engine/API combinations fail to resolve an existing tagged image
	// through /images/{name}/json even though it is present in the local image
	// store. Use the Engine's reference filter as a compatibility fallback, but
	// require an exact RepoTag/RepoDigest match before skipping the pull.
	listed, err := c.cli.ImageList(ctx, client.ImageListOptions{
		All:     true,
		Filters: make(client.Filters).Add("reference", imageRef),
	})
	if err != nil {
		return fmt.Errorf("list local images after inspect miss: %w", err)
	}
	for _, image := range listed.Items {
		if containsExactImageReference(image.RepoTags, imageRef) ||
			containsExactImageReference(image.RepoDigests, imageRef) {
			return nil
		}
	}
	return c.PullImage(ctx, imageRef, registryAuth)
}

func containsExactImageReference(references []string, expected string) bool {
	for _, reference := range references {
		if reference == expected {
			return true
		}
	}
	return false
}

type MirroredImage struct {
	Reference     string `json:"reference"`
	Repository    string `json:"repository"`
	Digest        string `json:"digest"`
	Platform      string `json:"platform"`
	SizeBytes     int64  `json:"sizeBytes"`
	SourceImageID string `json:"sourceImageId"`
}

func (c *Client) TagImage(ctx context.Context, sourceRef, targetRef string) error {
	source, err := c.cli.ImageInspect(ctx, sourceRef)
	if err != nil {
		return fmt.Errorf("inspect source image for tag: %w", err)
	}
	if _, err := c.cli.ImageTag(ctx, client.ImageTagOptions{Source: source.ID, Target: targetRef}); err != nil {
		return fmt.Errorf("tag image: %w", err)
	}
	return nil
}

// MirrorImage pulls an arbitrary source image, tags it into the node-local
// outbound-only internal-registry proxy, pushes it, and returns the immutable
// repository digest that every Availability placement must consume.
func (c *Client) MirrorImage(ctx context.Context, sourceRef, targetRef, sourceRegistryAuth string) (MirroredImage, error) {
	source, inspectErr := c.cli.ImageInspect(ctx, sourceRef)
	if inspectErr != nil {
		if err := c.PullImage(ctx, sourceRef, sourceRegistryAuth); err != nil {
			return MirroredImage{}, err
		}
		source, inspectErr = c.cli.ImageInspect(ctx, sourceRef)
	}
	if inspectErr != nil {
		return MirroredImage{}, fmt.Errorf("inspect mirrored source image: %w", inspectErr)
	}
	if _, err := c.cli.ImageTag(ctx, client.ImageTagOptions{Source: source.ID, Target: targetRef}); err != nil {
		return MirroredImage{}, fmt.Errorf("tag mirrored image: %w", err)
	}
	// Docker Engine expects X-Registry-Auth even for an unauthenticated
	// registry on some daemon/API combinations. An encoded empty AuthConfig is
	// the canonical anonymous value and avoids the legacy EOF fallback path.
	pushRegistryAuth, err := authconfig.Encode(registrytypes.AuthConfig{})
	if err != nil {
		return MirroredImage{}, fmt.Errorf("encode mirrored image registry auth: %w", err)
	}
	push, err := c.cli.ImagePush(ctx, targetRef, client.ImagePushOptions{RegistryAuth: pushRegistryAuth})
	if err != nil {
		return MirroredImage{}, fmt.Errorf("push mirrored image: %w", err)
	}
	defer push.Close()
	if err := push.Wait(ctx); err != nil {
		return MirroredImage{}, fmt.Errorf("wait for mirrored image push: %w", err)
	}
	inspected, err := c.cli.ImageInspect(ctx, targetRef)
	if err != nil {
		return MirroredImage{}, fmt.Errorf("inspect mirrored target image: %w", err)
	}
	repository := imageRepository(targetRef)
	digest := ""
	for _, reference := range inspected.RepoDigests {
		if strings.HasPrefix(reference, repository+"@sha256:") {
			digest = strings.TrimPrefix(reference, repository+"@")
			break
		}
	}
	if digest == "" {
		return MirroredImage{}, errors.New("internal registry did not return an immutable image digest")
	}
	platform := strings.Trim(strings.Join([]string{inspected.Os, inspected.Architecture}, "/"), "/")
	return MirroredImage{
		Reference:     repository + "@" + digest,
		Repository:    strings.TrimPrefix(repository, "127.0.0.1:5443/"),
		Digest:        digest,
		Platform:      platform,
		SizeBytes:     inspected.Size,
		SourceImageID: source.ID,
	}, nil
}

func imageRepository(reference string) string {
	withoutDigest := strings.SplitN(reference, "@", 2)[0]
	lastSlash := strings.LastIndex(withoutDigest, "/")
	if colon := strings.LastIndex(withoutDigest, ":"); colon > lastSlash {
		return withoutDigest[:colon]
	}
	return withoutDigest
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
