---
{
  "id": "dulrcn1x",
  "file_name": "dulrcn1x_localhost_auth_recovery",
  "tags": [
    "ai-workspace",
    "authentication",
    "cookies",
    "docker",
    "local-dev",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786619223641,
  "updated_at": 1786619223641
}
---
Gateway localhost auth recovery: session-cookie selection must prefer the namespaced cookie matching the current request transport before the other transport cookie. Apply the same ordering in both HTTP auth middleware and WebSocket auth; otherwise REST may authenticate while AI Workspace WebSocket returns `Invalid or expired session`. On loopback password login, also emit the legacy `session_id` compatibility cookie. Verify with (1) login then `/auth/me`, (2) a request containing stale HTTPS plus fresh HTTP cookies, and (3) a real browser reload showing an enabled AI composer. For the preserved local stand, reuse compose project `gateway-upgrade-e2e` and its Postgres/Redis/gateway volumes; the last verified services were app, postgres, and redis healthy on localhost:3000.
