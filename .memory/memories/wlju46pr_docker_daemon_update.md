---
{
  "id": "wlju46pr",
  "file_name": "wlju46pr_docker_daemon_update",
  "tags": [
    "daemon",
    "docker",
    "local-setup",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777167872900,
  "updated_at": 1777167872900
}
---
For the gateway repo local Docker node, update the `daemon-docker` container by cross-building the daemon for Linux arm64 from `packages/daemons/docker`: `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags '-s -w -X main.Version=dev' -o bin/docker-daemon-linux-arm64 ./cmd/docker-daemon`, then `docker cp packages/daemons/docker/bin/docker-daemon-linux-arm64 daemon-docker:/usr/local/bin/docker-daemon`, restart the in-container process with `docker exec daemon-docker sh -lc 'kill <pid>; sleep 1; nohup docker-daemon run >/var/log/docker-daemon.log 2>&1 &'`, and verify `/var/log/docker-daemon.log` shows `docker engine connected` and `connected to gateway`. The container is ARM64; a host-platform build will fail there with `Exec format error`.
