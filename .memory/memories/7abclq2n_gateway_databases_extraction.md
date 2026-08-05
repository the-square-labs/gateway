---
{
  "id": "7abclq2n",
  "file_name": "7abclq2n_gateway_databases_extraction",
  "tags": [
    "clickhouse",
    "connection-form",
    "databases",
    "gateway",
    "postgresql",
    "sql-adapter",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.86,
  "importance": 0.9,
  "created_at": 1782003066839,
  "updated_at": 1785537765392
}
---
Repository: /Users/knownout/Projects/wiolett/gateway
Primary orchestration entrypoint: packages/backend/src/modules/databases/databases.service.ts

Safe extraction boundaries and ownership:
- DatabaseConnectionService keeps audit logging, event emission, refresh-after-write orchestration, and connection/client lifecycle unless separately covered.
- postgres-column-operations.ts owns PostgreSQL column normalization/type lookup/base-table guards.
- redis-key-operations.ts owns Redis key scan/read/write shaping and multi-write branching.
- sql-database-adapter.ts is the neutral SQL contract; postgres-sql-adapter.ts preserves PostgreSQL behavior; clickhouse-sql-adapter.ts implements ClickHouse catalog/query behavior.
- Provider-specific connection normalization/client construction lives outside the service; ClickHouse uses clickhouse-connection.ts.

SQL connector contract:
- Neutral endpoints live under /databases/{id}/sql/* while legacy PostgreSQL and Redis endpoints remain supported.
- Expose capabilities rather than assuming uniform mutation support. ClickHouse Explorer is read-only; SQL Console writes remain gated by read/write/admin query scopes.
- ClickHouse uses the official HTTP(S) client. A connection-string URL is authoritative for protocol/host/port.
- Catalog/query paths are bounded: identifier quoting, parameterized values, statement/row/byte/time limits, query IDs, and statistics.
- ClickHouse client settings use mixed types: numeric max_execution_time, string readonly '1', string max_result_rows, numeric cancel_http_readonly_queries_on_client_close.
- Do not add ClickHouse to AI/MCP database tools without a separate design.

Database connection form contract:
- Present Connection method as a required select with Credentials chosen by default and Connection URI as the alternative.
- Never show or submit both methods together. URI mode submits only connectionString; credentials mode submits only provider-specific host/port/database-or-DB-index/username/password/TLS fields.
- Clear provider-specific connection values when database type changes to prevent stale credentials or URI reuse across providers.
- Disable Create until name and the active connection method are complete and valid. Validate provider URI protocol/details, port range, and Redis DB range.
- Match existing inference/alert conditional-field motion: wrap dialog body in shared AnimatedHeight; use AnimatePresence initial=false mode=popLayout with the existing 0.2s reveal transition; place relative overflow-hidden around the presence region so the outgoing taller block cannot escape the modal while height shrinks.
- Verify both methods at desktop and 390x844, including disabled/enabled Create states and the live transition.

Verification sequence:
1. Targeted adapter/service/API/UI tests.
2. Full backend/frontend suites when the boundary warrants it.
3. Backend/frontend typecheck and build.
4. Biome and git diff --check.
5. Migration checks/apply and live disposable ClickHouse smoke for connector work.
6. Browser visual QA at desktop and narrow mobile widths.
