---
{
  "id": "z638qk12",
  "file_name": "z638qk12_onboarding_completion",
  "tags": [
    "backend",
    "dashboard",
    "frontend",
    "gateway",
    "onboarding"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786048875275,
  "updated_at": 1786048875275
}
---
Finalize Setup is a terminal per-step checklist, not a dismissible dashboard notice. Its seven raw steps (`nodes`, `ai_assistant`, `inference`, `cloudflare`, `gitlab`, `mfa`, `invite_users`) must all be `configured` or `skipped` before the dashboard card and dashboard attention item disappear. The root Integrations row is only complete when both Cloudflare and GitLab have outcomes; it is `In progress` while either remains pending.

`Skip for now` closes the modal without changing step outcomes. The first use shows a warning and persists `skipPromptShownAt`; subsequent skips close without another warning. `Finish` is available only after every raw step has an outcome and only closes the modal. Version-1 legacy `dismissedAt` states must be normalized to visible incomplete checklists with their skip warning already acknowledged. The post-onboarding MFA reminder is eligible only after the checklist is complete and MFA was skipped. Keep backend service/API, monitoring attention, Dashboard card gating, and dialog behavior/tests synchronized.
