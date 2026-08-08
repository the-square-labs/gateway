---
{
  "id": "3fym4ikf",
  "file_name": "3fym4ikf_websocket_origin_boundary",
  "tags": [
    "authentication",
    "origin",
    "security",
    "websocket"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786190863596,
  "updated_at": 1786190863596
}
---
Gateway WebSocket cookie-authentication must not trust localhost or local-interface hosts as an Origin class. In production, accept the canonical public APP_URL origin, or for direct domainless Gateway access only the exact origin of the WebSocket target as resolved from the upgrade request (same scheme, host, and port). This preserves a UI served directly from a localhost/LAN Gateway while rejecting a page on the same machine/IP at another port, such as http://192.168.50.10:7777 opening ws://192.168.50.10:3000. Bearer Authorization credentials remain independent of this cookie-Origin predicate. The enforcement helper and regression coverage are in packages/backend/src/app.ts and packages/backend/src/app.host-guard.test.ts.
