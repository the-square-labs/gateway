---
{
  "id": "dcfkgqwx",
  "file_name": "dcfkgqwx_accounting_gateway_inference",
  "tags": [
    "accounting",
    "gateway",
    "inference",
    "limits",
    "quota"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1784934085269,
  "updated_at": 1788310972296
}
---
# Gateway inference product contract

Gateway Inference is a standalone bounded context with the OpenAI-compatible `/api/inference/v1` data plane, dedicated `gwi_` tokens, and isolated provider/runtime credentials. Gateway owns authentication, provider/model configuration, limits, pricing, accounting, routing, and quota UX.

## User limit windows

- Subscription limits use independent fixed 5-hour, 7-day, and 30-day windows. They are not sliding or continuously repeating buckets.
- A configured subscription window starts lazily on the user's first subscription-backed inference admission when no active window exists. It ends exactly one configured duration after that admission.
- At the boundary, the whole window expires and usage becomes zero. No next window is created by time, status reads, dashboard refresh, or polling; the next subscription-backed request starts it.
- Manual administrator reset closes subscription windows and leaves them idle until the user's next subscription-backed request. It does not delete immutable request or ledger history.
- The monthly API budget remains calendar/anchor based and keeps its existing reset semantics.
- Subscription settlements are attributed to the admission/start time, so a long request that finishes after a boundary remains charged to the window where it began.
- Redis live reservations are scoped to the concrete window identity; reservations admitted in an expired window must not reduce capacity in the next lazily started window.
- Usage remains monotonic while a fixed window is active. Frontend inference usage snapshots carry a measurement time, and consumers reject older dashboard/bootstrap snapshots so stale responses cannot roll displayed usage backward.

## Established accounting safety

- Admission uses transaction-scoped PostgreSQL advisory locks per user plus Redis reservations.
- Durable request/accounting records and frozen pricing/multiplier snapshots remain authoritative.
- Disabled subscription dimensions may still measure usage but do not constrain admission; all three disabled means unlimited subscription usage.
- The final 5 percent of each subscription limit is protected for recovery/compaction, with the existing bounded final-request grace.
- Quota-exhausted UX uses the latest recovery time among blocking active windows.

## UI behavior

- Active windows show remaining percentage and recovery time.
- Expired/idle configured subscription windows show zero usage and `Starts on next use`, not a fabricated future reset countdown.
- One shared live usage snapshot is used across profile/account menu/dashboard/composer surfaces.
