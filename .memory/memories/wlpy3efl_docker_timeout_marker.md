---
{
  "id": "wlpy3efl",
  "file_name": "wlpy3efl_docker_timeout_marker",
  "tags": [
    "daemon",
    "docker",
    "gotcha",
    "proto3",
    "timeout"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777897421801,
  "updated_at": 1777897421801
}
---
Docker daemon container stop/restart commands use proto3 `timeout_seconds`, which has no presence tracking. Gateway resolves and always sends a timeout, and marks explicit Gateway-provided timeout semantics with `configJson: {"timeoutProvided": true}` so daemon fallback can treat daemon-direct/older omitted `0` as the default while preserving explicit `0` from Gateway as immediate stop.
