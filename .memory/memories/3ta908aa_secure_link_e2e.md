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
  "updated_at": 1786469247366
}
---
# Secure Link and Managed Database Relay Context

## Production relay architecture

- Standalone `gateway-relay` owns public `:9443`; Gateway app retains public `:3000`. Do not add another public port.
- Daemons maintain process-lifetime multiplexed HTTP/2 mTLS data tunnels. Binding and logical proxy streams are multiplexed; never open one connection per binding or request.
- Nginx secure-link proxying uses deterministic Unix sockets at `/run/gateway-secure-links/<proxy-host-id>.sock`; loopback TCP remains only as a rolling-upgrade fallback.
- Generated Nginx config uses a named upstream with `keepalive 64`, HTTP/1.1 reuse for non-WebSocket traffic, and the Unix socket target.
- Nginx maintains configurable persistent data lanes: default 4, allowed 1-16, least-active selection. Grant timestamp refreshes must not reconnect lanes.
- Relay bridge reads use a pooled 32 KiB buffer by default, configurable 4-256 KiB; protocol frames remain capped at 1 MiB.
- Relay gRPC permits daemon 30-second idle keepalive with 20-second minimum interval and `PermitWithoutStream`, preventing `GOAWAY too_many_pings` churn.

## Adaptive admission and database priority

- Do not use a global request/session cap as primary Relay protection. Healthy load has no application-size or session-count ceiling.
- Defaults stored in Gateway settings and distributed through relay snapshots: enabled, proxy target 70%, database reserve 20 percentage points, hard cutoff 95%.
- Below 70%, new proxy and database sessions are admitted normally.
- From 70% to 75%, fair-share admission rejects only a dominant proxy route while smaller/new routes can enter.
- At 75% and above, new proxy sessions are rejected, preserving the 75-95% headroom for higher-priority database tunnels.
- New database tunnels remain admissible until 95%; existing sessions are never killed by admission.
- At 95%, new database sessions are rejected only for last-resort process safety.
- Recovery hysteresis returns to normal below 60%.
- Admission accounting is O(1); deterministic tests cover healthy 100,000-session admission, dominant-route fairness, database reserve, hard cutoff, disabled mode, and recovery.

## Relay-owned telemetry contract

- Relay pressure must use Relay process resources, never whole-host or outer-container utilization.
- CPU is the sum of runtime nanoseconds from all `/proc/self/task/*/schedstat` threads, normalized by the process CPU affinity from `Cpus_allowed_list`. Reading only `/proc/self/schedstat` measures the Go main thread and falsely reports zero under worker-thread load.
- CPU, memory-pressure, FD-pressure, and aggregate admission pressure are EWMA-smoothed. Raw RSS, heap-in-use, open FD count, FD limit, and active tunnel counts are current values.
- Memory RSS comes from `/proc/self/statm`; Go heap comes from `runtime.MemStats.HeapInuse`.
- If `/sys/fs/cgroup/memory.max` is finite, memory pressure is Relay RSS divided by that limit.
- If `memory.max=max`, memory pressure is unavailable/zero while RSS and heap remain visible. Never fall back to `/proc/meminfo`: nested Docker inside an unprivileged Proxmox LXC can expose physical-host memory rather than the LXC limit.
- On the .134 stand, the bad fallback saw roughly 98.8 GB total and 69.2 GB available on the physical host and falsely displayed 30%, while Relay RSS was only about 18 MB and the LXC itself used roughly 16-17% of 8 GB.
- FD pressure uses Relay open descriptors divided by `RLIMIT_NOFILE`.
- Health/API fields include RSS, heap, optional memory limit, open FD count, FD limit, per-class active tunnels, rejection totals, component pressure, and admission state.

## Operator UI

- Monitoring and runtime controls live under **Settings -> Relay**; no environment variables are added.
- The status header contains only Relay health, build, protocol, and readable admission state. `Last probe` is not shown there.
- Numeric telemetry uses the existing shared `StatCard`, `Sparkline`, and `ProgressBar` components and the Node Monitoring layout precedent.
- Sections are Tunnel activity, Relay resources, and Admission & runtime.
- Cards keep 60 five-second in-session samples. Progress is shown only when a real denominator exists; unlimited memory shows RSS plus heap and `no cgroup limit`.
- Docker-backed proxy hosts expose **Link Runtime** with state, generation, source/target nodes, transport, relay probe, and last error.
- Default Nginx client-IP rate limit is 1000 requests/second with burst 3000 and HTTP 429; each proxy template can inherit, customize, or disable it.

## Verified deployment and load - 2026-08-11

- Gateway host: `172.20.0.134`; Compose directory: `/opt/gateway`.
- App/UI image: `gateway:secure-link-runtime-20260811-r4`.
- Relay image: `gateway-relay@sha256:143ec62b21cf3707c6c0436078444a58d5885d1d2380709ed918496c8625fc51`.
- Relay build identity: `secure-link-runtime-20260811-relay-r6`.
- Only app and relay were recreated with `--no-deps --force-recreate`; PostgreSQL and Redis were preserved. Both are healthy with zero restarts.
- Live idle UI showed Relay CPU/admission pressure 0%, RSS about 15.5 MB, heap about 4 MB, no cgroup limit, about 19 open FDs, five database tunnels, and no rejection counters.
- Controlled load used 400 persistent clients across four loopback client IPs through the real `.137 Nginx -> .134 Relay -> .136 Docker` route.
- Final load: 56,577/56,577 HTTP 200 responses in 21.27 seconds, about 2,660 requests/second, concurrency 400.
- Live peak UI showed 432 proxy streams plus database traffic, Relay CPU 9%, RSS 47.6 MB, heap 13.9 MB, 22 open FDs, aggregate admission pressure 9%, no throttling.
- Concurrent Docker stats showed 39.18% of one CPU. With Relay affinity of four CPUs, this is about 9.8% of available capacity and matches the UI.
- An earlier 31.41-second run produced 58,903/58,903 HTTP 200 responses at about 1,875 requests/second and peaked at 516 proxy streams.
- After load, proxy streams returned to the configured 64 Nginx keepalive pool; RSS fell and database tunnels remained active.
- Managed PostgreSQL secure-link probe passed after load in 113 ms.
- Proxy E2E Host `secure-links-c.test` returned HTTP 200 and `C:ok`.
- Relay/app logs had no `unexpected_image`, `contract_mismatch`, `too_many_pings`, panic, fatal, or ResourceExhausted entries.
- Rollback env backups for r4, relay-r5, and relay-r6 are root-owned mode 600 under `/opt/gateway`.

## Gateway frontend reload safety

- `/api/system/version` and `/health` expose different version concepts. Failed authenticated version requests return no comparison sample; never fall back to the health build string.
- Cross-tab update messages carry one ID stored in `sessionStorage` and reused as the `_v` cache-bust token. Ignore handled messages and messages older than two minutes.
- Version checks do not overlap and stop scheduling navigation after the first detected change.
- The global rate-limit screen clears when its retry window expires and must not reload the page.

## Managed database continuity constraints

- Managed database storage remains a fixed-size loop-backed ext4 image, never a Docker volume or soft quota.
- Database-profile install validates Docker before enrollment and performs the full loop/ext4 allocate, format, mount, write-probe, grow, resize, cleanup lifecycle.
- Unsupported LXC fails before enrollment with actionable outer-host loop-device/mount-passthrough guidance; no unbounded fallback.
- Connector sidecars mount the daemon-owned `database-tunnel` directory read-only at `/run/gateway-db`, not the socket file, preventing stale-inode failures after daemon restart.
- A prior v2.5.2 migration on `172.20.0.131` proved that a long-lived PostgreSQL session survives app stop/recreate and new binding sessions can open while the app is down.
