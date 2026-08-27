---
{
  "id": "412x4uua",
  "file_name": "412x4uua_gateway_api_client",
  "tags": [
    "api-client",
    "frontend",
    "gateway",
    "refactor",
    "tests-first"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1781991270180,
  "updated_at": 1787862600845
}
---
In the Gateway repository, the oversized frontend ApiClient can be safely split by first adding contract tests against packages/frontend/src/services/api.ts, then extracting domain methods into mixin modules. The first successful batch moved proxy, database/Postgres/Redis, and Docker methods into packages/frontend/src/services/api-proxy.ts, api-databases.ts, and api-docker.ts, composed with withProxyApi/withDatabaseApi/withDockerApi so the exported api singleton stays unchanged. Verification sequence that passed: pnpm --filter frontend test -- src/services/api.test.ts src/services/api-base.test.ts src/services/event-stream.test.ts; pnpm --filter frontend exec tsc -p tsconfig.json; pnpm --filter frontend lint; pnpm --filter frontend build; git diff --check.
