---
name: high-availability
description: Preflight, enable, and operate Gateway Docker Workload Availability, which places a Container, blue/green Deployment, or whole Compose Project on several independent Docker Nodes in replicated or failover mode. Use when asked to make a workload highly available, add replicas, set up failover, check an availability policy, or recover after losing a Node. Business and Enterprise only. Use after using-gateway, and after deploying-workloads for the underlying workload.
---

# High Availability

Docker Workload Availability adds multi-node placements to an existing standalone Container, blue/green Deployment, or whole Compose Project. It creates no new resource type: a policy attaches to the workload and from then on owns placement count, generations, routing membership, and cleanup. It is a Business and Enterprise feature in Tech Preview; the Console asks for explicit confirmation on first enablement.

Start with `using-gateway` for connection, discovery, and safety rules, and `deploying-workloads` for the workload itself. One tool covers the lifecycle: `manage_docker_availability({ operation, ... })`, gated by `docker:availability:manage` (folder grants resolve through the workload's folder; the scope also implies `docker:containers:view`).

## Modes

| Mode | Behavior |
| --- | --- |
| `replicated` | 2 to 32 serving placements, at most one per Node (`desiredReplicaCount`) |
| `failover` | Exactly one serving placement; after a loss, a replacement starts on another eligible Node |

Replica count is manual. There is no metric autoscaling and never more than one placement of a workload per Node.

## Prerequisites

- At least two online, compatible Docker Nodes with capacity for the replicas plus temporary placements during rollout.
- **No configured or observed mounts** of any kind: named, external, read-only, or host bind. For Compose, the whole project is checked. Availability never copies local data between Nodes, so persistent state must live outside the workload, for example behind a managed database binding (`databases`).
- Images are pinned by repository and digest in the internal registry and pre-pulled on standby Nodes. Verify registry access, Relay and Secure Link paths, and dependent managed databases beforehand.

## Workflow

1. `preflight` with `resource: { type: "container" | "deployment" | "compose", nodeId, containerName? | deploymentId? | composeProjectId? }`, `mode`, and optional `desiredReplicaCount`, `nodeSelectionMode`, `selectedNodeIds`. It reports eligibility and candidate Nodes. Resolve every incompatibility (mounts, capacity, Node compatibility) before continuing.
2. `enable` with the same shape, plus optional `rolloutPolicy: { maxUnavailable, maxSurge, drainSeconds }` and `offlineReplacementGraceSeconds` (how long to wait after losing a Node's control connection before creating a replacement; about 15 seconds by default).
3. Poll `get` or `get_by_resource`, and `list_operations` with `policyId`, until the requested serving count is reached.
4. Verify real traffic through the Route, database access from the placements, and application logs, not only the placement count.
5. `update` with `policyId` changes mode, replica count, Node selection, rollout policy, or grace period. `retry_operation` with `operationId` retries a stuck rollout.
6. `disable` needs `policyId`, the `survivingPlacementId` to keep, and `confirmation` set to the exact typed text the tool or Console shows. It is destructive; never guess the confirmation text or the surviving placement.

## Node loss and recovery

After a Node's control connection is lost, Gateway waits `offlineReplacementGraceSeconds` and then creates a replacement on an eligible Node. When the lost Node reconnects, Gateway heals the policy and excludes stale generations from routing; it does not fence the host or guarantee single-writer semantics outside its own routing. Never delete child Containers to force an operation forward; that desynchronizes the durable record. If the replica count is not restored, check operation phase, Node compatibility and capacity, image pull, application health, and private dependencies, in that order.

A rolling update that fails repeatedly (3 attempts or 15 minutes) rolls back automatically; updated replicas return to the previous image and settings.

## Routing and bindings

Routes, Additional Routes, and Advanced Secure Links target the logical workload. Gateway projects healthy placement endpoints and balances new connections by least connections; existing connections do not move. Managed database bindings get per-placement connections tied to the logical resource. Use the placement selector in logs, console, and monitoring to diagnose one instance.

## Verify

After `enable`, `get` shows the desired serving count with every placement healthy, a Route request succeeds, and database traffic (when bound) arrives from more than one placement. After a real or simulated Node loss, a replacement appeared within the grace window and routing excluded the stale placement.

## Pitfalls

- Availability protects the workload, not Gateway itself, nginx, the database engine, registry storage, or shared volumes. Check each dependency's own resilience.
- Any mount, even a read-only one, fails eligibility. There is no partial mode that skips volume checks.
- Compose Availability replicates the whole project per placement; it does not spread individual services across Nodes.

Further reading: [Availability](https://docs.goodgateway.dev/en/docker/availability/), [Compatibility and limits](https://docs.goodgateway.dev/en/operations/availability-compatibility-limits/).
