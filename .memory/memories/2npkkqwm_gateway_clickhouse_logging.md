---
{
  "id": "2npkkqwm",
  "file_name": "2npkkqwm_gateway_clickhouse_logging",
  "tags": [
    "clickhouse",
    "housekeeping",
    "logging",
    "retention"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1777399734516,
  "updated_at": 1786067585216
}
---
## Gateway ClickHouse Logging

- Production gateway host: `wlt-gateway`; ClickHouse is reachable from PVE host `root@172.16.20.12` via CT 111 at `http://172.16.20.62:8123`.
- Gateway environment is `/root/.env`; Docker Compose file is `/root/docker-compose.yml`.
- `CLICKHOUSE_DATABASE` must match `^[A-Za-z_][A-Za-z0-9_]*$`; use `gateway_logs_3cd`, not a hyphenated name.
- The Gateway uses an authenticated `gateway_logs_3cd.logs` MergeTree table.

## Retention and maintenance

- Structured-log retention is configured per logging environment in **Logs → environment → Settings → Ingest → Retention days**. It accepts 1–365 days and defaults to 30.
- Retention is written into each row as `RetentionDays`; the table TTL is `TimestampTime + toIntervalDay(RetentionDays)`. Updating an environment changes future ingested rows only, not the retention stamped on existing rows.
- Housekeeping structured-log row/size caps are separate from TTL. Cleanup removes complete oldest daily partitions while preserving the newest partition, so it can reduce volume substantially when an old partition is over the desired target.
- ClickHouse internal system logs are monitored continuously. Cleanup is controlled only by the persisted **Settings → Housekeeping → ClickHouse Internals** toggle (default disabled), never by `CLICKHOUSE_MANAGED_INTERNAL_LOGS` or another env flag. When enabled, a manual Housekeeping run reports a `ClickHouse Internals` category and the five-minute health guard may trim supported system tables over the 256 MiB cap. Enable it only when ClickHouse is dedicated to Gateway.
- The dashboard distinguishes internal-log pressure from structured-log capacity pressure.

## Gateway Logging API and Security

- Public `GET /api/logging/status` was removed because it exposed ClickHouse/logging runtime metadata and was unused by the SDK.
- Frontend reads the logging feature flag from authenticated `GET /api/system/config` as `features.loggingEnabled`; it is not editable through `GeneralSettingsService`.
- Logging ingest endpoints remain publicly accessible with token authentication and are gated by whether logging is enabled.
- Protected logging UI/API routes use path-specific feature gating; unknown `/api/logging/*` routes must not reveal enabled/disabled state.
