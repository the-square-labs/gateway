---
{
  "id": "jlx77t6m",
  "file_name": "jlx77t6m_proxy_maintenance_access",
  "tags": [
    "gateway",
    "maintenance",
    "operator",
    "proxy",
    "rbac"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1786628623088,
  "updated_at": 1786628623088
}
---
Gateway built-in role contract for proxy maintenance access:
- `OPERATOR_SCOPES` includes `proxy:maintenance:bypass` so operators can issue temporary maintenance access codes.
- The issuance endpoint continues to enforce `proxy:maintenance:bypass:<proxyHostId>` through resource-scoped authorization.
- This grant does not include `proxy:raw:bypass` or `proxy:advanced:bypass`; maintenance access issuance remains narrower than unrestricted proxy configuration bypass.
- Built-in group scopes are synchronized on Gateway bootstrap, so existing built-in operator groups receive the grant after upgrade/restart.
