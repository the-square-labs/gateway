---
{
  "id": "gpx2fdwu",
  "file_name": "gpx2fdwu_mcp_compatibility",
  "tags": [
    "assistant",
    "compatibility",
    "gateway",
    "inference",
    "mcp",
    "settings"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786047219057,
  "updated_at": 1787862560463
}
---
Gateway MCP extended compatibility is opt-out: when `mcp:extended_compatibility` has no persisted value, services and Settings treat it as enabled. A stored `false` remains an explicit administrator choice. The setting eagerly returns OAuth-scoped tools in the initial `tools/list`; disable it only for harnesses that inject every schema into context, because disabling can prevent those clients from discovering later tools. Keep Settings copy, Assistant documentation, and the `update_gateway_settings` tool description synchronized.

For Gateway Inference setup, the embedded Assistant reads internal inference documentation first. If `get_gateway_settings` is available, it reports whether `generalSettings.features.inferenceEnabled` is enabled before giving setup instructions. Without `settings:gateway:view`, it must not guess installation state and should tell the user an administrator must confirm it. Setup guidance uses `@sqgateway/inference`, discovery, and the single stable `/api/inference/v1` contract; do not reference removed harness-specific endpoint toggles.
