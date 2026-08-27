---
{
  "id": "3ta908aa",
  "file_name": "3ta908aa_secure_link_e2e",
  "tags": [
    "admission-control",
    "deployment",
    "e2e",
    "load-test",
    "managed-database",
    "monitoring",
    "nginx",
    "relay",
    "secure-link"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1786463265800,
  "updated_at": 1787862245378
}
---
# Secure Link and managed-database relay contract

## Relay architecture

- Standalone `gateway-relay` owns the public relay port; the Gateway app retains its HTTP port. Do not add another public relay port.
- Daemons maintain process-lifetime multiplexed HTTP/2 mTLS data tunnels. Binding and logical proxy streams remain multiplexed; never open one connection per binding or request.
- Nginx secure-link proxying uses deterministic Unix sockets under `/run/gateway-secure-links`; loopback TCP exists only as a rolling-upgrade fallback.
- Generated Nginx config uses a named upstream, connection reuse for non-WebSocket traffic, and the Unix-socket target.
- Nginx maintains configurable persistent data lanes with least-active selection. Grant timestamp refreshes must not reconnect lanes.
- Relay bridge buffers are bounded and configurable; protocol frames remain capped.
- Relay gRPC permits bounded daemon keepalive without creating `GOAWAY too_many_pings` churn.

## Adaptive admission and database priority

- Do not use a global request/session cap as primary Relay protection. Existing sessions are never killed by admission control.
- Admission uses persisted settings distributed through relay snapshots, with normal operation, proxy fairness, database-reserved headroom, a hard process-safety cutoff, and recovery hysteresis.
- Fair-share admission rejects a dominant proxy route before smaller/new routes.
- New proxy sessions are rejected before database tunnels, preserving capacity for managed-database traffic.
- Admission accounting must remain O(1), deterministic, and testable under high session counts.

## Relay-owned telemetry

- Relay pressure uses Relay process resources, never whole-host utilization.
- CPU is summed from all `/proc/self/task/*/schedstat` threads and normalized by process CPU affinity.
- CPU, memory, file-descriptor, and aggregate admission pressure are smoothed; raw RSS, heap, descriptor counts/limits, and active tunnels remain current values.
- Memory RSS comes from `/proc/self/statm`; Go heap comes from `runtime.MemStats.HeapInuse`.
- Use a finite cgroup `memory.max` as the memory-pressure denominator. If it is unlimited, report pressure as unavailable while preserving raw RSS/heap. Never fall back to `/proc/meminfo`, because nested container environments can expose outer-host memory.
- File-descriptor pressure uses Relay open descriptors divided by `RLIMIT_NOFILE`.
- Health/API fields include raw resources, optional limits, active tunnels by class, rejection totals, component pressure, and admission state.

## Operator UI

- Monitoring and runtime controls live under **Settings → Relay**; do not add environment-variable configuration.
- The status header contains Relay health, build, protocol, and readable admission state.
- Reuse shared monitoring primitives and preserve in-session telemetry histories.
- Docker-backed proxy hosts expose Link Runtime with state, generation, source/target nodes, transport, relay probe, and last error.
- Proxy templates may inherit, customize, or disable the default client-IP rate limit.

## Frontend reload safety

- `/api/system/version` and `/health` expose different version concepts. Failed authenticated version requests produce no comparison sample.
- Cross-tab update messages reuse one session ID as the cache-bust token, ignore handled/stale messages, do not overlap checks, and stop scheduling navigation after detecting a version change.
- The global rate-limit screen clears after its retry window and must not reload the page.

## Managed-database continuity

- Managed database storage remains a fixed-size loop-backed ext4 image, never a Docker volume or soft quota.
- Database-profile install validates Docker before enrollment and exercises allocate, format, attach, mount, write-probe, grow, resize, cleanup, and failure-cleanup paths.
- Unsupported container environments fail before enrollment with actionable host passthrough guidance; no unbounded fallback is allowed.
- Connector sidecars mount the daemon-owned socket directory read-only rather than the socket file, preventing stale-inode failures after daemon restart.
- App/relay replacement and daemon upgrades must preserve foundation data, node identities, existing database sessions where supported, and the ability to open new binding sessions.
