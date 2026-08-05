---
{
  "id": "qme9z5oh",
  "file_name": "qme9z5oh_state_machine_gotchas",
  "tags": [
    "ai-chat",
    "gateway",
    "production-readiness",
    "providers",
    "recovery",
    "snapshots",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1783631313911,
  "updated_at": 1783631313911
}
---
Gateway AI chat runtime production-readiness gotchas confirmed on 2026-07-09: conversation snapshots have no global monotonic revision, backend publishes multiple unawaited snapshot fetches per conversation, and frontend applies every active-conversation snapshot while version-protecting only assistant draft text. A late old snapshot can therefore regress message/tool/wait/run/thinking state and tool grouping; remediation needs a durable conversation revision, consistent snapshot assembly, serialized/coalesced publication, and client rejection of non-newer revisions. Active AI execution and live drafts are process-local with no startup reconciler/lease, so restart can strand queued/running runs and an active compaction cannot be stopped through the API. Approval/final-answer DB commits are separate from continuation scheduling; duplicate retries do not re-enqueue. Provider adapters must require explicit successful terminal states: current Responses failed/incomplete/error and Chat finish_reason length can normalize as success. Verification must include concurrency ordering, restart/fault injection, mixed question+approval tool rounds, both provider modes, and authenticated browser parity for Default side panel and Lite.
