---
{
  "id": "5uew5eci",
  "file_name": "5uew5eci_gateway_inference_diagnostics",
  "tags": [
    "diagnostics",
    "inference",
    "mcp",
    "oauth",
    "production"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790761111220,
  "updated_at": 1790766618659
}
---
Diagnosing production Gateway inference (gateway.wiolett.net) from Codex:

- The Gateway remote MCP lives at https://gateway.wiolett.net/api/mcp and accepts only OAuth gwo_ tokens. Register it with `codex mcp add gateway --url https://gateway.wiolett.net/api/mcp` and log in with `codex mcp login gateway --scopes <read-only list>`; without --scopes Codex requests every Gateway scope, including destructive ones. A read-only diagnostic set: nodes:details,nodes:logs,docker:containers:view,docker:compose:view,logs:environments:view,logs:schemas:view,logs:read,inference:providers:view,inference:usage:view,admin:audit,settings:gateway:view.
- A newly added MCP server is not visible in the running Codex session. The token is stored in the OS keyring (service "Codex MCP Credentials", username "gateway|<hash>"), so the endpoint can be called directly with JSON-RPC (tools/list, tools/call) by reading the token inside the script without printing it.
- Gateway backend and inference-core logs are not shipped to Gateway logging (only a "test" environment exists) and Gateway is not a container on a managed node. The useful evidence is `manage_inference_provider` {operation: list_connections} (status, syncLastError, per-connection quota snapshots with fetchedAt/validUntil/stale) and `manage_inference_usage` {operation: activity, status: failed} (per-request connection, model, errorCode, timings; paginate with page). The responses contain user names and emails; aggregate them and do not report raw rows.
- Very fast failed requests (tens of ms) with errorCode provider_capacity_unavailable mean the chosen account failed before reaching the provider and the failover found no usable alternative; the real provider error was hidden before the failover error-reporting fix.
- A core OAuth connection whose quota snapshots stop advancing (fetchedAt frozen, stale) while sync still reports success means the core returned no quota for that account. Gateway writes a snapshot for any non-null core quota, including last-good. For Anthropic in inference-core, a token refresh that fails without an HTTP answer (30 s timeout, connection reset, DNS) keeps the refresh-intent file, and the next refresh attempt marks the account needsReauth permanently (refreshAnthropicAccountWithLock). Only a re-login clears it. The core's per-account OAuth state is not exposed through the Gateway MCP. Gateway sync now fails with a reconnect message when the core reports needsReauth.
