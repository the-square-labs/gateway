---
{
  "id": "muapjlzr",
  "file_name": "muapjlzr_docker_daemon_install",
  "tags": [
    "daemon",
    "docker",
    "installer",
    "snap",
    "systemd"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777147490959,
  "updated_at": 1777147490959
}
---
Docker daemon install compatibility gotcha: Ubuntu Snap Docker exposes `snap.docker.dockerd.service` instead of `docker.service`. The repo now detects Docker units in `scripts/setup-docker-node.sh`, `scripts/install.sh`, and `packages/daemons/docker/cmd/docker-daemon/main.go`, preferring `docker.service` then `snap.docker.dockerd.service`; generated docker-daemon systemd units depend on the detected unit, and setup passes detected Docker context host via `--docker-socket`.
