import { describe, expect, it } from "vitest";
import { type FolderOption, folderFamilyForScope } from "@/components/common/scope-list-helpers";
import {
  API_TOKEN_SCOPES,
  FOLDER_SCOPABLE_SCOPES,
  GROUP_ASSIGNABLE_SCOPES,
  RESOURCE_SCOPABLE_SCOPES,
  TOKEN_SCOPES,
} from "@/types";
import { FOLDER_CREATION_SCOPES, GIT_TARGET_SCOPES } from "@/types/scope-resource-restrictions";
import {
  BUILTIN_GROUPS,
  OPERATOR_SCOPES,
  VIEWER_SCOPES,
} from "../../../../backend/src/lib/scopes-builtins";
import {
  ACCESS_ROLES,
  ACCESS_TYPES,
  type AccessContext,
  type AccessLine,
  accessTypeScopes,
  boundAccessScopes,
  describeLine,
  GIT_LEVELS,
  gitLevelScopes,
  lineScopes,
  linesToScopes,
  narrowedNote,
  scopesToLines,
} from "./access-model";

const CONNECTOR = "0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c01";
const OTHER_CONNECTOR = "0b8f2a8e-6f1c-4a57-9a51-3f9d7f1b2c02";

/** Folder `billing` exists in every tree but Domains; `orders/staging` only for containers. */
function folders(): FolderOption[] {
  const families = ACCESS_TYPES.map((type) => type.family).filter((family) => family !== "domains");
  return [
    ...families.map((family) => ({
      id: `${family}-orders`,
      label: "orders",
      family,
      ancestorIds: [],
    })),
    ...families.map((family) => ({
      id: `${family}-billing`,
      label: "billing",
      family,
      ancestorIds: [],
    })),
    {
      id: "docker-orders-staging",
      label: "orders/staging",
      family: "docker",
      ancestorIds: ["docker-orders"],
    },
    { id: "domains-orders", label: "orders", family: "domains", ancestorIds: [] },
  ];
}

const ctx: AccessContext = { folders: folders() };
const ALL_TYPES = ACCESS_TYPES.map((type) => type.id);
const sorted = (scopes: readonly string[]) => [...new Set(scopes)].sort();

describe("access roles and types", () => {
  const catalog = new Set<string>(TOKEN_SCOPES.map((scope) => scope.value));
  const groupAssignable = new Set<string>(GROUP_ASSIGNABLE_SCOPES.map((scope) => scope.value));
  const tokenAssignable = new Set<string>(API_TOKEN_SCOPES.map((scope) => scope.value));
  const folderScopable = new Set<string>(FOLDER_SCOPABLE_SCOPES);
  const resourceScopable = new Set<string>(RESOURCE_SCOPABLE_SCOPES);
  const creation = new Set<string>(FOLDER_CREATION_SCOPES);

  it("names only catalog scopes that groups and tokens can be given, in the type's folder tree", () => {
    for (const type of ACCESS_TYPES) {
      for (const scope of accessTypeScopes(type)) {
        expect(catalog.has(scope), scope).toBe(true);
        expect(groupAssignable.has(scope), scope).toBe(true);
        expect(tokenAssignable.has(scope), scope).toBe(true);
        expect(folderScopable.has(scope), scope).toBe(true);
        expect(folderFamilyForScope(scope), scope).toBe(type.family);
        if (!creation.has(scope)) expect(resourceScopable.has(scope), scope).toBe(true);
      }
    }
    for (const provider of ["gitlab", "github", "git"] as const) {
      for (const scope of gitLevelScopes(provider, "write")) {
        expect((GIT_TARGET_SCOPES as readonly string[]).includes(scope), scope).toBe(true);
        expect(groupAssignable.has(scope) && tokenAssignable.has(scope), scope).toBe(true);
      }
    }
  });

  it("gives each scope to one type", () => {
    const owners = new Map<string, string>();
    for (const type of ACCESS_TYPES) {
      for (const scope of accessTypeScopes(type)) {
        expect(owners.get(scope) ?? type.id, scope).toBe(type.id);
        owners.set(scope, type.id);
      }
    }
  });

  it("matches the built-in viewer and operator groups type by type", () => {
    for (const type of ACCESS_TYPES) {
      const own = accessTypeScopes(type).filter((scope) => !type.delete.includes(scope));
      expect(sorted(type.roles.viewer), type.id).toEqual(
        sorted(own.filter((s) => VIEWER_SCOPES.includes(s)))
      );
      expect(sorted(type.roles.operator), type.id).toEqual(
        sorted(own.filter((s) => OPERATOR_SCOPES.includes(s)))
      );
    }
  });

  it("orders Git levels from Use to Edit code and CI", () => {
    expect(GIT_LEVELS.map((level) => level.value)).toEqual(["use", "read", "write"]);
    expect(gitLevelScopes("gitlab", "read")).toEqual([
      "integrations:gitlab:view",
      "integrations:gitlab:use",
      "integrations:gitlab:repo:read",
    ]);
  });
});

describe("lines and scopes", () => {
  const canonical: AccessLine[] = [
    {
      kind: "resources",
      role: "viewer",
      types: ALL_TYPES,
      where: { kind: "everywhere" },
      mayDelete: false,
    },
    {
      kind: "resources",
      role: "developer",
      types: ALL_TYPES.filter((type) => type !== "domains"),
      where: { kind: "folder", path: "billing" },
      mayDelete: true,
    },
    {
      kind: "resources",
      role: "operator",
      types: ["containers"],
      where: { kind: "folder", path: "orders/staging" },
      mayDelete: false,
    },
    {
      kind: "resources",
      role: "deployer",
      types: ["containers", "pages"],
      where: {
        kind: "resources",
        ids: { containers: ["node-1/api", "node-1/web"], pages: ["site-1"] },
      },
      mayDelete: false,
    },
    {
      kind: "git",
      provider: "gitlab",
      connectorId: CONNECTOR,
      repositories: { kind: "group", id: "42" },
      level: "write",
    },
    {
      kind: "git",
      provider: "github",
      connectorId: OTHER_CONNECTOR,
      repositories: { kind: "some", ids: ["7", "9"] },
      level: "use",
    },
    {
      kind: "git",
      provider: "git",
      connectorId: null,
      repositories: { kind: "all" },
      level: "read",
    },
    { kind: "custom", scopes: ["admin:audit", "nodes:details"] },
  ];

  it("builds plain and qualified scopes", () => {
    const scopes = linesToScopes(canonical, ctx);
    expect(scopes).toContain("docker:containers:view");
    expect(scopes).toContain("docker:containers:create:folder/docker-billing");
    expect(scopes).toContain("docker:containers:delete:folder/docker-billing");
    expect(scopes).toContain("docker:containers:secrets:folder/docker-orders-staging");
    expect(scopes).toContain("docker:containers:manage:node-1/api");
    expect(scopes).toContain("pages:deploy:site-1");
    expect(scopes).toContain(`integrations:gitlab:repo:write:${CONNECTOR}/group/42`);
    expect(scopes).toContain(`integrations:github:use:${OTHER_CONNECTOR}/repo/9`);
    expect(scopes).toContain("integrations:git:repo:read");
    // Creation names a destination, never a resource.
    expect(scopes.some((scope) => scope.startsWith("docker:containers:create:node-1/"))).toBe(
      false
    );
  });

  it("parses its own scopes back into the same lines", () => {
    expect(scopesToLines(linesToScopes(canonical, ctx), ctx)).toEqual(canonical);
  });

  it("parses every built-in group without losing a scope", () => {
    for (const group of BUILTIN_GROUPS) {
      const lines = scopesToLines(group.scopes, ctx);
      expect(linesToScopes(lines, ctx), group.name).toEqual(sorted(group.scopes));
    }
    const operator = scopesToLines(OPERATOR_SCOPES, ctx);
    expect(describeLine(operator[0]!).title).toBe("Operator everywhere");
    expect(describeLine(scopesToLines(VIEWER_SCOPES, ctx)[0]!)).toEqual({
      title: "Viewer everywhere",
      detail: "All 8 resource types",
    });
  });

  it("parses arbitrary scope sets without loss, the same way every time", () => {
    const pool = [
      ...TOKEN_SCOPES.map((scope) => scope.value),
      ...ACCESS_TYPES.flatMap((type) =>
        accessTypeScopes(type).flatMap((scope) => [
          `${scope}:folder/${type.family}-orders`,
          `${scope}:folder/${type.family}-missing`,
          `${scope}:node-1/api`,
        ])
      ),
      `integrations:gitlab:use:${CONNECTOR}`,
      `integrations:gitlab:view:${CONNECTOR}`,
      `integrations:gitlab:view:${CONNECTOR}/project/5`,
      `integrations:gitlab:use:${CONNECTOR}/project/5`,
    ];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round += 1) {
      const scopes = pool.filter(() => random() < 0.3);
      const lines = scopesToLines(scopes, ctx);
      expect(linesToScopes(lines, ctx)).toEqual(sorted(scopes));
      expect(scopesToLines([...scopes].reverse(), ctx)).toEqual(lines);
    }
  });

  it("leaves out types without the folder and reads them as such", () => {
    const line: AccessLine = {
      kind: "resources",
      role: "viewer",
      types: ALL_TYPES,
      where: { kind: "folder", path: "billing" },
      mayDelete: false,
    };
    expect(lineScopes(line, ctx).some((scope) => scope.startsWith("domains:"))).toBe(false);
    expect(describeLine(scopesToLines(lineScopes(line, ctx), ctx)[0]!)).toEqual({
      title: "Viewer in folder billing",
      detail:
        "Containers and deployments, Compose projects, routes, SSL certificates, databases, object storage, Pages",
    });
  });

  it("names roles, places and Git targets", () => {
    const labels = {
      resource: (_type: string, id: string) => (id === "node-1/api" ? "orders-api" : undefined),
      connector: () => "gitlab.wiolett.net",
      gitTarget: () => "square-labs/orders",
    };
    expect(describeLine(canonical[2]!, labels)).toEqual({
      title: "Operator in folder orders / staging",
      detail: "Containers and deployments",
    });
    expect(describeLine(canonical[3]!, labels).title).toBe("Deployer on 3 resources");
    expect(describeLine(canonical[4]!, labels)).toEqual({
      title: "Edit code and CI in group square-labs/orders",
      detail: "GitLab · gitlab.wiolett.net",
    });
    expect(describeLine(canonical[6]!).title).toBe("Read code in every repository");
    expect(describeLine(canonical[6]!).detail).toBe("Every Git connector");
  });

  it("offers the four roles", () => {
    expect(ACCESS_ROLES.map((role) => role.title)).toEqual([
      "Viewer",
      "Deployer",
      "Developer",
      "Operator",
    ]);
  });
});

describe("token narrowing", () => {
  const developerInBilling: AccessLine = {
    kind: "resources",
    role: "developer",
    types: ["containers"],
    where: { kind: "folder", path: "billing" },
    mayDelete: false,
  };
  const deployerInBilling = lineScopes({ ...developerInBilling, role: "deployer" }, ctx);

  it("says what a line wider than its owner really does", () => {
    expect(narrowedNote(developerInBilling, deployerInBilling, ctx)).toBe(
      "Works as Deployer: you are Deployer in billing"
    );
    expect(
      narrowedNote(developerInBilling, linesToScopes([developerInBilling], ctx), ctx)
    ).toBeNull();
    expect(narrowedNote(developerInBilling, [], ctx)).toBe(
      "Does nothing: you hold none of this access"
    );
  });

  it("counts a folder grant for its subfolders and narrows broad scopes to held resources", () => {
    const staging: AccessLine = {
      ...developerInBilling,
      role: "viewer",
      where: { kind: "folder", path: "orders/staging" },
    };
    expect(narrowedNote(staging, ["docker:containers:view:folder/docker-orders"], ctx)).toBeNull();
    expect(boundAccessScopes(["proxy:view"], ["proxy:edit:route-1"])).toEqual([
      "proxy:view:route-1",
    ]);
  });
});
