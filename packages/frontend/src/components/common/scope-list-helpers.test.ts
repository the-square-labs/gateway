import { describe, expect, it } from "vitest";
import { RESOURCE_SCOPABLE_SCOPES } from "@/types";
import {
  folderFamilyForScope,
  getResourceLabel,
  getResourceOptions,
  parseScopedSelections,
} from "./scope-list-helpers";

describe("resource restriction mappings", () => {
  it("Pages selects Page Projects and never falls back to CAs", () => {
    const ca = { id: "ca-1", commonName: "Root CA" };
    expect(folderFamilyForScope("pages:view")).toBe("pages");
    expect(getResourceOptions("pages:view", [ca] as never)).toEqual([]);
    expect(
      getResourceOptions("pages:view", [ca] as never, [], [], [], [], [], [], [], [], {
        pages: [{ id: "project-1", label: "Site", folderId: "folder-1" }],
      })
    ).toEqual([{ id: "project-1", label: "Site", folderId: "folder-1" }]);
    expect(getResourceLabel("pages:view")).not.toContain("CAs");
  });

  it.each([
    ["docker:containers:create", "docker"],
    ["docker:networks:delete", "docker-network"],
    ["docker:volumes:create", "docker-volume"],
    ["docker:images:pull", "docker-image"],
    ["docker:compose:create", "docker-compose"],
    ["databases:create", "databases"],
    ["pages:create", "pages"],
    ["ssl:cert:issue", "ssl"],
    ["nodes:create", "nodes"],
  ])("maps %s to its own folders", (scope, family) => {
    expect(folderFamilyForScope(scope)).toBe(family);
  });

  it("creation does not offer existing resources as destination grants", () => {
    expect(
      getResourceOptions("pages:create", [], [], [], [], [], [], [], [], [], {
        pages: [{ id: "project-1", label: "Site" }],
      })
    ).toEqual([]);
  });

  it("roundtrips folder, provider, account and node targets without changing bases", () => {
    const scopes = [
      "databases:create:folder/f1",
      "hosting:resources:create:provider/proxmox",
      "hosting:resources:delete:node/n1",
      "hosting:resources:view:account/a1",
    ];
    const parsed = parseScopedSelections(scopes, RESOURCE_SCOPABLE_SCOPES);
    expect(parsed.resources).toEqual({
      "databases:create": ["folder/f1"],
      "hosting:resources:create": ["provider/proxmox"],
      "hosting:resources:delete": ["node/n1"],
      "hosting:resources:view": ["account/a1"],
    });
  });
});
