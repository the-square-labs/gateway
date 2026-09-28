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

### Priority mode

Either mode can prefer Nodes in a fixed order: `priorityMode: true` with `nodePriority`, an ordered list of Node IDs whose first entry is the primary and the rest backups in order. It may only contain eligible Nodes (the `selectedNodeIds` with selected mode) and no duplicates; `selectedNodeIds` still decides eligibility. Serving placements go to the first available Nodes of the order; Nodes outside it come after. When a higher-priority Node returns and stays healthy for `failbackDelaySeconds` (default 300, 0 to 3600), a `failback` operation starts the workload there, switches traffic to it, and then drains and removes the backup placement, so a placement serves throughout (this needs `rolloutPolicy.maxSurge` of at least 1, or more than one replica and `maxUnavailable` of at least 1). In lease mode a failback is a handoff with a short gap instead; see Data-plane failover. A Node that goes offline or reports an error again restarts the delay, so a flapping Node does not take traffic back; after a Gateway restart every Node's delay starts again. Failback runs only while the policy is healthy and no other operation is active. `preflight` warns `AVAILABILITY_FAILBACK_NEEDS_SURGE` when the rollout policy cannot move without a gap, and then no failback runs. A failed failback leaves the backup serving and is not retried automatically for 15 minutes; `retry_operation` retries it sooner. `get` returns `priorityMode`, `nodePriority`, and `failbackDelaySeconds`; failbacks appear in `list_operations`. With `priorityMode: false` (the default) placement follows free capacity as before.

## Prerequisites

- At least two online, compatible Docker Nodes with capacity for the replicas plus temporary placements during rollout.
- **No configured or observed mounts** of any kind: named, external, read-only, or host bind. For Compose, the whole project is checked. Availability never copies local data between Nodes, so persistent state must live outside the workload, for example behind a managed database binding (`databases`).
- Images are pinned by repository and digest in the internal registry and pre-pulled on standby Nodes. Verify registry access, Relay and Secure Link paths, and dependent managed databases beforehand.

## Workflow

1. `preflight` with `resource: { type: "container" | "deployment" | "compose", nodeId, containerName? | deploymentId? | composeProjectId? }`, `mode`, and optional `desiredReplicaCount`, `nodeSelectionMode`, `selectedNodeIds`. It reports eligibility and candidate Nodes. Resolve every incompatibility (mounts, capacity, Node compatibility) before continuing.
2. `enable` with the same shape, plus optional `rolloutPolicy: { maxUnavailable, maxSurge, drainSeconds }`, `offlineReplacementGraceSeconds` (how long to wait after losing a Node's control connection before creating a replacement; about 15 seconds by default), and `partitionMode` (`strict`, the default, or `available`; see Data-plane failover).
3. Poll `get` or `get_by_resource`, and `list_operations` with `policyId`, until the requested serving count is reached.
4. Verify real traffic through the Route, database access from the placements, and application logs, not only the placement count.
5. `update` with `policyId` changes mode, replica count, Node selection, rollout policy, grace period, `partitionMode`, or priority mode (`priorityMode`, `nodePriority`, `failbackDelaySeconds`). `retry_operation` with `operationId` retries a stuck rollout.
6. `disable` needs `policyId`, the `survivingPlacementId` to keep, and `confirmation` set to the exact typed text the tool or Console shows. It is destructive; never guess the confirmation text or the surviving placement.

## Data-plane failover (lease mode)

A policy runs in lease mode when every ingress nginx Node of the workload's routes and every relay that carries it advertise `availability_lease_v2`, and enough members that can vote exist for a quorum. A policy on the backend path enters lease mode only once every candidate Node, ingress nginx Node, carrying relay and witness has run `availability_lease_v2` (with its lease watchdog and identity) for 2 minutes without a restart; until then `reason` is `participants_settling` with the Nodes or relays still settling, so a fleet in the middle of an update (Gateway first, then the Nodes one by one) never switches. In lease mode failover no longer depends on Gateway being reachable.
- **Who decides.** The Nodes and relays hold a lease per serving slot. A serving Node renews it every few seconds and stops its own copy if it cannot, so a dead or cut-off Node is replaced by the next candidate within about 45 seconds even while Gateway is down.
- **Standbys.** They are created ahead of time: the image is pulled and the container is created but not started.
- **Traffic.** It reaches only the current lease holder.
- **Voters.** Each policy has its own voters: its candidate Nodes, one per physical host, in takeover order, plus witnesses so the count is odd and at least 3 (at most 7). Only Nodes and relays that advertise `availability_lease_v2` and reported a lease identity vote. A witness is a relay or Docker Node on another host than every candidate: the one set in `witness`, else one picked automatically, which is never Gateway's local relay while another relay or Node can witness (the local relay stops with Gateway). An automatic witness stays until it can no longer vote, so round-trip jitter never changes the voters. A three-candidate policy needs no witness. One live relay is enough as long as a majority of the voters is reachable through it.

**Excluded Nodes.** A condition of one Node never changes the policy's mode. A candidate that is `offline`, whose lease watchdog is not running (`watchdog_missing`), whose daemon does not advertise `availability_lease_v2` (`daemon_outdated`), or that has not reported a lease identity yet (`identity_pending`) is listed in `lease.excludedNodes` with that reason. It gets no new standby, no failback or other handoff moves to it, and its daemon does not take a slot; the next candidate does. A Node holding a slot is never cut off by Gateway for this: a Node without a watchdog stops its own copy, and an outdated holder keeps its slot until it is updated or hands over. An outdated or unidentified Node leaves the voters and the candidate list only after the condition lasted 2 minutes, so a daemon restart or a rolling update changes nothing. Fix the Node (start the watchdog or re-run the node installer, update the daemon) and it takes part again.

**Leaving lease mode.** Only when lease mode is impossible: fewer members that can vote than a quorum (`insufficient_voters`), an ingress nginx Node or a carrying relay without `availability_lease_v2` (`ingress_not_capable`, `relays_not_capable`), no candidate that can hold while no slot is held, the license or edition, or an explicit disable or lifecycle operation. Apart from the explicit requests, the condition must last 2 minutes without a break; until then the policy stays in lease mode and `lease.reason.since` tells since when it has been impossible. The policy then passes through `closing`: Gateway publishes a closed lease, and starts nothing on the backend path until every slot's lease was released (no copy runs and every candidate saw the close) or expired (about 47 seconds after a voter majority saw the close). The last holders become the serving placements again, recorded as stopped; the backend starts them.

What Gateway still does in lease mode:
- plans moves: failback, drain, manual moves, rollouts;
- keeps two standbys provisioned;
- reconciles its records with the actual holders after it returns, within seconds of starting: the local relay reports the holder before the Nodes reconnect. An autonomous takeover appears in the audit log as `docker.availability.lease_failover`, a planned move as `docker.availability.lease_handoff`.

A planned move of a slot (failback, drain, manual move, `nodePriority` change) is a handoff: the serving Node stops its copy and releases the lease, and only then does the next Node start its own. The slot serves nothing for the old copy's stop plus the new copy's start and readiness (a container without a health check counts as ready after 3 seconds), usually 5 to 15 seconds. A `strict` policy never runs two copies of a slot, so in failover mode, which has one slot and no surge, requests fail for that time; in replicated mode the other replicas keep serving. Schedule `failbackDelaySeconds` and priority changes accordingly.

`get` returns a `lease` object:
- `mode`: `legacy`, `bootstrapping`, `lease` or `closing`;
- `reason`: why a policy is legacy (for example `participants_settling` while the fleet settles after an update), or why lease mode is impossible right now, with `since` while a lease-mode policy waits out the 2 minutes. `nodeIds` or `relayIds` name what to fix. With `watchdog_missing`, the listed Nodes have no running lease watchdog; when their daemon cannot install it (it runs without root), re-run the node installer there;
- `excludedNodes`: `[{ nodeId, reason }]` as above;
- `holders` per slot, with Node, placement and holder time;
- `voters` and `witness` (with `warning`: `witness_near_candidate`, `no_eligible_witness` or `configured_witness_unavailable`);
- `voterMargin` with `voters`, `reachable`, `required` and `margin`. It counts the voters that can vote without Gateway: Gateway's local relay does not count, and a Node counts only while it keeps a lease connection to another relay. Every Node of a lease-mode policy connects to every relay for that.

When `margin` is 0 or less, losing one more voter disables autonomous failover. A two-candidate policy with a remote relay has margin 1.

`partitionMode` controls a network split:
- `strict`, the default: never runs two copies.
- `available`: keeps serving on both sides of a split and may briefly run two copies. Never set `available` for singletons such as indexers, queue consumers or cron jobs.

## Node loss and recovery

In lease mode, see Data-plane failover. Otherwise, after a Node's control connection is lost, Gateway waits `offlineReplacementGraceSeconds` and then creates a replacement on an eligible Node. When the lost Node reconnects, Gateway heals the policy and excludes stale generations from routing; it does not fence the host or guarantee single-writer semantics outside its own routing. Never delete child Containers to force an operation forward; that desynchronizes the durable record. If the replica count is not restored, check operation phase, Node compatibility and capacity, image pull, application health, and private dependencies, in that order.

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
