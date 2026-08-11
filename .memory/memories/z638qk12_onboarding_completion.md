---
{
  "id": "z638qk12",
  "file_name": "z638qk12_onboarding_completion",
  "tags": [
    "ai-workspace",
    "browser-setup",
    "finalize-setup",
    "navigation",
    "onboarding",
    "sessions"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.97,
  "created_at": 1786048875275,
  "updated_at": 1786405031216
}
---
## Onboarding Checklist

- **Finalize Setup** is a terminal per-step checklist, not a dismissible dashboard notice.
- Version 3 has six raw steps: `nodes`, `ai_workspace`, `cloudflare`, `gitlab`, `mfa`, and `invite_users`. Gateway Inference is nested inside the shared AI Workspace configuration flow and is not a root checklist step.
- Normalize version 1 and 2 state by mapping legacy `ai_assistant` into `ai_workspace`; the old `inference` step no longer gates completion.
- The root **Integrations** row is complete only when both Cloudflare and GitLab have outcomes; otherwise it is `In progress`.
- `Skip for now` closes the modal without changing outcomes. First use shows the existing warning; later skips close directly.
- `Finish` is available only after all raw steps have outcomes and only closes the modal.
- Show the post-onboarding MFA reminder only when the checklist is complete and MFA was skipped.
- Keep backend service/API, monitoring attention, Dashboard card gating, dialog behavior, and tests synchronized.

## Browser Setup and Shared AI Workspace Configuration

- Browser Setup applies core Gateway configuration first and persists phase `ai_workspace`; installation is not marked complete until the user configures or explicitly skips AI Workspace.
- The same `ConfigureAIWorkspaceWizard` composition is reused by Browser Setup, Finalize Setup, the installation-owner interface chooser, and the persistent sidebar CTA. It connects either an OAI-compatible provider or Gateway Inference; Inference is nested and shown only when the caller has all required management scopes.
- Browser Setup exchanges its setup cookie for a bounded, purpose=`setup` session for the existing Gateway System user. That session is tied to the active setup-session id, never refreshed, omitted from public session lists, restricted to the exact AI/Inference/Auth settings endpoints required by the flow, and revoked when setup completes.
- Keep `/api/ai/status` in the setup-purpose allowlist: the shared wizard refreshes provider state after saving, and omitting it makes a successful provider write appear to fail.
- A configured Browser Setup outcome marks Finalize Setup `ai_workspace` configured. A skipped outcome leaves it pending so the owner can complete it later.

## Interface Choice and Navigation

- Persist `preferredInterface` per user as `ai_workspace` or `operations_console`, with a server timestamp. Clear local preference state while a different user's backend preference loads.
- The installation owner must choose on the first login even when AI Workspace is not configured; choosing AI Workspace opens the shared configuration flow and saves the preference only after successful setup.
- Other users see the non-dismissible chooser only when AI Workspace is configured and they have `feat:ai:use`.
- The sidebar AI Workspace CTA is always visible and cannot be disabled in Profile. If unconfigured, ordinary users see an administrator-needed message; callers with `feat:ai:configure` see the same information plus a configure CTA.
- Product terms are **AI Workspace**, **Operations Console**, and **Work Session**. AI Workspace is recommended and intent-driven, while Operations Console remains complete without AI.
- AI resource references carry a backend-issued canonical `uiHref` and `workspaceEmbeddable`. The primary link opens the page inside AI Workspace. The secondary action opens the same route in Operations Console with the AI side panel and the same active Work Session. Never derive a new Gateway route from model text.
- Operations Console shows resolved page/resource context above the composer. The user may exclude the resource from the next request; route context remains, and the resource context returns afterward.

## Gateway and Dialog Behavior

- Gateway-controlled follow-up dialogs must retain outgoing payload data after `open` becomes false until the shared CSS exit animation completes: 250 ms mobile and 200 ms desktop.
- Clear the old payload only after that delay, then open the next dialog. This prevents QR codes or secrets disappearing during the closing animation.

## Gateway Conversation State

- AI Work Session terminal state is represented by hidden assistant messages with `conversationStatus: "ended"` or `"context_blocked"`, plus `blockReason` when applicable.
- Do not model this through `ai_conversations` columns. Persist runtime markers and derive snapshots from UI messages.
- Frontend normalization must preserve `conversationStatus` and `blockReason`, or synthesize a marker from `conversation.status`.
- `startUserRun` must reject new user turns when a recent marker indicates the Work Session is ended or context-blocked.

## API Error Handling

- Standardize backend errors as `{ code, message }` using `AppError`; preserve compatibility with legacy `{ error: string }`.
- `ApiClientBase` falls back to `error` when `message` is missing or blank.
- Docker daemon dispatch errors prefer non-empty `error`, then `detail`, then a fallback message. Empty daemon responses must never produce blank UI toasts.

## Safe Gateway Refactoring

- Add behavior tests before extracting orchestration from large detail/service files.
- Useful frontend seams: `docker-detail/mutation-transition.ts`, `docker-detail/useContainerDetailRealtime.ts`, `docker-detail/settings-payload.ts`, `proxy-detail/state.ts`, and `proxy-detail/mutations.ts`.
- Useful backend seams: `database-error-mapping.ts`, `postgres-row-sql.ts`, and `docker-recreate-watch.ts`.
- Re-export moved helpers from original page files when needed to preserve existing tests.
- Verification: targeted frontend/backend tests, scoped Biome, both production builds, and `git diff --check`.

## Gateway First-Run Setup

- First-run setup is controlled by `setup:started_at` and `setup:completed_at`, not by creation of the first real user.
- Backend startup records `setup:started_at` on fresh installs; upgraded already-configured installs are marked complete.
- `/api/setup/*` remains open until the browser wizard completes AI Workspace configured/skipped outcome or the first-start window expires.
- Core apply persists an explicit phase so a reload resumes at AI Workspace rather than replaying setup mutations.
