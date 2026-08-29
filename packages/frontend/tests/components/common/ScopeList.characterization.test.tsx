import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ScopeItem, ScopeList } from "@/components/common/ScopeList";
import type { Node, ProxyHost } from "@/types";

const apiMocks = vi.hoisted(() => ({
  listDockerContainers: vi.fn(),
  listDockerFolders: vi.fn(),
  listDomainFolders: vi.fn(),
  listDomains: vi.fn(),
  listFolders: vi.fn(),
  listNodeFolders: vi.fn(),
  listDatabaseFolders: vi.fn(),
  listLoggingEnvironmentFolders: vi.fn(),
  listLoggingSchemaFolders: vi.fn(),
  listLoggingEnvironments: vi.fn(),
  listDockerInternalRegistryRepositories: vi.fn(),
}));

vi.mock("@/services/api", () => ({ api: apiMocks }));

function scope(value: string, label: string, desc: string, group: string): ScopeItem {
  return { value, label, desc, group };
}

function checkboxFor(text: string): HTMLInputElement {
  const input = screen.getByText(text).closest("label")?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Expected a checkbox for ${text}`);
  }
  return input;
}

const proxyHosts = [
  {
    id: "route-1",
    domainNames: ["app.example.com"],
    folderId: null,
  },
  {
    id: "route-2",
    domainNames: ["public.example.com"],
    folderId: null,
  },
] as ProxyHost[];

const nodes = [
  {
    id: "docker-node",
    type: "docker",
    hostname: "docker-01",
    displayName: "Docker Node",
  },
  {
    id: "nginx-node",
    type: "nginx",
    hostname: "nginx-01",
    displayName: "Ingress Node",
  },
] as Node[];

beforeEach(() => {
  apiMocks.listDockerContainers.mockReset().mockResolvedValue([]);
  apiMocks.listDockerFolders.mockReset().mockResolvedValue([]);
  apiMocks.listDomainFolders.mockReset().mockResolvedValue([]);
  apiMocks.listDomains.mockReset().mockResolvedValue({ data: [] });
  apiMocks.listFolders.mockReset().mockResolvedValue([]);
  apiMocks.listNodeFolders.mockReset().mockResolvedValue([]);
  apiMocks.listDatabaseFolders.mockReset().mockResolvedValue([]);
  apiMocks.listLoggingEnvironmentFolders.mockReset().mockResolvedValue([]);
  apiMocks.listLoggingSchemaFolders.mockReset().mockResolvedValue([]);
  apiMocks.listLoggingEnvironments.mockReset().mockResolvedValue([]);
  apiMocks.listDockerInternalRegistryRepositories.mockReset().mockResolvedValue([]);
});

describe("ScopeList characterization", () => {
  it("keeps top-level scope state in the checkboxes and reports scope toggles", () => {
    const onToggle = vi.fn();

    render(
      <ScopeList
        scopes={[
          scope("scope:read", "Read access", "Read resources", "Operations"),
          scope("scope:write", "Write access", "Write resources", "Operations"),
        ]}
        search=""
        selected={["scope:read"]}
        onToggle={onToggle}
      />
    );

    expect(checkboxFor("Read access")).toBeChecked();
    const writeCheckbox = checkboxFor("Write access");
    expect(writeCheckbox).not.toBeChecked();

    fireEvent.click(writeCheckbox);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith("scope:write");
  });

  it("treats inherited resource selections as selected for the selection filter", () => {
    const scopes = [
      scope("nodes:details", "Node details", "Read node details", "Nodes"),
      scope("acl:view", "Access lists", "View access lists", "Access Control"),
    ];
    const props = {
      scopes,
      search: "",
      selected: [] as string[],
      onToggle: vi.fn(),
      inheritedScopes: ["nodes:details:node-1"],
      inheritedFromName: "Viewer",
      restrictableScopes: ["nodes:details"],
    };
    const { rerender } = render(<ScopeList {...props} selectionFilter="selected" />);

    expect(screen.getByText("Node details")).toBeInTheDocument();
    expect(screen.queryByText("Access lists")).not.toBeInTheDocument();
    expect(checkboxFor("Node details")).toBeDisabled();
    expect(screen.getByText("inherited from Viewer")).toBeInTheDocument();

    rerender(<ScopeList {...props} selectionFilter="unselected" />);

    expect(screen.queryByText("Node details")).not.toBeInTheDocument();
    expect(screen.getByText("Access lists")).toBeInTheDocument();
  });

  it("searches labels, technical values, and descriptions case-insensitively after trimming", () => {
    const scopes = [
      scope("permissions:alpha", "Alpha access", "Read the alpha resources", "Operations"),
      scope("permissions:beta", "Beta access", "Write the beta resources", "Operations"),
      scope("permissions:gamma", "Gamma access", "Manage the gamma resources", "Operations"),
    ];
    const { rerender } = render(
      <ScopeList scopes={scopes} search="  ALPHA ACCESS  " selected={[]} onToggle={vi.fn()} />
    );

    expect(screen.getByText("Alpha access")).toBeInTheDocument();
    expect(screen.queryByText("Beta access")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma access")).not.toBeInTheDocument();

    rerender(
      <ScopeList scopes={scopes} search="PERMISSIONS:BETA" selected={[]} onToggle={vi.fn()} />
    );
    expect(screen.getByText("Beta access")).toBeInTheDocument();
    expect(screen.queryByText("Alpha access")).not.toBeInTheDocument();

    rerender(
      <ScopeList
        scopes={scopes}
        search="manage the gamma resources"
        selected={[]}
        onToggle={vi.fn()}
      />
    );
    expect(screen.getByText("Gamma access")).toBeInTheDocument();
    expect(screen.queryByText("Alpha access")).not.toBeInTheDocument();
  });

  it("prefers direct matches and falls back to every scope in a matching group", () => {
    const scopes = [
      scope("scope:overview", "Operations overview", "Summary", "Operations"),
      scope("scope:audit", "Audit logs", "Events", "Operations"),
      scope("scope:deployments", "Deployments", "Releases", "Team"),
      scope("scope:notes", "Release notes", "History", "Team"),
    ];
    const { rerender } = render(
      <ScopeList scopes={scopes} search="operations" selected={[]} onToggle={vi.fn()} />
    );

    expect(screen.getByText("Operations overview")).toBeInTheDocument();
    expect(screen.queryByText("Audit logs")).not.toBeInTheDocument();
    expect(screen.queryByText("Deployments")).not.toBeInTheDocument();

    rerender(<ScopeList scopes={scopes} search="team" selected={[]} onToggle={vi.fn()} />);

    expect(screen.getByText("Deployments")).toBeInTheDocument();
    expect(screen.getByText("Release notes")).toBeInTheDocument();
    expect(screen.queryByText("Operations overview")).not.toBeInTheDocument();
    expect(screen.queryByText("Audit logs")).not.toBeInTheDocument();
  });

  it("reveals individual resources for a selected scope and reports resource toggles", async () => {
    const onToggle = vi.fn();
    const onToggleResource = vi.fn();
    const scopeItem = scope("proxy:view", "View routes", "Read ingress routes", "Routes");
    const { rerender } = render(
      <ScopeList
        scopes={[scopeItem]}
        search=""
        selected={[]}
        onToggle={onToggle}
        onToggleResource={onToggleResource}
        proxyHosts={proxyHosts}
        restrictableScopes={[scopeItem.value]}
      />
    );

    expect(screen.queryByText("app.example.com")).not.toBeInTheDocument();
    fireEvent.click(checkboxFor("View routes"));
    expect(onToggle).toHaveBeenCalledWith("proxy:view");

    rerender(
      <ScopeList
        scopes={[scopeItem]}
        search=""
        selected={[scopeItem.value]}
        resources={{ [scopeItem.value]: ["route-2"] }}
        onToggle={onToggle}
        onToggleResource={onToggleResource}
        proxyHosts={proxyHosts}
        restrictableScopes={[scopeItem.value]}
      />
    );

    expect(await screen.findByText("public.example.com")).toBeInTheDocument();
    expect(checkboxFor("public.example.com")).toBeChecked();
    fireEvent.click(checkboxFor("app.example.com"));

    expect(onToggleResource).toHaveBeenCalledWith("proxy:view", "route-1");
  });

  it("loads nested folders, shows their paths, and reports folder targets", async () => {
    apiMocks.listFolders.mockResolvedValueOnce([
      {
        id: "folder-prod",
        name: "Production",
        children: [{ id: "folder-internal", name: "Internal", children: [] }],
      },
    ]);
    const onToggleResource = vi.fn();
    const scopeItem = scope("proxy:view", "View routes", "Read ingress routes", "Routes");

    render(
      <ScopeList
        scopes={[scopeItem]}
        search=""
        selected={[scopeItem.value]}
        onToggle={vi.fn()}
        onToggleResource={onToggleResource}
        proxyHosts={
          [
            { id: "route-1", domainNames: ["app.example.com"], folderId: "folder-prod" },
          ] as ProxyHost[]
        }
        restrictableScopes={[scopeItem.value]}
      />
    );

    await screen.findByText("Production");
    const folderCheckbox = checkboxFor("Production");
    expect(folderCheckbox).not.toBeChecked();
    fireEvent.click(folderCheckbox);

    expect(onToggleResource).toHaveBeenCalledWith("proxy:view", "folder/folder-prod");
    expect(await screen.findByText("Production/Internal")).toBeInTheDocument();
  });

  it("checks a selected folder and disables resources contained by that folder", async () => {
    apiMocks.listFolders.mockResolvedValueOnce([
      {
        id: "folder-prod",
        name: "Production",
        children: [],
      },
    ]);
    const scopeItem = scope("proxy:view", "View routes", "Read ingress routes", "Routes");

    render(
      <ScopeList
        scopes={[scopeItem]}
        search=""
        selected={[scopeItem.value]}
        resources={{ [scopeItem.value]: ["folder/folder-prod"] }}
        onToggle={vi.fn()}
        onToggleResource={vi.fn()}
        proxyHosts={
          [
            { id: "route-1", domainNames: ["app.example.com"], folderId: "folder-prod" },
          ] as ProxyHost[]
        }
        restrictableScopes={[scopeItem.value]}
      />
    );

    expect(await screen.findByText("Production")).toBeInTheDocument();
    expect(checkboxFor("Production")).toBeChecked();
    expect(checkboxFor("app.example.com")).toBeChecked();
    expect(checkboxFor("app.example.com")).toBeDisabled();
  });

  it("loads Docker resources below Docker nodes and reports their scoped resource ids", async () => {
    apiMocks.listDockerContainers.mockResolvedValueOnce([
      {
        id: "runtime-1",
        scopeResourceId: "container-1",
        name: "gateway-api",
        kind: "container",
        folderId: null,
      },
    ]);
    const onToggleResource = vi.fn();
    const scopeItem = scope(
      "docker:containers:view",
      "View containers",
      "Read Docker containers",
      "Docker"
    );

    render(
      <ScopeList
        scopes={[scopeItem]}
        search=""
        selected={[scopeItem.value]}
        onToggle={vi.fn()}
        onToggleResource={onToggleResource}
        nodes={nodes}
        restrictableScopes={[scopeItem.value]}
      />
    );

    expect(await screen.findByText("Docker Node")).toBeInTheDocument();
    expect(screen.queryByText("Ingress Node")).not.toBeInTheDocument();
    expect(await screen.findByText("gateway-api")).toBeInTheDocument();

    fireEvent.click(checkboxFor("gateway-api"));

    expect(onToggleResource).toHaveBeenCalledWith(
      "docker:containers:view",
      "docker-node/container-1"
    );
  });
});
