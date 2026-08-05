---
{
  "id": "3b6g7z3k",
  "file_name": "3b6g7z3k_gateway_database_viewer",
  "tags": [
    "backend",
    "database",
    "frontend",
    "gateway",
    "postgres",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.66,
  "importance": 0.66,
  "created_at": 1781735109831,
  "updated_at": 1784761775061
}
---
Gateway PostgreSQL viewer contract:
- Row edits must not rely on frontend-only coercion. The backend must cast insert/update/delete parameters by column metadata, including numeric, date, timestamp, JSON, and USER-DEFINED enum types using the correct schema/name.
- Send only changed-column deltas for edits; do not rewrite a whole row from the original frontend clone.
- Map only user-actionable PostgreSQL query failures (constraint, type, invalid input, and similar client-correctable errors) to AppError 400 / DATABASE_QUERY_FAILED with a useful message.
- Do not blanket-map every driver error carrying SQLSTATE or metadata to 400. Operational failures such as shutdowns or server-side availability problems must remain higher-level/server errors.
- Verify frontend row-edit behavior, backend service tests for casts/deltas/error classification, frontend/backend lint and typecheck, and git diff --check.
