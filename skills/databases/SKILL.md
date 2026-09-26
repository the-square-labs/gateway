---
name: databases
description: Provision and operate managed PostgreSQL, Redis, and ClickHouse on Gateway, bind them privately to Containers, Deployments, or Compose services, register external database connections, run SQL or Redis queries, and manage native backups and restores. Use when asked to create a database, give an application private database access, run a query, rotate database credentials or certificates, or set up and verify backups. Use after using-gateway has confirmed the Gateway MCP connection.
---

# Databases

Gateway has two database models. Keep them apart:

- **External connections**: an existing database Gateway should operate or observe over operator-supplied connection details. Register one only when Gateway should query, monitor, or back it up.
- **Managed instances**: curated PostgreSQL, Redis, or ClickHouse that Gateway runs on a `storage` Node (or a legacy `databases` Node). They are private by default, reached through an authenticated relay tunnel, with daemon-managed storage.

Start with `using-gateway` for connection, discovery, and safety rules. Read `read_gateway_documentation({ topic: "databases" })` (also `postgres`, `redis`, `clickhouse`) before an unfamiliar workflow.

## Give an application a database

Before provisioning, check engine availability, placement, capacity, entitlement, active Tasks, backup and recovery expectations, and existing databases with the same purpose.

1. `manage_managed_database({ operation: "catalog" })` for engines and versions.
2. `{ operation: "create", type: "postgres" | "redis" | "clickhouse", version, nodeId, storageSizeGb, cpuCores?, memoryMb?, ... }` on an online compatible Node. Keep `publishTcp` and `publishNativeTcp` false unless the user explicitly needs TCP access from outside Gateway.
3. Poll `{ operation: "get", databaseId }` until the instance is ready.
4. Resolve the workload through its owning Container, Deployment, or Compose Project, then `{ operation: "create_binding", databaseId, targetType: "container" | "deployment" | "compose_service", targetNodeId, targetResourceId, environment }`. `environment` maps the values to deliver (`connectionUri`, `host`, `port`, `database`, `username`, `password`) to environment variable names; at least one is required.
5. Verify the binding and an application-level connection (below).

Each binding gets its own engine identity, never the owner account: a login role for PostgreSQL, a role-scoped user for ClickHouse, an ACL user with dangerous and admin commands denied for Redis. One database with one binding per workload is the intended pattern. Never copy owner credentials into environment variables as a shortcut. If the workload is recreated, confirm the binding is still attached through the owning resource.

## Lifecycle is not one operation

Provisioning, `restart`, `pause`, `unpause`, `retry`, `update`, credential rotation, certificate rotation, and `delete` are distinct operations; follow each returned Task and the reported state. `delete_binding` revokes one application's access; `delete` removes the managed database and its storage. A request to disconnect, redeploy, or remove an application never authorizes deleting its database. Delete bindings before deleting a database or workload when possible.

- `list_bindings`, `get_binding_runtime` (relay telemetry: throughput, admission rejects), and `logs` (`tailLines`) help diagnosis.
- `certificate_status` reads certificate state; `rotate_certificate` reloads in place and needs `allowRestart: true` when the engine cannot hot-reload.

## Credentials

Credential tools run only on the user's explicit request and are refused during impersonation: `reveal_credentials` and `rotate_credentials` (the direct-access principal of a published instance; `databases:credentials:reveal`, rotation also `databases:edit`) and `reveal_binding_credentials` (also needs the workload's binding scopes). Gateway never returns the internal owner account. Never log a revealed value, repeat it, or copy it into a Compose file, image layer, repository, or Pages runtime configuration.

## Queries and backups

SQL and Redis tools, query scopes, backup policies, runs, and restores: [Queries and backups](references/queries-and-backups.md). A restore is a manual-approval operation that runs only when the user explicitly asks for one.

## Verify

Report the last verified boundary; a healthy database does not prove the application can use it.

1. The database is provisioned and healthy.
2. The binding identity is created and ready.
3. The workload received the binding's variable names (report names, never values).
4. The application connected and performed its expected operation. For isolation, an ordinary query succeeds while an admin operation such as creating a role fails.

## Pitfalls

- A managed instance has no published port by default. Never propose direct TCP as a substitute for a binding; publishing is a separate opt-in whose authentication and TLS Gateway does not manage for the client.
- A red relay warning after bounded automatic recovery fails is a critical operator state, not a reason to publish a replacement port.
- `restore` refuses a non-empty target on purpose; never force it onto an existing database.

Further reading: [Databases overview](https://docs.goodgateway.dev/en/databases/overview/), [Bindings](https://docs.goodgateway.dev/en/databases/bindings/), [Private database journey](https://docs.goodgateway.dev/en/journeys/private-database/).
