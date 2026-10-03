package docker

import (
	"context"
	"fmt"

	mobyclient "github.com/moby/moby/client"
)

// labelledDatabaseIDs are the managed database ids the node has containers
// of, with or without a record.
func (m *managedDatabaseManager) labelledDatabaseIDs(ctx context.Context) (map[string]bool, error) {
	ids := map[string]bool{}
	if m.client == nil {
		return ids, nil
	}
	listed, err := m.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{
		All:     true,
		Filters: mobyclient.Filters{}.Add("label", managedDatabaseLabel),
	})
	if err != nil {
		return nil, fmt.Errorf("list managed database containers: %w", err)
	}
	for _, item := range listed.Items {
		if id := item.Labels[managedDatabaseLabel]; id != "" {
			ids[id] = true
		}
	}
	return ids, nil
}
