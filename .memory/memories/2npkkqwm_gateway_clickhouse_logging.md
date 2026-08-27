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
  "updated_at": 1787862239438
}
---
## Gateway ClickHouse Logging

- `CLICKHOUSE_DATABASE` must match `^[A-Za-z_][A-Za-z0-9_]*$`; reject hyphenated database names.
- Gateway structured logs use an authenticated MergeTree table in the configured database.

## Retention and maintenance

- Structured-log retention is configured per logging environment in **Logs → environment → Settings → Ingest → Retention days**. It accepts 1–365 days and defaults to 30.
- Retention is written into each row as `RetentionDays`; the table TTL is `TimestampTime + toIntervalDay(RetentionDays)`. Updating an environment changes future ingested rows only.
- Housekeeping row/size caps are separate from TTL. Cleanup removes complete oldest daily partitions while preserving the newest partition.
- ClickHouse internal system-log cleanup is controlled only by the persisted **Settings → Housekeeping → ClickHouse Internals** toggle, default disabled. When enabled, manual housekeeping reports a dedicated category and the health guard may trim supported system tables over the configured cap. Enable it only for a Gateway-dedicated ClickHouse instance.
- The dashboard distinguishes internal-system-log pressure from structured-log capacity pressure.

## Gateway Logging API and security

- Public `GET /api/logging/status` must remain absent because it exposes runtime metadata and is unused by the SDK.
- Frontend reads the logging feature flag from authenticated `GET /api/system/config` as `features.loggingEnabled`; it is not editable through `GeneralSettingsService`.
- Logging ingest endpoints remain publicly reachable only with token authentication and are gated by logging enablement.
- Protected logging UI/API routes use path-specific feature gating; unknown `/api/logging/*` routes must not disclose enabled/disabled state.
