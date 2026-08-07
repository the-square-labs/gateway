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
  "updated_at": 1786048312367
}
---
Gateway MCP extended compatibility is opt-out: when `mcp:extended_compatibility` has no persisted value, McpSettingsService and the Settings UI treat it as `true`. A stored `false` remains an explicit administrator choice. The setting eagerly returns OAuth-scoped tools in the initial `tools/list`; disable it only for harnesses that inject every tool schema into context and exhaust it, because disabling can leave such a harness unable to use some Gateway tools. Keep the Settings description, Gateway Assistant documentation, and `update_gateway_settings` tool description synchronized with that contract.

For Gateway Inference harness setup, the embedded Assistant must read internal inference documentation first. If `get_gateway_settings` is available, it must call it and report `generalSettings.features.inferenceEnabled` and `generalSettings.inference.harnessSpecificEndpointsEnabled` before giving harness setup instructions. Without `settings:gateway:view`, it must not guess those global states and should tell the user an administrator must confirm them. Keep the system prompt, inference docs, `get_gateway_settings` description, and service/system-prompt/docs tests aligned.
