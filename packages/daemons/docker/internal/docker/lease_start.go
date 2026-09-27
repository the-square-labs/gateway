package docker

import (
	"context"
	"errors"
	"fmt"
	"time"

	mobyclient "github.com/moby/moby/client"
)

// The start hook moves the lease gate from command dispatch to the moment a
// container starts (A5, A12.1): a backend command may wait on a deployment
// lock or an image pull long after dispatch, and the lease can be gone by
// then. Every start site of a user workload calls Client.gateStart.

type leaseContainerRef struct {
	ID       string
	PolicyID string
}

// leaseContainerRef resolves a container id or name to its availability
// policy: the availability label, else the Compose project of a lease
// placement (Compose files carry no availability labels).
func (p *DockerPlugin) leaseContainerRef(ctx context.Context, idOrName string) (leaseContainerRef, error) {
	if p.client == nil {
		return leaseContainerRef{}, errors.New("docker client is unavailable")
	}
	result, err := p.client.cli.ContainerInspect(ctx, idOrName, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return leaseContainerRef{}, fmt.Errorf("inspect container for the availability lease gate: %w", err)
	}
	ref := leaseContainerRef{ID: result.Container.ID}
	if result.Container.Config == nil {
		return ref, nil
	}
	labels := result.Container.Config.Labels
	ref.PolicyID = labels[availabilityPolicyLabel]
	if ref.PolicyID == "" && labels[composeProjectLabel] != "" {
		if placement, ok := p.availability.leaseComposeProjects()[labels[composeProjectLabel]]; ok {
			ref.PolicyID = placement.PolicyID
		}
	}
	return ref, nil
}

// beforeStart is the Client start hook. It fails closed: a container whose
// policy cannot be resolved does not start on a lease-capable daemon.
func (l *leaseIntegration) beforeStart(ctx context.Context, idOrName string) error {
	ref, err := l.plugin.leaseContainerRef(ctx, idOrName)
	if err != nil {
		return err
	}
	if ref.PolicyID == "" {
		return nil
	}
	if err := l.runtime.BeforeStart(ref.ID, ref.PolicyID, ""); err != nil {
		return fmt.Errorf("start refused for availability policy %s: %w", ref.PolicyID, err)
	}
	return nil
}

// gateStart runs the start hook when one is installed.
func (c *Client) gateStart(ctx context.Context, idOrName string) error {
	if c.beforeStart == nil {
		return nil
	}
	return c.beforeStart(ctx, idOrName)
}

// composeLeaseMode reports whether a Compose project belongs to a lease-mode
// placement on this node.
func (p *DockerPlugin) composeLeaseMode(projectID string) bool {
	if p.lease == nil || p.lease.runtime == nil {
		return false
	}
	for _, policyID := range p.availability.policiesForResource("compose", projectID) {
		if p.lease.runtime.LeaseMode(policyID) {
			return true
		}
	}
	return false
}

// startComposeProject starts a lease-mode project's containers through the
// Engine API, one by one through the start hook: docker compose itself runs
// in the sidecar with --no-start and never starts them (A12.1).
func (p *DockerPlugin) startComposeProject(projectName string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	filters := make(mobyclient.Filters).Add("label", composeProjectLabel+"="+projectName)
	listed, err := p.client.cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true, Filters: filters})
	if err != nil {
		return fmt.Errorf("list compose project containers: %w", err)
	}
	for _, item := range listed.Items {
		if string(item.State) == "running" {
			continue
		}
		if err := p.client.StartContainer(ctx, item.ID); err != nil {
			return err
		}
	}
	return nil
}
