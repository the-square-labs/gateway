---
{
  "id": "vrru6m60",
  "file_name": "vrru6m60_session_cookie_migration",
  "tags": [
    "auth",
    "backward-compatibility",
    "cookies",
    "http",
    "https"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785917497779,
  "updated_at": 1785917497779
}
---
Gateway browser session cookies must use separate, installation-namespaced names for HTTP and HTTPS. A browser cannot overwrite a pre-existing Secure cookie with an HTTP Set-Cookie of the same name, which otherwise causes successful login followed by /auth/me 401 after switching an installation from internal HTTPS to HTTP. Derive a short namespace from the persistent per-install PKI master key, write the name matching the configured public URL transport, accept both new names plus legacy session_id during migration, and apply the same lookup to browser WebSocket auth. Preserve legacy cookie support for upgrade compatibility.
