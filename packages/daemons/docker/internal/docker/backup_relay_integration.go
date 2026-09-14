package docker

import "context"

func init() {
	OpenBackupRelayRouteForBackup = func(ctx context.Context, plugin *DockerPlugin, ownerKind, runID string) (string, func(), error) {
		route, err := plugin.OpenBackupRelayRoute(ctx, ownerKind, runID)
		if err != nil {
			return "", nil, err
		}
		return route.Address, func() { route.Close() }, nil
	}
}
