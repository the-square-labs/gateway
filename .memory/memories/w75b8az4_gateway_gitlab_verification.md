---
{
  "id": "w75b8az4",
  "file_name": "w75b8az4_gateway_gitlab_verification",
  "tags": [
    "ai-tools",
    "approval",
    "gateway",
    "gitlab",
    "integrations",
    "redirects",
    "secrets",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.72,
  "importance": 0.8,
  "created_at": 1783125493749,
  "updated_at": 1783631292184
}
---
Gateway GitLab/VCS connector safety contract:
- AI approval UI, runtime tool-call history, saved history, snapshots, audit rows, and MCP-visible data must persist only with display-safe/redacted arguments.
- Raw one-time secrets or raw PAT/deploy-token/variable/webhook values required for approval continuation may exist only in short-lived server-side protected checkpoint state and must be cleared on terminal transitions.
- Do not persist raw secret arguments into ai_run_tool_calls.toolArgs or return them to frontend/MCP.
- The 2026-07-09 production-readiness audit identified bypass-non-destructive and bypass-everything issues: gitlab_set_project_variable.value and gitlab_create_or_update_project_webhook.token can take an immediate path, be stored raw in the runtime ledger, and be returned by snapshots.
- Verification must cover every approval mode and the immediate auto-approved path, not only approval-display/audit redaction.
- The same audit found that native GitLab archive requests forward redirects while transmitting PRIVATE-TOKEN cross-origin and across HTTPS-to-HTTP downgrade; binary redirect handling must strip credentials or fail closed and be tested with two-origin fake-token fixtures.
- Historical DB assessment and token rotation must be evidence-driven; do not claim production secrets were exposed without verifying actual rows/redirect usage.
