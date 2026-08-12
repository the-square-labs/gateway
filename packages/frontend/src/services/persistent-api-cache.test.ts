import { isPersistentCacheKey } from "./persistent-api-cache";

describe("persistent API cache allowlist", () => {
  it("persists reviewed read models used by top-level pages", () => {
    expect(isPersistentCacheKey("proxy:grouped")).toBe(true);
    expect(isPersistentCacheKey("req:/api/ui/bootstrap")).toBe(true);
    expect(isPersistentCacheKey("dashboard:bootstrap:user-access-pins")).toBe(true);
    expect(isPersistentCacheKey("nodes:list:default")).toBe(true);
    expect(isPersistentCacheKey("databases:list")).toBe(true);
    expect(isPersistentCacheKey("req:/api/system/relay")).toBe(true);
  });

  it("never persists tokens, credentials, logs, files, or arbitrary GET responses", () => {
    expect(isPersistentCacheKey("settings:api-tokens")).toBe(false);
    expect(isPersistentCacheKey("req:/api/databases/db-1/credentials")).toBe(false);
    expect(isPersistentCacheKey("req:/api/nodes/node-1/logs")).toBe(false);
    expect(isPersistentCacheKey("req:/api/nodes/node-1/files?path=/etc/passwd")).toBe(false);
    expect(isPersistentCacheKey("req:/api/admin/auth-settings")).toBe(false);
  });
});
