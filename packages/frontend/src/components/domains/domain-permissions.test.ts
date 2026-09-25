import { describe, expect, it } from "vitest";
import { getDomainPermissions } from "./domain-permissions";

function permissionsFor(scopes: string[]) {
  return getDomainPermissions((scope) => scopes.includes(scope));
}

describe("domain permissions", () => {
  it("allows Gateway domain actions from their corresponding domains scopes", () => {
    expect(permissionsFor(["domains:create", "domains:edit", "domains:delete"])).toMatchObject({
      canCreateDomain: true,
      canEditDomain: true,
      canDeleteDomain: true,
    });
  });

  it("does not let Cloudflare-only scopes enable Gateway domain actions", () => {
    expect(permissionsFor(["integrations:cloudflare:view"])).toEqual({
      canCreateDomain: false,
      canEditDomain: false,
      canDeleteDomain: false,
      canInspectCloudflare: true,
    });
  });

  it("opens domain creation for folder or node creation grants when scoped access is supplied", () => {
    const scopes = ["domains:create:folder/folder-1"];
    const permissions = getDomainPermissions(
      (scope) => scopes.includes(scope),
      undefined,
      (base) => scopes.some((scope) => scope === base || scope.startsWith(`${base}:`))
    );

    expect(permissions.canCreateDomain).toBe(true);
    expect(permissionsFor(scopes).canCreateDomain).toBe(false);
  });
});
