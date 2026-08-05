---
{
  "id": "h8y5ou2d",
  "file_name": "h8y5ou2d_find_resource_extraction",
  "tags": [
    "ai-service",
    "backend",
    "gateway",
    "refactor",
    "resource-search"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1781992344550,
  "updated_at": 1781992344550
}
---
Project: gateway (monorepo) - relocate find_resource implementation from ai.service.ts to ai.resource-search.ts as part of a refactor.

Files:
- moved implementation to packages/backend/src/modules/ai/ai.resource-search.ts
- tests updated: packages/backend/src/modules/ai/ai.service-resource-search.test.ts continues to validate via the public executeTool path

Key behaviors preserved (contracts):
- Empty query returns tool error: 'query is required'
- Proxy searches delegate to list_proxy_hosts with clamped limit; skip extra matching when service search is used
- Docker resource search discovers allowed docker node IDs from resource-scoped grants and delegates per node via executeToolInternal

Verification performed:
- AI resource-search helper/web-search tests
- mcp-ai-audit.test.ts
- Backend typecheck
- Backend lint
- git diff --check
