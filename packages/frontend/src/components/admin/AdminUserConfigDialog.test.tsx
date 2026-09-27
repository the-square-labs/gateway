import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUserConfigDialog } from "@/components/admin/AdminUserConfigDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { renderWithRouter } from "@/test/render";
import { waitForReveal } from "@/test/reveal";
import type { User } from "@/types";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));

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
  useAuthStore.setState({ user: null, isAuthenticated: false });
});

function renderDialog(user: User, onUserUpdated = vi.fn()) {
  return renderWithRouter(
    <AdminUserConfigDialog
      open
      user={user}
      canResetMfa
      onOpenChange={vi.fn()}
      onUserUpdated={onUserUpdated}
      onUserDeleted={vi.fn()}
    />
  );
}

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

    await waitForReveal();
    expect(screen.getByRole("heading", { name: "Configure User" })).toBeInTheDocument();
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

    await waitForReveal();
    fireEvent.click(screen.getByRole("button", { name: "1 active session" }));

    expect(await screen.findByText("Test Browser")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("opens once the session count is known, without a loading placeholder", async () => {
    let resolveSessions!: (sessions: []) => void;
    vi.spyOn(api, "listAdminUserSessions").mockReturnValue(
      new Promise((resolve) => {
        resolveSessions = resolve;
      })
    );

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

    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-reveal-phase", "revealed");
    expect(screen.queryByText(/Loading sessions/)).not.toBeInTheDocument();
    expect(screen.queryByText("No active sessions")).not.toBeInTheDocument();

    resolveSessions([]);
    await waitForReveal();
    expect(screen.getByText("No active sessions")).toBeInTheDocument();
  });

  it("lets an administrator reset the current avatar", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([]);
    const userWithAvatar = { ...passwordUser, avatarUrl: "data:image/png;base64,cG5n" };
    const resetAvatar = vi.spyOn(api, "resetUserAvatar").mockResolvedValue({
      ...userWithAvatar,
      avatarUrl: null,
    });
    const onUserUpdated = vi.fn();
    vi.mocked(confirm).mockResolvedValue(true);

    renderWithRouter(
      <AdminUserConfigDialog
        open
        user={userWithAvatar}
        canResetMfa
        onOpenChange={vi.fn()}
        onUserUpdated={onUserUpdated}
        onUserDeleted={vi.fn()}
      />
    );

    await waitForReveal();
    fireEvent.click(screen.getByRole("button", { name: "Reset avatar" }));

    await vi.waitFor(() => expect(resetAvatar).toHaveBeenCalledWith(userWithAvatar.id));
    expect(onUserUpdated).toHaveBeenCalledWith(expect.objectContaining({ avatarUrl: null }));
  });
});

describe("AdminUserConfigDialog invitation email", () => {
  const newUser: User = { ...passwordUser, lastLoginAt: null, invitationSentAt: null };

  it("offers the invitation once for a user who never signed in", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([]);
    const sentAt = new Date().toISOString();
    const sendInvitation = vi
      .spyOn(api, "sendUserInvitation")
      .mockResolvedValue({ ...newUser, invitationSentAt: sentAt });
    const onUserUpdated = vi.fn();

    renderDialog(newUser, onUserUpdated);
    await waitForReveal();
    fireEvent.click(screen.getByRole("button", { name: "Send invitation email" }));

    await vi.waitFor(() =>
      expect(onUserUpdated).toHaveBeenCalledWith({ ...newUser, invitationSentAt: sentAt })
    );
    expect(sendInvitation).toHaveBeenCalledWith(newUser.id);
  });

  it("shows when the invitation was sent instead of the action", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([]);

    renderDialog({ ...newUser, invitationSentAt: new Date().toISOString() });
    await waitForReveal();

    expect(screen.getByText(/Invitation sent/)).toHaveTextContent("Invitation sent Just now");
    expect(screen.queryByRole("button", { name: "Send invitation email" })).not.toBeInTheDocument();
  });

  it("hides the invitation for a user who has already signed in", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([]);

    renderDialog({ ...newUser, lastLoginAt: "2026-09-20T10:00:00.000Z" });
    await waitForReveal();

    expect(screen.queryByText("Invitation email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invitation email" })).not.toBeInTheDocument();
  });

  it("disables the action with a reason while SMTP is not verified", async () => {
    vi.spyOn(api, "listAdminUserSessions").mockResolvedValue([]);
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue({
      smtp: { verifiedAt: null },
    } as never);
    useAuthStore.setState({
      user: { id: "admin-1", scopes: ["settings:gateway:view"] } as never,
      isAuthenticated: true,
    });

    renderDialog(newUser);
    await waitForReveal();

    expect(screen.getByRole("button", { name: "Send invitation email" })).toBeDisabled();
    expect(screen.getByText("Sending requires verified SMTP.")).toBeInTheDocument();
  });
});
