---
{
  "id": "iois3ul4",
  "file_name": "iois3ul4_managed_database_relay",
  "tags": [
    "database-tunnel",
    "docker-daemon",
    "e2e",
    "gateway-relay",
    "installer",
    "loop-device",
    "managed-databases",
    "migration"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.98,
  "created_at": 1786111914144,
  "updated_at": 1786119400859
}
---
# Independent managed-database relay, upgrade, and storage contract

## Architecture and operator behavior

- Standalone `gateway-relay` owns the existing public `:9443`; Gateway app keeps public `:3000` and internal relay/control access. Do not add another public port.
- Each daemon maintains one additional process-lifetime multiplexed tunnel connection for data-plane traffic. Binding streams remain multiplexed; do not open one connection per binding.
- Control-plane monitoring stays on the existing app session.
- Gateway supervises relay health and may perform bounded automatic recovery. If recovery fails, Dashboard shows a critical red notice with a compact title, short description, and CTA to a shared-shell detail modal.

## Stateful migration evidence

- A real v2.5.2-to-worktree migration on `172.20.0.131` created a signed stable baseline, legacy Docker workload, managed PostgreSQL binding with persisted data, nginx proxy route, and authenticated browser state before cutover.
- The target-image foundation migrator created a timestamped rollback backup, moved public `:9443` from app to standalone relay, preserved PostgreSQL and Redis foundation container identities, and left app/relay healthy.
- After migration, workload HTTP, proxy HTTP, persisted PostgreSQL data, binding queries, node reconnect, and browser views passed.
- A long-lived PostgreSQL session survived complete app stop and force-recreate; a new binding session also opened while app was down. Relay identity and start time did not change.
- Stable daemon tunnel v1 is not compatible with the standalone relay v2 lanes. Both participating Docker daemon endpoints must be upgraded during migration; a temporary tunnel interruption during that upgrade is expected.
- Exact signed-candidate delivery is still unproven because the worktree candidate was locally built. Redis and ClickHouse managed-engine continuity remain separate release evidence gaps.

## Fixed-size database storage and installer gate

- Managed database capacity remains a hard fixed-size loop-backed ext4 image. Do not replace it with Docker volumes or soft quotas.
- Database-profile installation must install/validate Docker before enrollment and run the runtime-equivalent lifecycle: required command checks, free loop device, non-sparse image allocation, ext4 format, loop attach with `--nooverlap` plus portable fallback, `noatime` mount, write probe, image growth, `losetup -c`, block-size verification, `resize2fs`, unmount, and detach.
- Every preflight path uses cleanup traps and leaves no image, mount, or loop attachment after success or failure.
- Unsupported LXC must fail before enrollment with actionable outer-host loop-device/mount passthrough guidance; it must not offer an unbounded storage fallback.
- Real evidence: `172.20.0.132` LXC failed cleanly at the prerequisite gate; recreated `172.20.0.133` KVM VM installed Docker first, passed the complete preflight, enrolled, provisioned a fixed 1 GiB PostgreSQL image, and cleaned up without loop/mount residue.

## Connector socket lifecycle

- Mounting the Unix socket file directly pins connector sidecars to a stale inode after Docker daemon restart.
- The daemon owns a dedicated `database-tunnel/tunnel.sock` directory and connector sidecars mount only that directory read-only at `/run/gateway-db`.
- On general Docker daemon Init, before enrollment or Gateway connectivity, exact first-party connector containers labeled `wiolett.gateway.managed-database.connector=true` are reconciled once from the legacy socket-file bind to the directory bind.
- Migration recognizes both Docker `HostConfig.Binds` and structured `HostConfig.Mounts`, requires the exact legacy source/target pair, preserves the container configuration and network aliases, and is idempotent.
- A failed required connector migration fails daemon initialization so systemd retries instead of advertising a healthy node with broken bindings.
- Real Docker evidence on `.132`: the legacy connector was recreated once, became a read-only directory mount with its network alias preserved, and retained the same new container ID across the next daemon restart. The stateful PostgreSQL E2E then proved a fresh query after daemon restart.
