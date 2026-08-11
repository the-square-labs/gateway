---
{
  "id": "e5deql0f",
  "file_name": "e5deql0f_docker_installer_provisioning",
  "tags": [
    "alpine",
    "debian",
    "docker",
    "gateway",
    "installer",
    "openrc",
    "regression"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786049117386,
  "updated_at": 1786486124617
}
---
- `scripts/install.sh` must bootstrap Docker on fresh Debian, Ubuntu, Fedora, CentOS, and RHEL hosts.
- `scripts/setup-docker-node.sh` must also bootstrap Docker on Alpine. Use Alpine community packages `docker` and `docker-cli-compose`, then enable/start Docker with OpenRC. Systemd is not required; the installer also registers `docker-daemon` as an OpenRC service.
- A minimal Alpine host must have Bash available to invoke the setup scripts. The matching Alpine community repository must expose the Docker packages.
- Install Docker CE from Docker's official repository on Debian/Ubuntu/Fedora/CentOS/RHEL and include the Compose v2 plugin.
- Start the Docker daemon, then select `docker` or `sudo docker` based on availability.
- Keep installer status messages inside the guide-rail UI; redirect package and daemon-install command output to the secured installer `LOG_FILE`. Surface required-step failures through `die`; use the existing `run_quiet` pattern.
- Removing conflicting Docker packages is cleanup, not a required step. Run the apt/dnf/yum removal best-effort because supported distributions may not publish every package name (for example, Debian 12 does not publish `docker-compose-v2`), and an exit 100 there must not block repository setup and Docker CE installation.
- The regression check for a fresh Debian 12 container must reach `Docker Engine and Docker Compose v2 installed`. A later service-start failure is expected in a plain container without systemd and does not invalidate the package-install check.
- The Alpine regression check must get past package installation and reach `Starting Docker service`; a later daemon reachability failure is expected in an unprivileged container without a functioning OpenRC/cgroup host environment.
- Detect Docker's systemd unit, preferring:
  1. `docker.service`
  2. `snap.docker.dockerd.service` for Ubuntu Snap Docker
- Apply Docker-unit detection consistently in `scripts/setup-docker-node.sh`, `scripts/install.sh`, and `packages/daemons/docker/cmd/docker-daemon/main.go`.
- Generated `docker-daemon` systemd units must depend on the detected Docker unit; setup should pass the detected Docker context host via `--docker-socket`.
- Local Docker-in-Docker containers require starting `dockerd` on `/var/run/docker.sock` before starting `docker-daemon run`.
- Docker log access must remain bounded: use 8 MiB maximum read size, 1 MiB maximum line size, default follow mode to `tail=0`, bounded `since`/`until` windows, asynchronous non-follow reads, and prompt session teardown on async failures.
