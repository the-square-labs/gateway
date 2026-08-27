---
{
  "id": "duvbj7h2",
  "file_name": "duvbj7h2_gateway_ai_tools",
  "tags": [
    "ai-tools",
    "gateway",
    "refactor",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.82,
  "created_at": 1781993057004,
  "updated_at": 1787862658014
}
---
For the Gateway repository, `packages/backend/src/modules/ai/ai.tools.ts` can be safely reduced by moving definition-only category groups into sibling files that export `AIToolDefinition[]` arrays, then spreading them into `AI_TOOLS`. Before moving a category, add/keep contract tests in `ai.tools.test.ts` for tool names, scope visibility, destructive flags, and web-search gating; after moving, run `pnpm --filter backend test -- src/modules/ai/ai.tools.test.ts src/modules/mcp/mcp-ai-audit.test.ts`, `pnpm --filter backend typecheck`, `pnpm --filter backend lint`, `pnpm --filter backend build`, and `git diff --check`.
