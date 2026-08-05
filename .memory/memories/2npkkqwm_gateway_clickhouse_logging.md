---
{
  "id": "2npkkqwm",
  "file_name": "2npkkqwm_gateway_clickhouse_logging",
  "tags": [
    "clickhouse",
    "deployment",
    "gateway",
    "logging",
    "ssh"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777399734516,
  "updated_at": 1777399734516
}
---
Production gateway on wlt-gateway (ssh -J root@172.16.20.12 root@172.16.20.60) loads gateway env from /root/.env via /root/docker-compose.yml. Logging ClickHouse is reachable at http://172.16.20.62:8123 using user gateway-c42j. The gateway app's CLICKHOUSE_DATABASE validator only accepts /^[A-Za-z_][A-Za-z0-9_]*$/, so a provided ClickHouse DB name with hyphens such as gateway-logs-3cd will crash startup with INVALID_CLICKHOUSE_IDENTIFIER. For the April 28 2026 deployment, use CLICKHOUSE_DATABASE=gateway_logs_3cd; the database and logs table were created and verified with SHOW TABLES FROM gateway_logs_3cd -> logs. Recreate app with: cd /root && docker compose -f docker-compose.yml --env-file /root/.env up -d app.
