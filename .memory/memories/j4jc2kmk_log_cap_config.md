---
{
  "id": "j4jc2kmk",
  "file_name": "j4jc2kmk_log_cap_config",
  "tags": [
    "docker",
    "gateway",
    "local-services",
    "logs",
    "operations"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1783110467330,
  "updated_at": 1783110467330
}
---
On Gateway node local-services, Docker json-file log growth was mitigated by configuring /etc/docker/daemon.json with log-driver json-file and log-opts max-size=10m, max-file=1, then reloading Docker. Because Docker log options only apply to newly created containers, an additional systemd timer docker-json-log-cap.timer runs every 5 minutes and executes /usr/local/sbin/docker-json-log-cap to truncate existing /var/lib/docker/containers/*/*-json.log files larger than 10M. This was added after analytics-clickhouse produced a huge json log.
