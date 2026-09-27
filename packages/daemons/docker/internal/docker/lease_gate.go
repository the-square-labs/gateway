package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// leaseGate refuses backend start and serve commands for placements of a
// lease-mode policy unless this node holds the lease (A5). It runs before
// the existing generation fencing, which stays in force (D12).
func (p *DockerPlugin) leaseGate(cmd *pb.GatewayCommand) error {
	if p.lease == nil || p.lease.runtime == nil {
		return nil
	}
	for _, policyID := range p.leaseGatedPolicies(cmd) {
		if err := p.lease.runtime.CheckServe(policyID); err != nil {
			return fmt.Errorf("refused for availability policy %s: %w", policyID, err)
		}
	}
	switch payload := cmd.Payload.(type) {
	case *pb.GatewayCommand_DockerContainer:
		if payload.DockerContainer.GetAction() == "live_update" {
			return p.leaseLiveUpdateGate(payload.DockerContainer)
		}
	case *pb.GatewayCommand_DockerAvailability:
		return p.leaseStandbyPrepareGate(payload.DockerAvailability)
	}
	return nil
}

// leaseStandbyPrepareGate keeps a standby prepare (T6 §3.1) off the node that
// holds the policy's lease: its running copy is the serving one, and it is
// re-prepared only after a handoff moved the lease away.
func (p *DockerPlugin) leaseStandbyPrepareGate(cmd *pb.DockerAvailabilityCommand) error {
	if cmd.GetAction() != availabilityActionPrepare {
		return nil
	}
	var config struct {
		Phase string `json:"phase"`
	}
	if json.Unmarshal([]byte(cmd.GetConfigJson()), &config) != nil || config.Phase != "standby" {
		return nil
	}
	if p.lease.runtime.Holds(cmd.GetPolicyId()) {
		return fmt.Errorf("availability policy %s: this node holds the lease; a standby is prepared only on another candidate", cmd.GetPolicyId())
	}
	return nil
}

// leaseGatedPolicies lists the availability policies a command would start
// or serve, for the actions that can start a workload.
func (p *DockerPlugin) leaseGatedPolicies(cmd *pb.GatewayCommand) []string {
	switch payload := cmd.Payload.(type) {
	case *pb.GatewayCommand_DockerAvailability:
		switch payload.DockerAvailability.GetAction() {
		case availabilityActionActivate, availabilityActionAdoptSingle:
			return []string{payload.DockerAvailability.GetPolicyId()}
		}
	case *pb.GatewayCommand_DockerContainer:
		switch payload.DockerContainer.GetAction() {
		case "start", "restart", "recreate", "update", "duplicate":
			if policyID := p.containerPolicy(payload.DockerContainer.GetContainerId()); policyID != "" {
				return []string{policyID}
			}
		}
	case *pb.GatewayCommand_DockerDeployment:
		switch payload.DockerDeployment.GetAction() {
		case "create", "deploy_slot", "switch", "start", "restart":
			policies := p.availability.policiesForResource("deployment", payload.DockerDeployment.GetDeploymentId())
			return appendLabelPolicy(policies, payload.DockerDeployment.GetConfigJson())
		}
	case *pb.GatewayCommand_DockerCompose:
		switch payload.DockerCompose.GetAction() {
		case "apply", "pull_apply", "start", "restart":
			return p.availability.policiesForResource("compose", payload.DockerCompose.GetProjectId())
		}
	}
	return nil
}

func (p *DockerPlugin) containerPolicy(containerID string) string {
	if containerID == "" || p.client == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	data, err := p.client.InspectContainer(ctx, containerID)
	if err != nil {
		return ""
	}
	var inspect struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if json.Unmarshal(data, &inspect) != nil {
		return ""
	}
	return inspect.Config.Labels[availabilityPolicyLabel]
}

// appendLabelPolicy adds the policy named by a deployment payload's desired
// labels, which covers a deployment created before its placement persisted.
func appendLabelPolicy(policies []string, configJSON string) []string {
	var payload struct {
		DesiredConfig struct {
			Labels map[string]string `json:"labels"`
		} `json:"desiredConfig"`
		Labels map[string]string `json:"labels"`
	}
	if configJSON == "" || json.Unmarshal([]byte(configJSON), &payload) != nil {
		return policies
	}
	for _, labels := range []map[string]string{payload.DesiredConfig.Labels, payload.Labels} {
		if policyID := labels[availabilityPolicyLabel]; policyID != "" {
			policies = append(policies, policyID)
		}
	}
	return policies
}

// leaseLiveUpdateGate keeps RestartPolicy "no" on lease-mode containers
// (A2.1): Docker must never restart them on its own.
func (p *DockerPlugin) leaseLiveUpdateGate(cmd *pb.DockerContainerCommand) error {
	var params struct {
		RestartPolicy *string `json:"restartPolicy"`
	}
	if json.Unmarshal([]byte(cmd.GetConfigJson()), &params) != nil || params.RestartPolicy == nil || *params.RestartPolicy == "no" {
		return nil
	}
	if policyID := p.containerPolicy(cmd.GetContainerId()); policyID != "" && p.lease.runtime.LeaseMode(policyID) {
		return fmt.Errorf("availability policy %s runs in lease mode: its containers keep restart policy no", policyID)
	}
	return nil
}

// leaseCreateConfig forces RestartPolicy "no" on a container created for a
// lease-mode policy, standbys included (A2.1).
func (p *DockerPlugin) leaseCreateConfig(configJSON string) string {
	if p.lease == nil || p.lease.runtime == nil {
		return configJSON
	}
	decoder := json.NewDecoder(strings.NewReader(configJSON))
	decoder.UseNumber()
	var config map[string]any
	if decoder.Decode(&config) != nil {
		return configJSON
	}
	labels, _ := config["labels"].(map[string]any)
	policyID, _ := labels[availabilityPolicyLabel].(string)
	if policyID == "" || !p.lease.runtime.LeaseMode(policyID) {
		return configJSON
	}
	delete(config, "restart_policy")
	config["restartPolicy"] = "no"
	rewritten, err := json.Marshal(config)
	if err != nil {
		return configJSON
	}
	return string(rewritten)
}
