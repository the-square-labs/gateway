---
{
  "id": "xg6y81q3",
  "file_name": "xg6y81q3_gateway_mcp_scope",
  "tags": [
    "compatibility",
    "gateway",
    "list-changed",
    "mcp",
    "oauth",
    "tool-discovery"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1780944066594,
  "updated_at": 1785404288135
}
---
Gateway assistant/MCP tool exposure and discovery contract:
- AI_TOOLS is the shared definition registry. The embedded assistant uses the current user's Gateway scopes; remote MCP lists and executes eligible definitions through the MCP OAuth token's delegated scopes.
- Assistant-only coordination tools use AIToolDefinition.exposure = "assistant". MCP eligibility is filtered centrally by isEligibleMcpTool; do not special-case assistant-only tools into MCP always-visible lists.
- Aggregate manage_* tools may be visible when the actor has any related delegated scope, but AIService must enforce the exact operation-specific scope before calling the service. Database query tools additionally require direct databases:view for the same database before read/write/admin query scopes are useful.
- discover_tools activation is keyed by authentication type, token id/prefix, and OAuth client id, never by arbitrary client-provided MCP session ids. The same client may use multiple transport sessions; different clients must remain isolated.
- Gateway declares tools.listChanged and, after a real toolset activation, sends notifications/tools/list_changed on the related Streamable HTTP response. With @modelcontextprotocol/sdk 1.29, enableJsonResponse:true drops related notifications because JSON mode only resolves result/error messages; Gateway must use SSE response mode and extra.sendNotification for this path.
- MCP setting mcp:extended_compatibility is global and defaults false. When false, tools/list exposes the core inventory plus discover_tools, and newly activated toolsets are ordered first in paginated results. When true, tools/list omits discover_tools and immediately returns every MCP-eligible tool allowed by the OAuth token scopes. Call authorization and operation-specific scope checks remain unchanged.
- Extended compatibility is administrator-controlled through Settings > Gateway > OAuth and MCP access and the existing get_gateway_settings/update_gateway_settings contracts. There is no User-Agent-based Codex special case. Enable it for Codex or any client that does not refresh on tools/list_changed. Clients that already cached their initial catalog still need a new MCP connection after the toggle changes.
- Regression coverage must include MCP list/call scope filtering, cross-session same-client sharing, different-client isolation, SSE tools/list_changed after discover_tools, default-off discovery behavior, extended compatibility eager listing without discover_tools, settings persistence/API projection, and the frontend toggle.
