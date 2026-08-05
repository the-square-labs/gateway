---
{
  "id": "zq6da64z",
  "file_name": "zq6da64z_docker_daemon_incident",
  "tags": [
    "daemon",
    "docker",
    "incident",
    "production",
    "snap",
    "systemd"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777288607698,
  "updated_at": 1777288607698
}
---
On 2026-04-27, production node root@178.62.232.237 (ubuntu-shark-bot-services, node id 8ef2e986-359d-4cfd-a8b2-3c3f2b78d261) went offline in Gateway during Snap Docker auto-refresh. Evidence: snap change 101 auto-refreshed snap docker to revision 3505 / Docker 29.3.1 at 10:38 UTC. systemd stopped docker-daemon.service at 10:38:52 because its unit had Requires=snap.docker.dockerd.service. Gateway audit showed node.disconnected at 10:38:52 and node.connected at 10:41:09, not a Gateway stop action. Hotfix applied on the node: backed up /etc/systemd/system/docker-daemon.service to docker-daemon.service.bak-20260427-snap-requires, removed Requires=snap.docker.dockerd.service, ran systemctl daemon-reload. Verified docker-daemon.service Requires only system.slice/sysinit.target and Wants/After snap.docker.dockerd.service; Gateway DB showed node online with last_seen_at 2026-04-27 11:16:09+00. Repo fix removes hard Docker Requires from packages/daemons/docker/cmd/docker-daemon/main.go and scripts/setup-docker-node.sh and adds a regression test in packages/daemons/docker/cmd/docker-daemon/main_test.go.
