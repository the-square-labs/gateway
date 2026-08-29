package docker

import (
	"context"
	"encoding/json"
	"fmt"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func (p *DockerPlugin) handleImageCommand(cmd *pb.DockerImageCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		data, err := p.client.ListImages(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "pull", "ensure", "ensure-local":
		imageRef := cmd.ImageRef
		if imageRef == "" {
			result.Success = false
			result.Error = "image_ref is required for " + cmd.Action
			return
		}
		if cmd.Action == "ensure" && !digestImagePattern.MatchString(imageRef) {
			result.Success = false
			result.Error = "image_ref must use an immutable sha256 digest for ensure"
			return
		}
		if cmd.Action == "ensure-local" && imageRef != developmentDatabaseConnectorImage {
			result.Success = false
			result.Error = "image_ref must use the fixed development connector image for ensure-local"
			return
		}

		registryAuth := cmd.RegistryAuthJson
		if registryAuth == "" {
			// Try to resolve from stored credentials
			p.registryMu.RLock()
			registryAuth = resolveRegistryAuth(imageRef, p.registryCreds)
			p.registryMu.RUnlock()
		}

		// "ensure" is used by the digest-pinned production connector and
		// "ensure-local" by the one fixed development image. Both avoid a
		// registry round-trip when the exact reference is already local.
		var err error
		if cmd.Action == "ensure" || cmd.Action == "ensure-local" {
			err = p.client.EnsureImage(ctx, imageRef, registryAuth)
		} else {
			err = p.client.PullImage(ctx, imageRef, registryAuth)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = imageRef

	case "remove":
		if cmd.ImageRef == "" {
			result.Success = false
			result.Error = "image_ref is required for remove"
			return
		}
		if err := p.client.RemoveImage(ctx, cmd.ImageRef, cmd.Force); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "prune":
		reclaimed, err := p.client.PruneImages(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]int64{"space_reclaimed": reclaimed})
		result.Detail = string(data)

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown image action: %s", cmd.Action)
	}
}

// handleVolumeCommand dispatches volume actions.
