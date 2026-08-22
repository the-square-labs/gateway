import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Node } from "@/types";
import { ScopeList } from "./ScopeList";

const apiMocks = vi.hoisted(() => ({
  listDockerContainers: vi.fn().mockResolvedValue([]),
  listDockerFolders: vi.fn().mockResolvedValue([]),
  listDomainFolders: vi.fn().mockResolvedValue([]),
  listDomains: vi.fn().mockResolvedValue({ data: [] }),
  listFolders: vi.fn().mockResolvedValue([
    {
      id: "folder-1",
      name: "Production",
      children: [{ id: "folder-2", name: "Internal", children: [] }],
    },
  ]),
  listNodeFolders: vi.fn().mockResolvedValue([]),
  listDatabaseFolders: vi.fn().mockResolvedValue([]),
  listLoggingEnvironmentFolders: vi.fn().mockResolvedValue([]),
  listLoggingSchemaFolders: vi.fn().mockResolvedValue([]),
  listLoggingEnvironments: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/services/api", () => ({ api: apiMocks }));

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
    displayName: "Nginx Node",
  },
] as Node[];

describe("ScopeList", () => {
  it("shows only Docker nodes for resource-scoped Docker permissions", () => {
    render(
      <ScopeList
        scopes={[
          {
            value: "docker:containers:view",
            label: "View Containers",
            desc: "View Docker containers",
            group: "Docker",
          },
        ]}
        search=""
        selected={["docker:containers:view"]}
        onToggle={vi.fn()}
        resources={{}}
        onToggleResource={vi.fn()}
        nodes={nodes}
        restrictableScopes={["docker:containers:view"]}
      />
    );

    expect(screen.getByText("Docker Node")).toBeInTheDocument();
    expect(screen.queryByText("Nginx Node")).not.toBeInTheDocument();
  });

  it("keeps all nodes available for node-scoped node permissions", () => {
    render(
      <ScopeList
        scopes={[
          {
            value: "nodes:details",
            label: "Node Details",
            desc: "View node details",
            group: "Nodes",
          },
        ]}
        search=""
        selected={["nodes:details"]}
        onToggle={vi.fn()}
        resources={{}}
        onToggleResource={vi.fn()}
        nodes={nodes}
        restrictableScopes={["nodes:details"]}
      />
    );

    expect(screen.getByText("Docker Node")).toBeInTheDocument();
    expect(screen.getByText("Nginx Node")).toBeInTheDocument();
  });

  it("restricts route creation to Ingress nodes", () => {
    render(
      <ScopeList
        scopes={[
          {
            value: "proxy:create",
            label: "Create Routes",
            desc: "Create ingress routes",
            group: "Routes",
          },
        ]}
        search=""
        selected={["proxy:create"]}
        onToggle={vi.fn()}
        resources={{}}
        onToggleResource={vi.fn()}
        nodes={nodes}
        restrictableScopes={["proxy:create"]}
      />
    );

    expect(screen.getByText("Nginx Node")).toBeInTheDocument();
    expect(screen.queryByText("Docker Node")).not.toBeInTheDocument();
  });

  it("allows removing an additional broad scope even when the group grants resource-scoped access", () => {
    const onToggle = vi.fn();
    render(
      <ScopeList
        scopes={[
          {
            value: "nodes:console",
            label: "Node Console",
            desc: "Open node consoles",
            group: "Nodes",
          },
        ]}
        search=""
        selected={["nodes:console"]}
        onToggle={onToggle}
        inheritedScopes={["nodes:console:nginx-node"]}
        inheritedFromName="viewer"
        nodes={nodes}
        restrictableScopes={["nodes:console"]}
      />
    );

    const baseCheckbox = screen.getAllByRole("checkbox")[0]!;
    expect(baseCheckbox).toBeEnabled();
    fireEvent.click(baseCheckbox);
    expect(onToggle).toHaveBeenCalledWith("nodes:console");
  });

  it("uses the shared scoped rows to select a folder and shows its nested path", async () => {
    const onToggleResource = vi.fn();
    render(
      <ScopeList
        scopes={[
          {
            value: "proxy:view",
            label: "View Routes",
            desc: "View ingress routes",
            group: "Routes",
          },
        ]}
        search=""
        selected={["proxy:view"]}
        onToggle={vi.fn()}
        resources={{}}
        onToggleResource={onToggleResource}
        restrictableScopes={["proxy:view"]}
      />
    );

    const folderLabel = await screen.findByText("Production");
    fireEvent.click(folderLabel.closest("label")!.querySelector("input")!);
    expect(onToggleResource).toHaveBeenCalledWith("proxy:view", "folder/folder-1");
    expect(screen.getByText("Production/Internal")).toBeInTheDocument();
  });

  it("renders Docker permissions as node, folder, then resource with bounded indentation", async () => {
    apiMocks.listDockerFolders.mockResolvedValueOnce([
      {
        id: "docker-folder-1",
        name: "Apps",
        children: [
          {
            id: "docker-folder-2",
            name: "Production",
            children: [],
          },
        ],
      },
    ]);
    apiMocks.listDockerContainers.mockResolvedValueOnce([
      {
        id: "runtime-1",
        scopeResourceId: "resource-1",
        name: "gateway-api",
        kind: "container",
        folderId: "docker-folder-2",
      },
    ]);

    render(
      <ScopeList
        scopes={[
          {
            value: "docker:containers:view",
            label: "View Containers",
            desc: "View Docker containers",
            group: "Docker",
          },
        ]}
        search=""
        selected={["docker:containers:view"]}
        onToggle={vi.fn()}
        resources={{}}
        onToggleResource={vi.fn()}
        nodes={nodes.slice(0, 1)}
        restrictableScopes={["docker:containers:view"]}
      />
    );

    const folder = await screen.findByText("Apps/Production");
    const resource = await screen.findByText("gateway-api");
    expect(screen.getByText("Docker Node").closest("label")).not.toHaveClass("pl-5", "pl-10");
    expect(folder.closest("label")).toHaveClass("pl-5");
    expect(resource.closest("label")).toHaveClass("pl-10");
  });

  it("shows an entire group when the query matches only the group name", () => {
    render(
      <ScopeList
        scopes={[
          { value: "acl:view", label: "View Lists", desc: "View lists", group: "Access Control" },
          { value: "acl:edit", label: "Edit Lists", desc: "Edit lists", group: "Access Control" },
          { value: "nodes:details", label: "Node Details", desc: "View nodes", group: "Nodes" },
        ]}
        search="access control"
        selected={[]}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("View Lists")).toBeInTheDocument();
    expect(screen.getByText("Edit Lists")).toBeInTheDocument();
    expect(screen.queryByText("Node Details")).not.toBeInTheDocument();
  });

  it("shows only matching permissions when an item matches the query", () => {
    render(
      <ScopeList
        scopes={[
          { value: "acl:view", label: "View Lists", desc: "View lists", group: "Access Control" },
          { value: "acl:edit", label: "Edit Lists", desc: "Edit lists", group: "Access Control" },
        ]}
        search="edit lists"
        selected={[]}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("Edit Lists")).toBeInTheDocument();
    expect(screen.queryByText("View Lists")).not.toBeInTheDocument();
  });

  it("filters the list by selected state", () => {
    const scopes = [
      { value: "acl:view", label: "View Lists", desc: "View lists", group: "Access Control" },
      { value: "acl:edit", label: "Edit Lists", desc: "Edit lists", group: "Access Control" },
    ];
    const { rerender } = render(
      <ScopeList
        scopes={scopes}
        search=""
        selectionFilter="selected"
        selected={["acl:view"]}
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByText("View Lists")).toBeInTheDocument();
    expect(screen.queryByText("Edit Lists")).not.toBeInTheDocument();

    rerender(
      <ScopeList
        scopes={scopes}
        search=""
        selectionFilter="unselected"
        selected={["acl:view"]}
        onToggle={vi.fn()}
      />
    );
    expect(screen.queryByText("View Lists")).not.toBeInTheDocument();
    expect(screen.getByText("Edit Lists")).toBeInTheDocument();
  });
});
