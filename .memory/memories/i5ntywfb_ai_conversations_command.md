---
{
  "id": "i5ntywfb",
  "file_name": "i5ntywfb_ai_conversations_command",
  "tags": [
    "ai-conversations",
    "command-palette",
    "frontend",
    "gateway-inference",
    "quota",
    "rolling-window"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785448712405,
  "updated_at": 1785448712405
}
---
Gateway Inference rolling-window `recoveryAt` must be derived from `inference_usage_ledger.occurred_at`, not `now + window`. For an exhausted window, calculate the earliest ledger expiry whose cumulative removal brings usage back below the UI recovery threshold; this prevents a countdown that renews on every poll or promises availability too early. The self-usage cards should show an exact future recovery date and must not use the past-only `formatRelativeDate`, which labels every future date as `Just now`; keep the existing card label/value scale and override only the recovery subtitle from 10px to 12px. Command Palette search state must clear on the dialog content's completed closed animation rather than immediately when `open` becomes false. AI conversation titles must strip hidden `<system-instruction>...</system-instruction>` blocks while preserving the full wrapped message for runtime execution.
