---
{
  "id": "lct3cijz",
  "file_name": "lct3cijz_gateway_availability_decision",
  "tags": [
    "availability",
    "compose",
    "docker",
    "gateway",
    "ha",
    "internal-registry",
    "secure-link"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1788310918318,
  "updated_at": 1788310918318
}
---
Gateway Multi-node Availability is intentionally not based on Docker Swarm because Swarm's manager/gossip/VXLAN and node-to-node connectivity conflict with Gateway's outbound-only isolated-node security positioning. The accepted product contract is one Business/Enterprise Availability feature for existing Containers, managed Deployments, and whole Compose Projects in the same release. Modes are fixed-count replicated and one-serving failover over an eligible node allowlist/all-compatible set, with at most one placement per node, no metric autoscaling, and all mounts forbidden. Gateway owns durable policies, placements, operations, generation fencing, healing, and stale reconnect cleanup through existing authenticated daemon channels. Images use immutable internal-registry digests with active and deterministic standby pre-pull/pins. Existing managed database bindings are logical and project placement-local connector/Secure Link state before readiness. One user-visible Route/Proxy Host/Secure Link projects hidden healthy placement endpoints over the existing Relay Pool. Workload HA is in scope; Nginx, Gateway control-plane, registry-storage HA, shared storage, and node-to-node networking are not. Durable plan: .workflow/plans/09-02-26-multi-node-workload-availability.
