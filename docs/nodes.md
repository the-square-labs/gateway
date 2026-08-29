# Nodes And Daemons

[Back to README](../README.md)

Gateway manages infrastructure hosts through small Go daemons. Each daemon connects outbound to the Gateway control plane over gRPC with mTLS.

## Daemon Types

| Type | Daemon | Purpose |
|------|--------|---------|
| nginx | `nginx-daemon` | Public ingress, routes, TLS termination, access lists, configuration, logs, and stats for host-native nginx. |
| docker | `docker-daemon` | Docker containers, deployments, cross-node migrations, portable and registry-backed `.gwca` archives, images, volumes, networks, tasks, files, consoles, registries, and offline inventory snapshots. |
| databases | `docker-daemon` | Gateway-managed Postgres, Redis, and ClickHouse instances only; generic workloads are rejected. |
| monitoring | `monitoring-daemon` | Metrics-only host monitoring without nginx or Docker control. |

Use a monitoring node when you want host metrics but do not want to grant Gateway ingress or Docker management on that host.

## Host Resource Sizing

Gateway daemons have a small resource footprint compared with the services they manage, so they do not have separate CPU, memory, or disk requirements. Size each host for its operating system and actual workload:

- nginx nodes for nginx traffic, TLS termination, and log volume;
- Docker nodes for the containers and deployments running on them;
- database nodes for the CPU, memory, swap, and storage allocated to managed databases;
- monitoring nodes according to the existing host workload being observed.

## Quick Setup

1. Open Gateway.
2. Go to **Nodes > Add Node**.
3. Choose the daemon type.
4. Create the node.
5. Copy the setup command from the dialog.
6. Run it on the target host.

Universal setup command:

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/setup-daemon.sh | \
  sudo bash -s -- --type nginx --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<FINGERPRINT>
```

> [!IMPORTANT]
> Daemons must reach the public Gateway relay endpoint directly on `9443/tcp`; the app-side gRPC listener is internal. During Gateway browser setup, select the direct public gRPC host or IP that should appear in enrollment commands; an optional local gRPC IP can be selected for nodes on the same private network. If the address changes later, update it in **Settings > Gateway > General settings** and generate a fresh node command instead of maintaining a manual edit workflow.

The wrapper downloads the daemon-specific installer and forwards all arguments.

## Daemon-Specific Setup

Nginx node:

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/setup-node.sh | \
  sudo bash -s -- --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<FINGERPRINT>
```

Docker node:

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/setup-docker-node.sh | \
  sudo bash -s -- --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<FINGERPRINT>
```

## Docker Secure Runtime

Gateway offers two workload isolation profiles:

| Profile | Docker runtime | Intended use |
|---------|----------------|--------------|
| **Default** | `runc` | Standard Docker compatibility and GPU/device support. |
| **Secure** | gVisor `runsc` | A stronger host-isolation boundary for compatible CPU-only workloads. |

The Default profile is available in every plan. The Secure profile is available in Business and Enterprise; see [Plans and licensing](licensing.md).

Secure Runtime is an additional defense layer, not a virtual machine and not a replacement for permissions, audit logging, network controls, or application security. Because gVisor implements a userspace kernel boundary, applications that depend on uncommon Linux syscalls or direct device access may require the Default profile.

### Setup and compatibility

A fresh generic Docker-node installation runs a Secure Runtime preflight before enrollment and attempts installation when the host is compatible. Existing installations are not modified during upgrade: an administrator with `admin:update` can open **Node Details > Secure Runtime Setup** to run the persisted preflight and installation workflow with step and download progress.

The same operations are available locally:

```bash
sudo docker-daemon runtime preflight runsc
sudo docker-daemon runtime install runsc
```

Both commands accept `--json` or `--plain`, plus `--non-interactive` and `--silent` for installers. Preflight exits with `0` when healthy, `10` when installable, `20` when unsupported, and `30` for other failures.

Secure Runtime requires:

- Linux on `amd64` or `arm64`;
- a daemon connected to the local Docker Engine rather than a remote Docker host;
- the Docker CLI and a Docker service that the installer can restart;
- root privileges for installation.

KVM is not required. A compatible LXC guest can use Secure Runtime when nested Docker, service management, and the required host capabilities are available; LXC compatibility is therefore host-configuration dependent rather than universal.

Gateway advertises Secure as available only after `runsc` is installed, configured in Docker, and passes consecutive Docker smoke tests. Secure workload creation fails closed while that status is unknown, unhealthy, installing, or unsupported.

### Workload boundaries

- Secure workloads cannot attach GPUs or host devices.
- Secure workloads cannot use host bind mounts. New or changed mounts use Gateway-managed local volumes in both profiles.
- Secure standalone containers and deployments cannot migrate between nodes in the current version.
- Secure standalone containers cannot be exported as `.gwca` archives because custom runtimes are outside the portable archive contract.
- Changing a saved workload between Default and Secure uses the normal recreate flow.
- All newly created Gateway workloads, including the Default profile, are non-privileged, add no Linux capabilities, and receive `no-new-privileges`.

## Docker GPU Workloads

Gateway can attach one or more discovered physical GPUs to a standalone Docker container or a blue/green deployment. The selection is node-local and uses stable device IDs; Gateway never accepts a browser-supplied host path or runtime ID.

### Host prerequisites

GPU support is opt-in host preparation. Gateway discovers and validates the resulting host state, but never installs a driver, a container runtime, or a vendor userspace stack.

- **NVIDIA:** install a working NVIDIA driver so `nvidia-smi` can query the card, then configure NVIDIA Container Toolkit with Docker so Docker reports an `nvidia` runtime. Gateway marks the device unavailable until both checks pass.
- **AMD:** the Linux driver must expose both `/dev/kfd` and the GPU's `/dev/dri/renderD*` node. Gateway maps only those daemon-discovered paths; an image still needs the ROCm or other userspace it requires.
- **Intel:** the Linux driver must expose the GPU's `/dev/dri/renderD*` node. `intel_gpu_top` is optional and only enriches utilization telemetry; the workload image still needs its own oneAPI, media, or other userspace dependencies where applicable.

The GPU must appear as attachable on the node before it can be selected. A device in NVIDIA MIG/partitioned mode, NVIDIA exclusive compute mode, or another unsupported virtualized/partitioned mode remains visible but cannot be attached.

### Shared-device and portability boundaries

- Physical GPU selections are shared: Gateway does not reserve VRAM, enforce quotas, schedule workloads, or calculate per-container GPU usage. Multiple containers may select the same attachable device.
- GPU changes use the normal recreate path. Duplicating a container preserves its GPU selection. A blue/green deployment gives the same selection to both application slots; the router never receives a GPU mapping.
- Node monitoring and GPU alerts use only device metrics that the daemon explicitly reports. A container's monitoring panel repeats that physical shared-device telemetry and does not claim it belongs only to that container.
- Gateway does not manage MIG, vGPU, SR-IOV, mediated devices, exclusive GPU allocation, or host driver/runtime installation. Existing unrecognized manual GPU mappings stay read-only so Gateway does not rewrite arbitrary host devices.
- GPU-attached containers and deployments cannot migrate between nodes in v1. GPU-attached standalone containers also cannot be exported as `.gwca` archives. Detach the GPU and recreate the workload before using those portability workflows.

Monitoring node:

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/setup-monitoring-node.sh | \
  sudo bash -s -- --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<FINGERPRINT>
```

## Installer Options

Common daemon setup options:

| Option | Purpose |
|--------|---------|
| `--gateway <host:port>` | Gateway gRPC address. |
| `--token <token>` | One-time enrollment token generated by Gateway. |
| `--gateway-cert-sha256 <sha256:hex>` | Gateway gRPC TLS leaf certificate fingerprint generated with the token. Required for first enrollment. |
| `--host <host>` / `--port <port>` | Alternative to `--gateway` when specifying the Gateway address in separate parts. |
| `--version <tag>` | Install a specific daemon version. |
| `--user <username>` | Run nginx, Docker, or monitoring daemons as a specific user. Database nodes accept only `--user root`. |
| `--dry-run` | Validate inputs and show the plan without changing the host. |
| `-y`, `--yes` | Non-interactive mode. |
| `--help` | Show all supported options. |

The installers verify downloaded daemon binaries with SHA256 checksums and back up existing binaries during upgrades.

## Nginx Node Modes

The nginx installer supports:

| Mode | Use when |
|------|----------|
| `managed` | Gateway should write a complete known-good nginx base config and default server. |
| `integrate` | The host already has nginx config you want to keep. Gateway injects managed includes and a local `stub_status` endpoint. |

Example:

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/setup-daemon.sh | \
  sudo bash -s -- --type nginx --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<FINGERPRINT> --nginx-mode integrate
```

Use `managed` for fresh ingress nodes where Gateway should own nginx. Use `integrate` when nginx is already used by other workloads on the same host.

Gateway routes require nginx `1.25.1` or newer. On a fresh host, the installer always uses the nginx.org stable package. When it detects an older existing nginx, it asks before upgrading it; declining stops the installation before Gateway changes the nginx configuration or enrolls the daemon. Non-interactive installation refuses an unsupported existing nginx because it cannot ask for that approval.

## Enrollment Flow

On first start, the daemon:

1. Connects to Gateway and verifies the presented gRPC TLS leaf certificate matches `gateway.cert_sha256`.
2. Sends the one-time enrollment token only after the certificate pin matches.
3. Receives an mTLS client certificate issued by Gateway's internal CA.
4. Clears the enrollment token from its local config.
5. Reconnects using the mTLS certificate.
6. Registers as online and begins syncing config or reporting metrics.

The token is only needed for enrollment. Long-term daemon authentication uses mTLS.

## Firewall Requirements

| Direction | Port | Purpose |
|-----------|------|---------|
| Node to Gateway relay | `9443/tcp` | Public relay-backed gRPC control plane and tunnel endpoint; the app-side gRPC listener is internal. |
| Managed node to remote relay | `9443/tcp` by default | mTLS relay data plane; required only for configured Relay Pool members. |
| Internet to nginx node | `80/tcp`, `443/tcp` | Public HTTP/HTTPS traffic served by nginx. |

Managed nodes do not need inbound management ports for Gateway.

## Relay Nodes

Create relay nodes from **Settings > Relay > Add relay node**. The generated command installs a signed `relay-supervisor` and its separately signed worker, pins the Gateway certificate before sending the one-time enrollment token, and persists a physical host identity used as the Relay Pool fault domain. Two relay processes on the same physical host do not count as redundant.

The supervisor connects outbound to Gateway. The worker listens on the advertised address and port (TCP `9443` by default), which must be reachable from participating Docker, nginx, database, and Gateway hosts. Gateway does not open that port, alter firewall rules, create an overlay, or traverse NAT. Adding a healthy relay does not remap existing endpoints; use explicit **Rebalance** after confirming reachability.

If Gateway is behind Cloudflare for the UI/API, configure Gateway's public gRPC target as a direct `9443/tcp` endpoint. A Cloudflare-proxied web hostname must not be selected unless it explicitly routes the Gateway gRPC port. Generated commands use the configured target, so normal enrollment does not require replacing the address by hand.

Daemons report local and detected public IP addresses in their health data. For Docker nodes, Gateway uses an explicitly configured service address first, then the first reported local address, then a reported public address when proxy Docker upstreams or cross-node workflows need to reach the host. Configure the service address on the node detail page when automatic selection is not routable from the other managed hosts.

## Daemon Configuration

Daemons store config under `/etc/<daemon-name>/config.yaml`.

Example nginx daemon config:

```yaml
gateway:
  address: "gw.example.com:9443"
  token: ""
  cert_sha256: "sha256:<gateway-grpc-leaf-fingerprint>"

tls:
  ca_cert: "/etc/nginx-daemon/certs/ca.pem"
  client_cert: "/etc/nginx-daemon/certs/node.pem"
  client_key: "/etc/nginx-daemon/certs/node-key.pem"

nginx:
  config_dir: "/etc/nginx/conf.d/sites"
  certs_dir: "/etc/nginx/certs"
  logs_dir: "/var/log/nginx"
  global_config: "/etc/nginx/nginx.conf"
  binary: "/usr/sbin/nginx"
  stub_status_url: "http://127.0.0.1/nginx_status"
  htpasswd_dir: "/etc/nginx/htpasswd"
  acme_challenge_dir: "/var/www/acme-challenge"

state_dir: "/var/lib/nginx-daemon"
log_level: "info"
log_format: "json"
```

In `integrate` mode, the `stub_status_url` may use a local alternate port such as `http://127.0.0.1:8081/nginx_status`.

## Daemon Updates

From the UI:

1. Open the node detail page.
2. Review runtime and version status.
3. Click **Update** when an update is available.

Gateway verifies the signed daemon release manifest before dispatching an update. New daemons verify the signed manifest locally, download the binary, verify its SHA256 checksum, replace the binary atomically, and exit so systemd restarts the service.

Daemons installed before signed-manifest support can perform one transition update: Gateway verifies the signed manifest and sends the verified checksum, while the old daemon enforces the checksum. After that update, daemon-side signature verification is enforced.

Release and update units are independent: nginx, Docker, monitoring, the Relay Pool supervisor, and the Relay Pool worker have their own signed artifact contracts. The local Gateway relay image, database connector image, and Secure Link connector image are also pinned and verified independently rather than inheriting the Gateway app version.

The installation-wide update channel applies to managed daemon checks. `stable` offers production tags only, while `preview` also allows matching `vX.Y.Z-rc.N-<component>` GitHub prereleases. Gateway resolves one staged target per daemon type from the oldest compatible installed version cohort, preferring a newer patch on that minor and otherwise the baseline release of the next minor. This avoids advertising a later target that would skip an older cohort's required upgrade step.

Docker nodes expose first-class Compose Projects. Community and paid plans discover existing projects from canonical labels and provide read-only inventory, status, monitoring, and logs. Personal and higher can create or adopt single-node image-only projects, validate complete single-file YAML, keep immutable revisions, run explicit lifecycle operations, stream aggregated logs, report drift, use ordinary non-Swarm CPU/memory/PID limits, attach managed databases, and target services from Routes or Secure Links without pinning an ephemeral container name. Business and Enterprise can instead attach an allowlisted Git source whose bounded Compose `build` sections are resolved by isolated Build Workers into one digest-pinned immutable revision. Gateway never reads host Compose source paths, and generated runtime networks or managed-database overlays are not written back into the authored source. Project-owned child containers, named volumes, and non-external networks are removed from standalone lists and protected from direct mutations; images and external/shared resources remain global.

The Docker daemon runs Compose through Docker's official `docker/compose-bin` image, pinned by multi-architecture OCI digest. It pulls the pinned image when absent and advertises `docker_compose_v1` only after the image is available and the executor initializes. If registry access is unavailable, Compose inventory remains readable but managed mutations fail closed until the runtime becomes available. Multi-node application clusters and same-node multi-instance scaling remain in development.

## Manual Setup

Manual setup is useful for locked-down hosts or custom packaging.

1. Create a node in Gateway and copy the enrollment token plus the Gateway certificate fingerprint.
2. Download the daemon binary, `checksums.txt`, and the matching `*.update.json` signed manifest from the release package.
3. Verify the signed manifest with the compiled Square Labs update public key, then verify the SHA256 checksum.
4. Install the binary.
5. Write `/etc/<daemon-name>/config.yaml`.
6. Create and start a systemd service.

Example checksum flow:

```bash
curl -fsSL "https://updates.thesqlabs.com/gateway/nginx-daemon/v2.0.0-nginx/nginx-daemon-linux-amd64" \
  -o /tmp/nginx-daemon-linux-amd64
curl -fsSL "https://updates.thesqlabs.com/gateway/nginx-daemon/v2.0.0-nginx/checksums.txt" \
  -o /tmp/nginx-daemon-checksums.txt
curl -fsSL "https://updates.thesqlabs.com/gateway/nginx-daemon/v2.0.0-nginx/nginx-daemon-linux-amd64.update.json" \
  -o /tmp/nginx-daemon-linux-amd64.update.json

expected=$(awk '/nginx-daemon-linux-amd64/ { print $1 }' /tmp/nginx-daemon-checksums.txt)
actual=$(sha256sum /tmp/nginx-daemon-linux-amd64 | awk '{ print $1 }')
[ "$expected" = "$actual" ] || { echo "checksum mismatch"; exit 1; }

install -m 755 /tmp/nginx-daemon-linux-amd64 /usr/local/bin/nginx-daemon
```

`checksums.txt` alone is not sufficient for automatic updates. Gateway and new daemons require the signed `*.update.json` manifest to establish release provenance.

Then enroll and start:

```bash
nginx-daemon install --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<FINGERPRINT>
systemctl enable --now nginx-daemon
```

Replace `nginx-daemon` with `docker-daemon` or `monitoring-daemon` as needed. A database node also uses `docker-daemon`, installed in its `databases` profile.

For a database node, use the installer rather than preparing filesystems manually:

```bash
sudo ./scripts/setup-daemon.sh --type databases
```

It rejects a host that cannot complete the same fixed-size storage lifecycle used at runtime: preallocate and format an ext4 image, attach a free loop device, mount and write it, grow the image and filesystem, then unmount and detach it. It also verifies the local Docker Engine before enrollment. Failed probes clean their temporary mount, loop attachment, and image before the installer exits. The database profile then uses fixed-size preallocated ext4 images under `/var/lib/docker-daemon/databases` by default (or the configured external mount), so each managed database has a hard storage limit without reformatting the VM disk.

VM and bare-metal hosts normally expose the required loop and mount capabilities directly. An LXC database node is supported only when its outer host explicitly passes `/dev/loop-control` plus a loop-device pool and permits loop block devices and mounts. The installer detects an ordinary LXC guest without those capabilities and stops before enrollment with that remediation; it never falls back to an unbounded Docker volume.

The database installer runs `docker-daemon` only as root and shows a local-disk selector in an interactive terminal. Choose an eligible mounted filesystem or a custom path; the selected location becomes the storage root. For automation, pass `--storage-root <path>` (or set `GATEWAY_DATABASE_STORAGE_ROOT`) together with the normal enrollment flags and `--yes`. The preflight runs before enrollment, and `--dry-run` performs no storage preparation or other host mutation.

Managed application bindings also require `DATABASE_CONNECTOR_IMAGE` on Gateway to contain the release-published, immutable `.../database-connector@sha256:<digest>` reference. Gateway refuses to create a binding when this release setting is absent or mutable; the connector itself receives no Gateway endpoint, certificate, or database credentials.

Published managed databases use native direct TLS by default. Gateway issues the server certificate from its independent Database CA and keeps the private key in daemon-owned storage outside the database image. PostgreSQL and Redis publish one TLS endpoint; ClickHouse publishes both HTTPS and its native TLS endpoint. The UI exposes the CA certificate/fingerprint with direct credentials and supports certificate rotation after node IP changes.

## Offline Behavior

If Gateway is offline:

- Existing nginx configs keep serving traffic.
- Docker containers keep running.
- Daemons keep retrying connection.
- Operators temporarily lose centralized UI/API control.
- New config changes cannot be pushed until Gateway is online again.

When Gateway returns, daemons reconnect and resume normal operation.
