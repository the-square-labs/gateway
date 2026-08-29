export const INFRASTRUCTURE_DOCS: Record<string, string> = {
  docker: `# Docker Container Management

## Overview
Gateway provides Portainer-like Docker container management through a daemon running on Docker hosts. Docker tools still require a nodeId, while container permissions can be granted for the whole node or narrowed to one standalone container or blue/green deployment.

## Git Source Builds And Push-To-Deploy
- Git push-to-deploy, source mutation and automation, new build admission, and optional external Docker-client access to the internal registry require Business or Enterprise. The private internal registry itself remains available and operational on every plan. Let operators configure Repository mode fully, but explain that **Create and build** is the enforcement point when the current plan is below Business. After downgrade, existing source and build history remains readable and source bindings or Build Secrets may be removed, but edits, polling, webhooks, and new builds remain blocked.
- A Git source is attached directly to an existing container, blue/green deployment, or Compose Project; there is no separate application entity. Repository mode in the Docker or Compose create dialog can reserve the resource and queue its first build.
- Use \`list_docker_builds\` to inspect visible build status, exact commit, Build Worker, immutable artifact digest, and policy result.
- Use \`manage_docker_source\` with \`get\`, \`create\`, \`upsert\`, \`remove\`, \`resolve\`, \`build\`, source-secret operations, or repository discovery for containers, deployments, and Compose Projects. Use \`admission\` before promising a new build; it reports whether the internal registry and a dedicated Build Worker runtime are ready.
- Use \`manage_docker_build\` for one visible build's status, incremental logs, cancellation, or retry. Use \`find_resource({ types: ["docker_build"] })\` or \`list_docker_builds\` with node, worker, provider, branch, status, or search filters for history.
- Repository and integration IDs must come from an enabled allowlisted GitLab, GitHub, or generic Git connector. Gateway resolves the configured branch to an exact commit SHA and deduplicates ordinary builds by source binding plus commit.
- Automatic deployment never runs a mutable Git-derived tag. An approved artifact is stored in the internal registry and addressed by digest; standalone containers recreate from that digest, deployments use the existing health-checked blue/green path, and Compose waits for every service build in the parent batch before creating one digest-pinned immutable revision. Manual Compose revisions remain image-only; repository Compose files support the bounded single-node build subset of context, dockerfile, and args.
- Build admission fails closed when the registry is read-only or in maintenance, or when no online worker advertises the BuildKit execution, dedicated-runtime, and enforced-resource-profile capabilities. Image-based deployment remains available separately.
- The current Build Worker profile accepts one runc job at a time, requires a separate worker host or outer unprivileged container as its security boundary, enforces the installed CPU/RAM/disk profile, and clears BuildKit/containerd state between jobs. Internet egress is the default installer profile while metadata, private/control-plane destinations, and the Gateway gRPC endpoint are blocked; an offline profile is also available.
- Build Secrets are encrypted, source-scoped, write-only values exposed only through explicit BuildKit secret mounts. Never suggest passing secrets as build arguments or copying them into the build context.
- Internal registry operation requires no public domain and is not itself a paid module. Optional Business+ external Docker-client access is configured under Settings > Features and uses an explicit nginx node, domain, TLS certificate, and repository/action-scoped token. Entitlement loss disables the external binding, and every public registry token request rechecks Business.

## Granular Access
- Every standalone container has a Gateway-managed stable access identity; every blue/green deployment uses its stable deployment ID.
- A node-level \`docker:containers:*\` grant covers every container and deployment on that node. A child-level grant covers only the selected container or deployment.
- Child grants are enforced consistently by the UI, REST routes, WebSockets, proxy Docker upstream resolution, AI tools, and MCP tools. Lists omit inaccessible resources.
- Recreating or updating an existing container preserves its stable access identity and grants even though the Docker runtime ID changes.
- Migrating a container or deployment to another node moves its child grants to the target node during metadata cutover.
- Explicitly deleting a container or deployment removes its child grants. A later resource with the same name does not inherit them.

## Container Lifecycle
- **Create**: Deploy from image with ports, volumes, env, networks, restart policy
- **Start/Stop/Restart/Kill**: Lifecycle management (transitions tracked as tasks)
- **Recreate**: Stop + remove + create with new config (preserves name, secrets auto-injected)
- **Duplicate**: Clone a container with a new name (secrets are copied too)
- **Remove**: Delete container (must be stopped first)

Before creating a container, list images on the selected node. If the requested image is absent, pull it and wait for the pull task to complete before calling create; do not use a failed create as an image-existence probe. Public Docker Hub images are pulled directly without a saved registry or \`registryId\`.

## Recreated Containers and Stale IDs
Docker container IDs are volatile. Recreate, image update, webhook rollout, or config changes can remove the old
container and create a new one with the same semantic workload/name. If a Docker tool returns "No such container",
do not conclude the workload is deleted. Use \`find_resource\` with the last known container name, nodeId, image, or
other stable hint to locate the recreated container and continue with its new ID.

## Environment Variables & Secrets
- Regular env vars: stored in container config, visible to all users with view access
- Secrets: encrypted at rest in Gateway DB, injected as env vars on container start/recreate. Only users with docker:containers:secrets scope can view decrypted values. Secrets are keyed by container name so they survive recreates.

## Image Updates & Webhooks
- **Manual image tag change**: in container Settings, the Image Tag field allows changing the version. Changing the tag and clicking Recreate will pull the new image and recreate the container.
- **Webhook updates**: each container can have a webhook URL enabled (Settings → Webhook section). CI pipelines POST to the webhook URL to trigger automatic pull + recreate. URL format: \`POST /api/webhooks/docker/<token>\` with optional body \`{"tag":"v1.2.3"}\`. No auth header needed — the token in the URL is the auth.
- **Auto-cleanup**: webhook config supports automatic cleanup of old image versions after updates, with configurable retention count.
- Webhook configuration requires the \`docker:containers:webhooks\` scope.
- Use \`update_docker_container_image\` tool to change a container's image tag programmatically (pulls + recreates).
- Image-changing recreate pulls and fully applies the requested image on the target node before stopping the existing container. Pull failure leaves the existing container running.
- Pulls are target-node registry downloads, not direct image copies from another Docker node. A registry-backed migration may likewise reuse the registry reference instead of streaming image bytes between nodes.

## Blue/Green Deployments
- Deployments are Gateway-managed blue/green services with a stable deployment ID, active slot, inactive slot, router, routes, health checks, and release history.
- Managed deployment containers are protected. Do not start, stop, restart, kill, remove, rename, or update the underlying slot container directly.
- Use \`list_docker_deployments\` and \`get_docker_deployment\` to find the deployment ID, active slot, routes, and health.
- Use \`start_docker_deployment\`, \`stop_docker_deployment\`, \`restart_docker_deployment\`, \`kill_docker_deployment\`, \`deploy_docker_deployment\`, \`switch_docker_deployment_slot\`, \`rollback_docker_deployment\`, and \`stop_docker_deployment_slot\` for deployment-safe lifecycle operations.
- To roll out a new image or tag for a deployment, use \`deploy_docker_deployment\` instead of \`update_docker_container_image\`.

## Settings
- **Runtime (live-update)**: restart policy, memory limit, CPU shares, PID limit — applied without recreation
- **Requires recreate**: port mappings, volume mounts, entrypoint, command, stop grace period, working dir, hostname, labels, image tag
- **Stop grace period**: container-level Docker stop timeout in seconds (0-300). Stop/restart tools use this configured value when no explicit timeout is supplied, falling back to 20 seconds.

## Isolation Profiles
- **Default** uses Docker \`runc\` for standard compatibility and GPU/device support.
- **Secure** uses gVisor \`runsc\` for a stronger host-isolation boundary. It is not a virtual machine or a promise of universal Linux syscall compatibility.
- Secure can be selected only when the target node reports a healthy Secure Runtime state. Creation fails closed while setup is unknown, installing, unhealthy, or unsupported; direct the administrator to **Node Details > Secure Runtime Setup**.
- Secure Runtime needs no KVM. It supports compatible Linux amd64/arm64 hosts with a local, restartable Docker Engine. Compatible LXC guests can work when nested Docker and the required host capabilities are available; do not claim universal LXC support.
- Secure workloads cannot attach GPUs or devices, use host bind mounts, migrate between nodes, or export as \`.gwca\` archives. Changing profile recreates the workload.
- Every newly created Gateway workload in either profile is non-privileged, adds no Linux capabilities, and receives \`no-new-privileges\`.

## Images, Volumes, Networks
- Images: list, pull from registries, remove, prune unused
- Volumes: \`manage_docker_volume\` creates only a regular Gateway-managed local volume with no custom driver. Disk-image volumes require a compatible node and Personal-or-higher licensing and are currently created/resized through the Docker Volumes UI or REST API, not this Assistant tool. New or changed mounts can reference only Gateway-managed local volumes; never propose a host bind path.
- Existing legacy mounts remain unchanged during ordinary updates. A legacy volume can be adopted in the UI only when it uses the local driver, local scope, and no driver options. Orphaned unmanaged volumes are hidden.
- Networks: list, create, remove, connect/disconnect containers

## Compose Boundaries
- Community and paid plans discover existing Compose projects from canonical Docker labels and expose read-only inventory, status, monitoring, and logs. Adoption always requires a complete user-supplied single-file YAML document; Gateway never reads host Compose files or trusts label paths.
- Personal and higher can deploy and manage single-node image-only Compose Projects with immutable revisions, explicit Pull & Apply, lifecycle operations, folders, logs, masked secrets, operation history, drift reporting, ordinary non-Swarm CPU/memory/PID limits, managed database links, and Route/Secure Link targeting by project/service identity.
- Use \`manage_docker_compose\` for project list/get/validate/create/adopt/delete, revision list/get/create/delete, operation history and lifecycle starts, and masked-secret lifecycle. It is available to AI Workspace and remote MCP with the same Compose resource scopes and Personal-or-higher mutation entitlement as REST. Use \`find_resource({ types: ["docker_compose_project"] })\` when only a name is known.
- For manual YAML validation and revisions, always reject \`build\` even when an image is also present. Repository-backed Compose is the only supported build path and accepts only the bounded context/dockerfile/args subset. Also reject host bind mounts, privileged/device access, swarm/PaaS features, and direct mutations of project-owned child containers, named volumes, or non-external networks.
- Images and external/shared volumes or networks remain global. Compose-managed resources cannot use Gateway cross-node migration.
- Multi-node application clusters and multiple managed instances of one workload on one machine remain in development. Do not confuse them with current Compose Projects, cross-node migration, or blue/green deployment slots.

## Inventory Availability
- Gateway keeps sanitized container, deployment, image, volume, and network inventory snapshots. Read views can show the last synchronized state while a Docker node is offline or refreshing.
- Treat snapshot availability metadata as authoritative. Do not attempt mutations against unavailable resources; explain that the node must reconnect before Gateway can change them.

## Cross-Node Migrations
- Gateway can migrate a standalone container or a blue/green deployment to another Docker node, including referenced images, named-volume data, capacity preflight, verification, proxy cutover, cancellation, and cleanup recovery.
- Secure Runtime workloads and GPU-attached workloads are not eligible for cross-node migration in the current version.
- Migration requires \`docker:containers:migrate\` plus the source-resource permissions needed to inspect protected configuration, secrets, and mounts.
- Use \`manage_docker_migration\` to preflight first, start with the returned fingerprint, inspect progress, cancel before cutover, or retry cleanup. Never start without a blocker-free current preflight.
- Container archive export requires \`docker:containers:export\` plus file and environment access for the source container. Secret values are included only when the caller also has \`docker:containers:secrets\`. Secure Runtime workloads and containers with host bind mounts cannot be exported. Import rejects host bind mounts and accepts existing volume selections only from safe Gateway-managed local volumes.

## Registries & Templates
- Registries: add private Docker registries with encrypted credentials. Global or node-specific scope.
- Templates: save container configurations as reusable templates for quick deployment

## Tasks
Long-running operations (stop, restart, kill, recreate, update) create tasks visible on the Tasks page. Tasks track progress and completion status.

## Console & Files
- Console: interactive terminal (exec) into running containers via xterm.js WebSocket
- Assistant console command: \`execute_docker_container_console_command({ nodeId, containerId, command: ["sh","-lc","..."], user? })\` runs one command in a container when ordinary Docker tools do not cover the needed inspection or repair. It requires \`docker:containers:console\`, is destructive, is available to MCP only when that OAuth scope is explicitly granted, and blocks catastrophic patterns such as \`rm -rf /\`.
- Before using container console, resolve the current container through get_current_context or find_resource. Container IDs can change after recreate, so re-check by name when a command reports "No such container".
- File browser: navigate/read container files with \`docker:containers:files:read\`; create/edit/move/delete/upload requires \`docker:containers:files:write\`.

## Key Notes
- Most Docker tools require a nodeId parameter. If the user names a container/image/volume/network, use find_resource first; it returns nodeId with the match. Use list_nodes with type="docker" only when you specifically need to choose or inspect Docker nodes.
- Container IDs change after recreate/update — the frontend handles navigation to new IDs
- Transition states (stopping, restarting, recreating, deploying, switching, etc.) block concurrent operations on the same container or deployment`,

  databases: `# Databases

## Overview
Gateway supports two database resource models:
- **External connections** store operator-supplied connection details and are operated directly by the backend.
- **Managed instances** run curated Postgres, Redis, or ClickHouse images on a dedicated database node. They are private by default and use daemon-managed storage.

Managed database instances are not generic Docker workloads. The database node only runs Gateway-managed database containers.

## Managed Instance Access
- A managed instance has no published host port by default. Application bindings use the private connector and authenticated Gateway tunnel; do not substitute direct TCP for a binding.
- The tunnel terminates in Gateway's separate long-lived relay container. Ordinary app-only updates keep established binding traffic running; a red relay warning is a critical operator state after bounded automatic recovery fails, not a reason to publish a replacement port.
- A TCP endpoint is an independent, explicit publication option for infrastructure outside Gateway. It requires engine authentication and may not be tunnel-encrypted unless the database engine is configured with TLS. Gateway does not change host firewalls automatically.
- Each application binding gets a separate engine identity. Its URI and optional host/port/database/user/password environment values are injected into the selected application; do not reveal, log, or copy those values unless an explicit secret-reveal flow permits it.
- Assistant and MCP flows use \`manage_managed_database\` for catalog/list/get/create/update/retry/delete, restart/pause/unpause, certificate rotation, and workload binding lifecycle. Read the catalog before create, keep instances private unless the user explicitly requests publication, poll get until ready, then create a standalone-container, deployment, or Compose-service binding. One database can have separate bindings for multiple services; each binding receives a distinct engine identity. Credential reveal and credential rotation remain outside this tool; never reveal owner or binding credentials.
- The Operations Console exposes per-binding Relay runtime telemetry for linked standalone containers, including active streams, throughput, setup latency, completion health, and admission rejects. The protected REST route is \`GET /api/databases/managed/{id}/bindings/{bindingId}/runtime\` and requires view access to both the managed database and target workload. \`manage_managed_database\` does not currently expose this telemetry; do not claim that an Assistant or MCP tool can read it.

## Providers
- **Postgres**: schema/table explorer, paginated row browser, row insert/update/delete for PK-backed tables, SQL console, monitoring.
- **Redis**: key browser, type-aware viewer/editor for common types (string, hash, list, set, zset), Redis command console, monitoring.

## Credentials
- Connection credentials and managed owner credentials are encrypted at rest in the Gateway database using the same envelope-encryption primitive used for Docker secrets and PKI keys.
- Raw credentials are hidden by default. Revealing an explicitly requested credential requires the \`databases:credentials:reveal\` scope. Binding-injected credentials remain hidden by default.
- Team members can operate databases through Gateway without being given the raw hosting credentials.

## Permissions
- \`databases:view\`, \`databases:create\`, \`databases:edit\`, \`databases:delete\` govern both external connections and managed instances/bindings; no new managed-database scope is introduced.
- \`databases:query:read\`, \`databases:query:write\`, \`databases:query:admin\`; AI/MCP query tools also require \`databases:view\` on the same database.
- \`databases:credentials:reveal\`
- Most database scopes are resource-scopable by database ID, so access can be limited per saved connection.

## Monitoring
- Gateway stores short rolling metric history for database sparklines and persists health-history entries for health bars. Managed lifecycle and health notifications contain only the database ID, display name, engine, and safe status; never credentials, connection URIs, generated aliases, or daemon errors.
- Postgres metrics include latency and active connection utilization.
- Redis metrics include latency and memory utilization.

## Audit
- Connection CRUD, connection tests, credential reveals, data mutations, and console executions are audit logged.
- Query text and command text are sanitized and truncated in the audit log to avoid leaking secrets.`,

  pages: `# Pages

Pages serves immutable static Deployments owned by a Page Project. Use \`find_resource({ types: ["page_project"] })\` and \`manage_pages\` for profile, project, deployment, Tag, deploy-token, migration, pinning, retention, runtime-config, Git-source, Build Secret, and source-build operations.

## Workflow
- The Pages profile must be licensed and enabled. A Project is placed on one Pages-capable node and can be migrated with \`project_migrate\`.
- Remote MCP clients upload artifact bytes with \`upload_pages_artifact\`: call \`begin\` with the exact archive size and lowercase SHA-256, send ordered \`chunk\` calls with the returned upload ID/current offset and no more than 1 MiB decoded data per base64 chunk, then call \`finalize\`. Authentication comes from the MCP OAuth connection; never pass a token or Authorization value as a tool argument. The embedded AI Workspace does not expose this binary-transfer tool.
- On Business and Enterprise, \`manage_pages\` can list source repositories, discover package.json, attach or remove a Git source, manage source-scoped Build Secrets, and queue builds. Use \`list_docker_builds\` and \`manage_docker_build\` for the resulting Build Worker jobs, logs, cancellation, and retry.
- \`manage_pages\` operates deployment metadata, source configuration, builds, and publication, not local archive bytes. The REST resumable deploy API remains available to ordinary API clients.
- Deploy tokens can be listed, created, and revoked with \`manage_pages\`. A newly created raw token is returned once; do not repeat it in later chat messages, notifications, or logs.
- Deployments are immutable. Mutable Tags point at ready Deployments. Ingress Routes and Additional Routes target a Tag, never an immutable Deployment.
- Runtime configuration is a JSON object exposed as \`window.runtime.config\`. Save a default config or a Tag override; deleting a Tag also removes its override.
- Disabling Pages stops immutable preview publication but existing Tag routes and stored content continue to work.

Required scopes are under \`pages:*\`; profile changes require \`pages:settings:*\`. Never bypass the Pages entitlement or daemon capability checks.`,

  postgres: `# Postgres in Gateway

## Explorer
- Schemas and tables are discovered from \`information_schema\`.
- Row editing in the visual explorer requires a primary key. Tables or views without a PK are browse-only in the explorer.
- Explorer pages are paginated; use the SQL console for advanced filtering or bulk operations.

## SQL Console
- One or more SQL statements can be executed per request.
- Read, write, and admin statements are separated by permissions: \`databases:query:read\`, \`databases:query:write\`, and \`databases:query:admin\`. AI/MCP execution also requires \`databases:view\` for the target saved connection.

## Monitoring
- Health is based on connectivity and latency.
- Metrics include \`latency_ms\`, \`active_connections\`, \`max_connections\`, \`active_connections_pct\`, and \`database_size_bytes\`.`,

  redis: `# Redis in Gateway

## Explorer
- Keys are discovered with \`SCAN\`, not \`KEYS\`, so the browser can safely handle large keyspaces.
- Visual editing supports string, hash, list, set, and zset.
- Streams are browse-only in the visual explorer; use the command console for advanced stream operations.

## Command Console
- One or more Redis commands can be executed per request.
- Read, write, and admin commands are permission-gated by \`databases:query:read\`, \`databases:query:write\`, and \`databases:query:admin\`. AI/MCP execution also requires \`databases:view\` for the target saved connection.

## Monitoring
- Health is based on connectivity and latency.
- Metrics include \`latency_ms\`, \`used_memory_bytes\`, \`maxmemory_bytes\`, \`memory_pct\`, \`connected_clients\`, and \`instantaneous_ops_per_sec\`.`,

  logging: `# External Logging

Gateway can ingest structured logs from external services into ClickHouse-backed logging environments.

Before creating environments or schemas, call \`manage_logging_backend\` with \`get\`. If logging is disabled on an empty Gateway, ask whether to provision Gateway-managed local ClickHouse or use an existing external ClickHouse, then apply the chosen backend before continuing.

Per-environment retention TTL is complemented by optional Housekeeping caps for total rows and approximate disk size. ClickHouse also has an internal-log safety budget and health guard. Enable ClickHouse Internals in Housekeeping to allow cleanup of supported system tables, and only do so for an instance dedicated to Gateway. Users with housekeeping access see storage pressure on the Dashboard.

## Resource Types
Use manage_logging with singular resource names:
- Environments: { resource: "environment", operation: "list"|"get"|"create"|"update"|"delete" }
- Schemas: { resource: "schema", operation: "list"|"get"|"create"|"update"|"delete" }
- Ingest tokens: { resource: "token", operation: "list"|"create"|"delete", environmentId }
- Logs: { resource: "logs", operation: "search", environmentId, payload }
- Facets: { resource: "facets", operation: "facets", environmentId, payload }
- Metadata: { resource: "metadata", operation: "metadata", environmentId }

## Important Tool Argument Rules
- Canonical tool resources are singular: "environment", "schema", "token". Do not copy plural REST nouns like "schemas" unless you have to; use the singular canonical form.
- Create/update/search bodies go in payload, not at the top level.
- Use find_resource({ query, types: ["logging_environment"] }) or find_resource({ query, types: ["logging_schema"] }) when the user names an environment/schema and you need its ID.

## Schema Payload
\`\`\`json
{
  "resource": "schema",
  "operation": "create",
  "payload": {
    "name": "Application Logs",
    "slug": "application-logs",
    "description": "Structured application events",
    "schemaMode": "loose",
    "fieldSchema": [
      { "key": "service", "location": "label", "type": "string", "required": true },
      { "key": "durationMs", "location": "field", "type": "number", "required": false }
    ]
  }
}
\`\`\`

schemaMode:
- loose: accept unknown labels/fields
- strip: drop unknown labels/fields
- reject: reject events with unknown labels/fields

fieldSchema entries:
- key: safe key matching letters/numbers/underscore/dot/dash rules
- location: "label" or "field"
- type: labels must be "string"; fields can be "string", "number", "boolean", "datetime", or "json"
- required: whether every event must include the key

## Environment Payload
\`\`\`json
{
  "resource": "environment",
  "operation": "create",
  "payload": {
    "name": "Production",
    "slug": "production",
    "enabled": true,
    "schemaId": null,
    "schemaMode": "reject",
    "retentionDays": 30,
    "fieldSchema": []
  }
}
\`\`\`

## Searching Logs
\`\`\`json
{
  "resource": "logs",
  "operation": "search",
  "environmentId": "<logging environment UUID>",
  "payload": {
    "query": "error",
    "limit": 100,
    "services": ["gateway-backend"],
    "sources": ["codex-smoke"]
  }
}
\`\`\`

## Ingest Tokens
- Create tokens with { resource: "token", operation: "create", environmentId, payload: { name, expiresAt? } }.
- The raw token is shown only once. Do not expose it unless the user explicitly needs to configure an ingest client.`,
};
