# Storage nodes, external storage and database backups

Storage nodes use the existing Docker daemon with `docker.mode: storage`. They can provision managed PostgreSQL, Redis, ClickHouse and MinIO, and execute native backup jobs. Generic application containers and builds remain on Docker and Build nodes. Existing `databases` nodes retain their configuration and database data; upgrading a daemon does not move its data directory.

Enroll a new **Storage** node through the node enrollment dialog or `scripts/setup-storage-node.sh`. The existing `docker.database.storage_root` remains the allocation root for compatibility. Managed databases, object storage and backup workspaces use preallocated ext4 images and respect the configured free-space reserve. Set CPU, memory and disk limits when provisioning a resource.

## Storage connections

The Storage section connects to AWS S3, Cloudflare R2, MinIO and compatible S3 endpoints, FTP, explicit or implicit FTPS, and SFTP. File protocols expose directories below the configured base path as buckets. SFTP requires the server's SHA256 host-key fingerprint; FTPS verifies the server certificate using the system trust store or a configured private CA.

Managed MinIO is private by default. Gateway accesses it over authenticated relay routes. Public S3 publication is a separate setting. FTP/SFTP listeners are opt-in public listeners with their own ports. The MinIO console is not published. Application bindings issue bucket-scoped credentials and provide an endpoint on the application's private binding network.

A distributed MinIO cluster requires at least four distinct Storage nodes, each with an explicit service IP reachable by the other members. Each node contributes one independently bounded disk. Configure member connectivity before provisioning; Gateway does not change host firewalls. The member health checks must report cluster write quorum before provisioning completes. The primary member currently owns the Gateway relay endpoint; this is not a separate highly available endpoint product.

The curated MinIO runtime is pinned to an immutable image digest. Runtime version selection is deliberately separate from a claim of ongoing upstream support. Review the image maintenance and upgrade policy before deploying it to a new production environment.

## Backup configuration

Gateway releases build and publish the native runner for amd64 and arm64 within the main release workflow, without a separate Git tag or release. Its immutable digest is bundled inside the signed Gateway image. Installation and upgrade use that default automatically, including when an older Compose file passes an empty `BACKUP_RUNNER_IMAGE`. Storage nodes must be able to pull the runner from GHCR. The runner runs only for backup/restore operations; it is not a persistent service.

`BACKUP_RUNNER_IMAGE` is an optional explicit override and must use an immutable `repository@sha256:…` reference. Source/development builds without a bundled runner still require an override. The runner contains the fixed native programs and transport clients; API clients cannot supply commands, scripts, SQL or arbitrary runner images.

In a database's **Backups** tab, select a destination, bucket, prefix and executor Storage node. Policies support manual execution, cron schedules with an explicit time zone, retention count, timeout and workspace/CPU/memory limits. Choose an existing destination bucket. The executor must be able to reach external database and storage endpoints. Private managed resources receive temporary routes for that run; Gateway's own ephemeral loopback ports are not forwarded to the executor.

An executor Storage node runs one backup or restore at a time. Runs admitted while it is busy stay **Queued** (waiting for executor) and start in creation order as soon as the node is free; a queued run can be cancelled immediately. A scheduled policy is skipped for a cron minute while its previous run is still queued or running.

- PostgreSQL uses a native custom-format dump and restores into an empty database.
- Redis captures a native RDB. Restore loads the verified RDB into an authenticated temporary Redis, performs full replication into an empty target, then detaches it. External targets require replication/configuration privileges and connectivity back to the executor's configured service address. Managed targets use their owned private network.
- ClickHouse uses native S3 BACKUP/RESTORE. For a private managed S3 endpoint, choose the managed ClickHouse node as executor; an external ClickHouse server instead needs a server-reachable S3 staging connection. File-protocol destinations require a separate S3 staging connection and bucket reachable directly from the ClickHouse server. Artifacts are transferred between staging and the selected final destination, retaining the native metadata and directory structure.

Restore creates a new managed database by default. Native preflight checks target emptiness; the original source is not overwritten. A compatible managed engine version must exist in the curated catalog. Artifact manifests record source identity, server version, sizes and SHA256 checksums. A successful upload alone is not considered a completed backup until its manifest has been validated.

## Permissions and lifecycle

Database permissions distinguish viewing, managing policies, running backups and restoring. `nodes:backups:execute` selects allowed executors. Storage object permissions and permission to use its credentials are checked independently for final and staging destinations: backups and restores need `storage:objects:write` or `storage:objects:read` plus `storage:credentials:use`, which lets the runner use the saved credentials without revealing them to the caller. `storage:credentials:reveal` implies it, and the built-in operator group holds it. Retention and history deletion remove objects inside the backup's own prefix, so they need `storage:objects:write` rather than bucket administration. Scoped tokens retain their own narrower authority. Scheduled runs revalidate the policy actor before execution.

Retention only removes completed artifacts belonging to the run's stored prefix. To remove a backup from history while its files still exist, choose explicitly: **Delete backup and files** removes the files first and keeps the history entry if storage refuses (the error names the reason); **Forget entry** removes only the entry and leaves the files in the bucket, for files that are unreachable or that you keep on purpose. The API takes `artifacts=delete` or `artifacts=forget` on `DELETE /databases/{id}/backups/runs/{runId}`, and the `manage_database_backups` tool takes `config.artifacts`.

Storage used by backup policies or by runs that are still active or cleaning up cannot be deleted: delete or re-point those policies and wait for the runs first. Finished backup history, including history of databases that were deleted since, blocks deletion until you confirm forgetting it (`backupHistory=forget` on the storage delete routes, `config.backupHistory` on the storage tools). Forgotten backups can no longer be restored or deleted through Gateway. Their files stay in external storage and are deleted together with a managed storage. The immutable execution request is encrypted while a run is active and removed on terminal completion. Lost command responses retain the node lease; reconnect reconciliation replays the same request or consumes the persisted terminal result. Cancellation remains reconcilable until the daemon confirms a terminal state. Failed or interrupted cleanup retains ownership for a retry.

Existing `databases` nodes retain their identity, enrollment, configuration, and storage root. An ordinary daemon update enables the unified Storage capabilities; re-enrollment, reinstallation, and data relocation are not required. Until updated, an older daemon can only execute workloads supported by its advertised capabilities. No automatic production restart or in-place data migration is part of this feature.
