import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import type { User } from "@/types";
import { UserAdditionalPermissionsDialog } from "./UserAdditionalPermissionsDialog";

const mocks = vi.hoisted(() => ({
  updateUserAdditionalPermissions: vi.fn(),
}));

vi.mock("@/components/common/ScopeList", () => ({
  ScopeList: ({ onToggleResource }: { onToggleResource?: (scope: string, id: string) => void }) =>
    onToggleResource ? (
      <button type="button" onClick={() => onToggleResource("nodes:console", "node-2")}>
        Grant node 2 console
      </button>
    ) : (
      <div>Read-only permissions</div>
    ),
}));

vi.mock("@/services/api", () => ({
  api: {
    listNodes: vi.fn().mockResolvedValue({ data: [] }),
    listProxyHosts: vi.fn().mockResolvedValue({ data: [] }),
    listDatabases: vi.fn().mockResolvedValue({ data: [] }),
    listLoggingSchemas: vi.fn().mockResolvedValue([]),
    updateUserAdditionalPermissions: mocks.updateUserAdditionalPermissions,
    invalidateCache: vi.fn(),
  },
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (state: { user: User }) => unknown) =>
    selector({
      user: {
        id: "actor-1",
        oidcSubject: "actor",
        email: "actor@example.com",
        name: "Actor",
        avatarUrl: null,
        groupId: "admin-group",
        groupName: "admin",
        scopes: ["admin:users", "nodes:console"],
        isBlocked: false,
      },
    }),
}));

vi.mock("@/stores/ca", () => ({
  useCAStore: () => ({ cas: [], fetchCAs: vi.fn().mockResolvedValue(undefined) }),
}));

describe("UserAdditionalPermissionsDialog", () => {
  beforeEach(() => {
    mocks.updateUserAdditionalPermissions.mockReset();
  });

  it("adds an exact resource grant when the group already grants the same scope for another resource", async () => {
    const target: User = {
      id: "user-1",
      oidcSubject: "target",
      email: "target@example.com",
      name: "Target",
      avatarUrl: null,
      groupId: "viewer-group",
      groupName: "viewer",
      groupScopes: ["nodes:console:node-1"],
      additionalScopes: [],
      scopes: ["nodes:console:node-1"],
      isBlocked: false,
    };
    mocks.updateUserAdditionalPermissions.mockResolvedValue({
      ...target,
      additionalScopes: ["nodes:console:node-2"],
    });

    render(
      <UserAdditionalPermissionsDialog
        open
        user={target}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Grant node 2 console" }));
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));

    await waitFor(() => {
      expect(mocks.updateUserAdditionalPermissions).toHaveBeenCalledWith("user-1", [
        "nodes:console:node-2",
      ]);
    });
  });

  it("resets only additional permissions before saving", async () => {
    const target: User = {
      id: "user-1",
      oidcSubject: "target",
      email: "target@example.com",
      name: "Target",
      avatarUrl: null,
      groupId: "viewer-group",
      groupName: "viewer",
      groupScopes: ["nodes:console:node-1"],
      additionalScopes: ["nodes:console:node-2"],
      scopes: ["nodes:console:node-1", "nodes:console:node-2"],
      isBlocked: false,
    };
    mocks.updateUserAdditionalPermissions.mockResolvedValue({
      ...target,
      additionalScopes: [],
      scopes: target.groupScopes,
    });

    render(
      <UserAdditionalPermissionsDialog
        open
        user={target}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset additional" }));
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));

    await waitFor(() => {
      expect(mocks.updateUserAdditionalPermissions).toHaveBeenCalledWith("user-1", []);
    });
  });

  it("keeps the base scope enabled after removing its last resource restriction", async () => {
    const target: User = {
      id: "user-1",
      oidcSubject: "target",
      email: "target@example.com",
      name: "Target",
      avatarUrl: null,
      groupId: "viewer-group",
      groupName: "viewer",
      groupScopes: [],
      additionalScopes: ["nodes:console:node-2"],
      scopes: ["nodes:console:node-2"],
      isBlocked: false,
    };
    mocks.updateUserAdditionalPermissions.mockResolvedValue({
      ...target,
      additionalScopes: ["nodes:console"],
      scopes: ["nodes:console"],
    });

    render(
      <UserAdditionalPermissionsDialog
        open
        user={target}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Grant node 2 console" }));
    fireEvent.click(screen.getByRole("button", { name: "Save permissions" }));

    await waitFor(() => {
      expect(mocks.updateUserAdditionalPermissions).toHaveBeenCalledWith("user-1", [
        "nodes:console",
      ]);
    });
  });
});
