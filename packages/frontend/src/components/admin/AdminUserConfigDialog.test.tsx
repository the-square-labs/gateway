import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUserConfigDialog } from "@/components/admin/AdminUserConfigDialog";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
import type { User } from "@/types";

const passwordUser: User = {
  id: "user-1",
  oidcSubject: null,
  authMethod: "password",
  email: "alex@example.com",
  name: "Alex Gateway",
  avatarUrl: null,
  groupId: "group-1",
  groupName: "viewer",
  scopes: [],
  isBlocked: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminUserConfigDialog", () => {
  it("shows local account controls and disables the session link when there are no sessions", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([]);

    renderWithRouter(
      <AdminUserConfigDialog
        open
        user={passwordUser}
        canResetMfa
        onOpenChange={vi.fn()}
        onUserUpdated={vi.fn()}
        onUserDeleted={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "Configure user" })).toBeInTheDocument();
    expect(screen.getByText("Password email")).toBeInTheDocument();
    expect(screen.getByText("Active sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Block user" })).toBeInTheDocument();
    expect(await screen.findByText("No active sessions")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /active session/i })).not.toBeInTheDocument();
  });

  it("opens the sessions dialog from the active-session link", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([
      {
        id: "session-1",
        authMethod: "password",
        createdAt: 1,
        lastSeenAt: 2,
        expiresAt: 3,
        ipAddress: "203.0.113.5",
        userAgent: "Test Browser",
        mfaSatisfiedAt: null,
        isCurrent: false,
      },
    ]);

    renderWithRouter(
      <AdminUserConfigDialog
        open
        user={passwordUser}
        canResetMfa
        onOpenChange={vi.fn()}
        onUserUpdated={vi.fn()}
        onUserDeleted={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "1 active session" }));

    expect(await screen.findByText("Test Browser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });
});
