---
{
  "id": "18ag0ipp",
  "file_name": "18ag0ipp_relay_lock_latency",
  "tags": [
    "docker-daemon",
    "latency",
    "locking",
    "managed-database",
    "relay"
  ],
  "layer": "lite",
  "ref": "l2g94u2b",
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1790522295535,
  "updated_at": 1790524581516
}
---
[→ l2g94u2b] Relay dials must not take a daemon manager lock: managed DB `stats` (Docker ContainerStats stream=false, ~2 s) held it and delayed every new tunnel
