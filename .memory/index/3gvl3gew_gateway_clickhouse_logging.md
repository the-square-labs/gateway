---
{
  "id": "3gvl3gew",
  "file_name": "3gvl3gew_gateway_clickhouse_logging",
  "tags": [
    "clickhouse",
    "housekeeping",
    "logging",
    "retention"
  ],
  "layer": "lite",
  "ref": "2npkkqwm",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1777399734516,
  "updated_at": 1790812536244
}
---
[→ 2npkkqwm] ## Gateway ClickHouse Logging

- `CLICKHOUSE_DATABASE` must match `^[A-Za-z_][A-Za-z0-9_]*$`; reject hyphenated database names.
- Gateway structured logs use...
