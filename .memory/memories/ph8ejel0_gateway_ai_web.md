---
{
  "id": "ph8ejel0",
  "file_name": "ph8ejel0_gateway_ai_web",
  "tags": [
    "ai-service",
    "backend",
    "gateway",
    "refactor",
    "web-search"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1781991928525,
  "updated_at": 1781991928525
}
---
In /Users/knownout/Projects/wiolett/gateway, packages/backend/src/modules/ai/ai.service.ts web_search behavior is now covered by packages/backend/src/modules/ai/ai.service-web-search.test.ts through the public executeTool path. The implementation was extracted to packages/backend/src/modules/ai/ai.web-search.ts. Important preserved contracts: Tavily sends api_key in the JSON body with search_depth basic, not as an Authorization header; SearXNG URL is /search?q=...&format=json&pageno=1 without categories; missing non-SearXNG credentials return result.error 'Web search is not configured. An admin must set up the web search API key.' rather than a thrown error. Verification passed with backend web-search/helper/MCP tests, typecheck, lint, and git diff --check.
