package docker

import (
	"context"
	"encoding/json"
	"fmt"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"strings"
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

	case "pull", "ensure":
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
		registryAuth := cmd.RegistryAuthJson
		if registryAuth == "" {
			// Try to resolve from stored credentials
			p.registryMu.RLock()
			registryAuth = resolveRegistryAuth(imageRef, p.registryCreds)
			p.registryMu.RUnlock()
		}

		// "ensure" avoids a registry round-trip when the exact immutable
		// reference is already local.
		var err error
		if cmd.Action == "ensure" {
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

	case "mirror":
		if cmd.ImageRef == "" || cmd.TargetImageRef == "" {
			result.Success = false
			result.Error = "image_ref and target_image_ref are required for mirror"
			return
		}
		if !strings.HasPrefix(cmd.TargetImageRef, "127.0.0.1:5443/") {
			result.Success = false
			result.Error = "target_image_ref must use the internal registry proxy"
			return
		}
		p.registryMu.RLock()
		sourceRegistryAuth := resolveRegistryAuth(cmd.ImageRef, p.registryCreds)
		p.registryMu.RUnlock()
		mirrored, err := p.client.MirrorImage(ctx, cmd.ImageRef, cmd.TargetImageRef, sourceRegistryAuth)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, err := json.Marshal(mirrored)
		if err != nil {
			result.Success = false
			result.Error = "marshal mirrored image metadata: " + err.Error()
			return
		}
		result.Detail = string(data)

	case "tag":
		if cmd.ImageRef == "" || cmd.TargetImageRef == "" {
			result.Success = false
			result.Error = "image_ref and target_image_ref are required for tag"
			return
		}
		if err := p.client.TagImage(ctx, cmd.ImageRef, cmd.TargetImageRef); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = cmd.TargetImageRef

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
