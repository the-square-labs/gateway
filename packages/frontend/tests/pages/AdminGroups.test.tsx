import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminGroups } from "@/pages/AdminGroups";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeNode, makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { Node, PermissionGroup } from "@/types";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("@/components/common/PageTransition", () => ({
  PageTransition: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/common/ResponsiveHeaderActions", () => ({
  ResponsiveHeaderActions: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/common/LiteModeBackButton", () => ({
  LiteModeBackButton: () => null,
}));

vi.mock("@/components/common/FolderedResourceList", () => {
  interface FolderedResourceListTestProps {
    resources: PermissionGroup[];
    systemFolders?: Array<{ items: PermissionGroup[] }>;
    search: {
      search: string;
      onSearchChange: (value: string) => void;
      placeholder: string;
    };
    canViewItem?: (item: PermissionGroup) => boolean;
    onItemClick?: (item: PermissionGroup) => void;
    emptyState?: ReactNode;
  }

  function FolderedResourceList({
    resources,
    systemFolders = [],
    search,
    canViewItem,
    onItemClick,
    emptyState,
  }: FolderedResourceListTestProps) {
    const groups = [...systemFolders.flatMap((folder) => folder.items), ...resources];

    return (
      <section aria-label="permission group list">
        <input
          placeholder={search.placeholder}
          value={search.search}
          onChange={(event) => search.onSearchChange(event.target.value)}
        />
        {groups.length === 0
          ? emptyState
          : groups.map((group) => {
              const canView = canViewItem?.(group) ?? true;
              return (
                <button
                  key={group.id}
                  type="button"
                  disabled={!canView}
                  onClick={() => onItemClick?.(group)}
                >
                  {group.name}
                </button>
              );
            })}
      </section>
    );
  }

  return { FolderedResourceList };
});

const group = (overrides: Partial<PermissionGroup> = {}): PermissionGroup => ({
  id: "group-1",
  name: "group-1",
  description: null,
  isBuiltin: false,
  parentId: null,
  scopes: [],
  inheritedScopes: [],
  memberCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function renderAdminGroups({
  groups = [],
  scopes = ["admin:groups"],
  nodes = [],
}: {
  groups?: PermissionGroup[];
  scopes?: string[];
  nodes?: Node[];
} = {}) {
  vi.mocked(api.listGroups).mockResolvedValue(groups);
  vi.mocked(api.listNodes).mockResolvedValue({
    data: nodes,
    total: nodes.length,
    page: 1,
    limit: 100,
    totalPages: nodes.length > 0 ? 1 : 0,
  });
  useAuthStore.setState({
    user: makeUser({ scopes }),
    isAuthenticated: true,
    isLoading: false,
  });

  return renderWithRouter(<AdminGroups />, { route: "/admin/groups" });
}

function rowCheckbox(text: string) {
  const label = screen.getByText(text).closest("label");
  if (!label) throw new Error(`Label for ${text} was not found`);
  return within(label).getByRole("checkbox");
}

async function findRowCheckbox(text: string) {
  const label = (await screen.findByText(text)).closest("label");
  if (!label) throw new Error(`Label for ${text} was not found`);
  return within(label).getByRole("checkbox");
}

describe("AdminGroups characterization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.navigate.mockReset();
    api.resetSessionState();

    vi.spyOn(api, "listGroups").mockResolvedValue([]);
    vi.spyOn(api, "listCAs").mockResolvedValue([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listDatabases").mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 200, total: 0, totalPages: 0 },
    });
    vi.spyOn(api, "listLoggingSchemas").mockResolvedValue([]);
    vi.spyOn(api, "listNodeFolders").mockResolvedValue([]);
    vi.spyOn(toast, "error").mockImplementation(() => "toast-id");
    vi.spyOn(toast, "success").mockImplementation(() => "toast-id");
  });

  it("normalizes group names and submits exact non-resource scopes", async () => {
    const createGroup = vi.spyOn(api, "createGroup").mockResolvedValue(group({ name: "ops-team" }));
    renderAdminGroups({ scopes: ["admin:groups", "license:view"] });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create Group" }));
    const dialog = await screen.findByRole("dialog", { name: "Create Group" });

    const nameInput = within(dialog).getByPlaceholderText("e.g. cert-operator");
    await user.type(nameInput, "  Ops__Team  ");
    expect(nameInput).toHaveValue("ops-team-");

    await user.type(
      within(dialog).getByPlaceholderText("Optional description"),
      "  Scoped access  "
    );
    const scopeSearch = within(dialog).getByPlaceholderText("Search scopes...");
    await user.type(scopeSearch, "View License");
    await user.click(rowCheckbox("View License"));
    await user.click(within(dialog).getByRole("button", { name: "Create Group" }));

    await waitFor(() => {
      expect(createGroup).toHaveBeenCalledWith({
        name: "ops-team",
        description: "Scoped access",
        scopes: ["license:view"],
        parentId: null,
        requireGateway2fa: false,
      });
    });
  });

  it("requires an allowed resource and serializes the selected resource scope", async () => {
    const node = makeNode({ id: "node-1", displayName: "Edge 1" });
    const createGroup = vi.spyOn(api, "createGroup").mockResolvedValue(group({ name: "node-ops" }));
    renderAdminGroups({
      scopes: ["admin:groups", "nodes:console:node-1"],
      nodes: [node],
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create Group" }));
    const dialog = await screen.findByRole("dialog", { name: "Create Group" });
    await user.type(within(dialog).getByPlaceholderText("e.g. cert-operator"), "Node Ops");
    await user.type(within(dialog).getByPlaceholderText("Search scopes..."), "Node Console");
    await user.click(rowCheckbox("Node Console"));

    const resourceCheckbox = await findRowCheckbox("Edge 1");
    expect(resourceCheckbox).toBeChecked();
    await user.click(resourceCheckbox);
    await user.click(within(dialog).getByRole("button", { name: "Create Group" }));

    expect(toast.error).toHaveBeenCalledWith("Select at least one resource for nodes:console");
    expect(createGroup).not.toHaveBeenCalled();

    await user.click(await findRowCheckbox("Edge 1"));
    await user.click(within(dialog).getByRole("button", { name: "Create Group" }));

    await waitFor(() => {
      expect(createGroup).toHaveBeenCalledWith({
        name: "node-ops",
        description: undefined,
        scopes: ["nodes:console:node-1"],
        parentId: null,
        requireGateway2fa: false,
      });
    });
  });

  it("round-trips resource-scoped selections when editing a group", async () => {
    const existing = group({
      id: "node-operators",
      name: "node-operators",
      description: "Existing description",
      scopes: ["nodes:console:node-1"],
    });
    const updateGroup = vi
      .spyOn(api, "updateGroup")
      .mockResolvedValue(group({ ...existing, name: "renamed-group" }));
    renderAdminGroups({
      groups: [existing],
      scopes: ["admin:groups", "nodes:console:node-1"],
      nodes: [makeNode({ id: "node-1", displayName: "Edge 1" })],
    });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "node-operators" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Group" });
    expect(within(dialog).getByPlaceholderText("e.g. cert-operator")).toHaveValue("node-operators");
    expect(await findRowCheckbox("Edge 1")).toBeChecked();

    const nameInput = within(dialog).getByPlaceholderText("e.g. cert-operator");
    await user.clear(nameInput);
    await user.type(nameInput, "  Renamed Group ");
    await user.click(within(dialog).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(updateGroup).toHaveBeenCalledWith("node-operators", {
        name: "renamed-group",
        description: "Existing description",
        scopes: ["nodes:console:node-1"],
        parentId: null,
        requireGateway2fa: false,
      });
    });
  });

  it("redirects users without the groups administration scope", async () => {
    renderAdminGroups({ scopes: [] });

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/"));
  });

  it("keeps built-in groups read-only without system administration scope", async () => {
    const builtin = group({
      id: "builtin-viewer",
      name: "viewer",
      isBuiltin: true,
      description: "Built-in viewer group",
      scopes: ["license:view"],
    });
    renderAdminGroups({ groups: [builtin], scopes: ["admin:groups", "license:view"] });

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "viewer" }));
    const dialog = await screen.findByRole("dialog", { name: "View Group" });

    expect(within(dialog).getAllByRole("button", { name: "Close" })).not.toHaveLength(0);
    expect(within(dialog).queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText("e.g. cert-operator")).toBeDisabled();
    expect(rowCheckbox("View License")).toBeDisabled();
  });
});
