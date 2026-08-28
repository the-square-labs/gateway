import {
  Check,
  Loader2,
  Lock,
  Mail,
  RotateCcw,
  Save,
  ShieldAlert,
  Trash2,
  Unlock,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { PanelShell } from "@/components/common/PanelShell";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getInitials } from "@/lib/utils";
import { api } from "@/services/api";
import type { BrowserSession, User } from "@/types";

type LocalAuthMethod = "password" | "email_otp" | "oidc";

export function AdminUserConfigDialog({
  open,
  user,
  canResetMfa,
  onOpenChange,
  onUserUpdated,
  onUserDeleted,
}: {
  open: boolean;
  user: User | null;
  canResetMfa: boolean;
  onOpenChange: (open: boolean) => void;
  onUserUpdated: (user: User) => void;
  onUserDeleted: (user: User) => void;
}) {
  const [name, setName] = useState("");
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [passwordLinkCoolingDown, setPasswordLinkCoolingDown] = useState(false);
  const nameSavedTimer = useRef<number | null>(null);
  const passwordLinkCooldownTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (nameSavedTimer.current !== null) window.clearTimeout(nameSavedTimer.current);
      if (passwordLinkCooldownTimer.current !== null)
        window.clearTimeout(passwordLinkCooldownTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!open || !user) return;
    setName(user.name ?? user.email);
    setSessions([]);
    setSessionsDialogOpen(false);
    let active = true;
    setSessionsLoading(true);
    void api
      .listAdminUserSessions(user.id)
      .then((result) => {
        if (active) setSessions(result);
      })
      .catch((error) => {
        if (active)
          toast.error(error instanceof Error ? error.message : "Failed to load active sessions");
      })
      .finally(() => {
        if (active) setSessionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, user]);

  if (!user) return null;

  const authMethod = (user.authMethod ?? "oidc") as LocalAuthMethod;
  const isOidc = authMethod === "oidc";

  const run = async (task: () => Promise<void>) => {
    setSaving(true);
    try {
      await task();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update user");
    } finally {
      setSaving(false);
    }
  };

  const saveName = () =>
    run(async () => {
      const updated = await api.updateUserName(user.id, name.trim());
      onUserUpdated(updated);
      setNameSaved(true);
      if (nameSavedTimer.current !== null) window.clearTimeout(nameSavedTimer.current);
      nameSavedTimer.current = window.setTimeout(() => {
        setNameSaved(false);
        nameSavedTimer.current = null;
      }, 2000);
      toast.success("User name updated");
    });

  const toggleBlock = () =>
    run(async () => {
      const blocked = !user.isBlocked;
      await api.blockUser(user.id, blocked);
      onUserUpdated({ ...user, isBlocked: blocked });
      toast.success(blocked ? "User blocked" : "User unblocked");
    });

  const changeAuthMethod = async (nextMethod: LocalAuthMethod) => {
    if (nextMethod === authMethod) return;
    const accepted = await confirm({
      title: "Change sign-in method",
      description:
        nextMethod === "password"
          ? "Existing browser sessions will be revoked and the user will receive a password-setup link."
          : "Existing browser sessions will be revoked.",
      confirmLabel: "Change method",
    });
    if (!accepted) return;
    await run(async () => {
      const updated = await api.updateUserAuthMethod(user.id, nextMethod);
      onUserUpdated(updated);
      setSessions([]);
      toast.success("Sign-in method updated");
    });
  };

  const sendPasswordLink = () =>
    run(async () => {
      const result = await api.sendUserPasswordLink(user.id);
      toast.success(
        result.purpose === "password_setup"
          ? "Password setup link sent"
          : "Password reset link sent"
      );
      setPasswordLinkCoolingDown(true);
      if (passwordLinkCooldownTimer.current !== null)
        window.clearTimeout(passwordLinkCooldownTimer.current);
      passwordLinkCooldownTimer.current = window.setTimeout(() => {
        setPasswordLinkCoolingDown(false);
        passwordLinkCooldownTimer.current = null;
      }, 5000);
    });

  const revokeSession = (sessionId: string) =>
    run(async () => {
      await api.revokeAdminUserSession(user.id, sessionId);
      setSessions((current) => current.filter((session) => session.id !== sessionId));
      toast.success("Session revoked");
    });

  const revokeAllSessions = () =>
    run(async () => {
      await api.revokeAllAdminUserSessions(user.id);
      setSessions([]);
      toast.success("All browser sessions revoked");
    });

  const resetMfa = async () => {
    const accepted = await confirm({
      title: "Reset MFA",
      description:
        "This removes the user's Gateway TOTP, passkeys, recovery codes, and browser sessions.",
      confirmLabel: "Reset MFA",
      variant: "destructive",
    });
    if (!accepted) return;
    await run(async () => {
      await api.resetAdminUserMfa(user.id);
      setSessions([]);
      toast.success("MFA reset");
    });
  };

  const deleteUser = async () => {
    const accepted = await confirm({
      title: "Delete User",
      description: `Delete "${user.name || user.email}"? Their access and tokens will be revoked. Only a system administrator can restore them.`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!accepted) return;
    await run(async () => {
      await api.deleteUser(user.id);
      setSessionsDialogOpen(false);
      onOpenChange(false);
      onUserDeleted(user);
      toast.success("User deleted");
    });
  };

  const resetAvatar = async () => {
    const accepted = await confirm({
      title: "Reset Avatar",
      description: `Remove the current avatar for "${user.name || user.email}"? An identity provider may restore its avatar the next time the user signs in.`,
      confirmLabel: "Reset",
      variant: "destructive",
    });
    if (!accepted) return;
    await run(async () => {
      const updated = await api.resetUserAvatar(user.id);
      onUserUpdated(updated);
      toast.success("Avatar reset");
    });
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSessionsDialogOpen(false);
            setPasswordLinkCoolingDown(false);
            if (passwordLinkCooldownTimer.current !== null) {
              window.clearTimeout(passwordLinkCooldownTimer.current);
              passwordLinkCooldownTimer.current = null;
            }
          }
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent aria-describedby={undefined} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Configure user</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <PanelShell title="Account" bodyClassName="divide-y divide-border">
              <section className="flex items-center gap-4 px-4 py-3">
                <Avatar className="h-10 w-10 shrink-0">
                  <AvatarImage src={user.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-sm">
                    {getInitials(user.name || user.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                </div>
                <Badge variant="secondary" size="inline" className="shrink-0">
                  {user.groupName}
                </Badge>
              </section>

              <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="text-sm font-medium">Avatar</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Remove the current image. OIDC may restore the provider avatar at next sign-in.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void resetAvatar()}
                  disabled={saving || !user.avatarUrl}
                >
                  <RotateCcw className="h-4 w-4" />
                  Reset avatar
                </Button>
              </section>

              {!isOidc && (
                <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-medium">Name</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Used throughout Gateway.</p>
                  </div>
                  <div className="flex w-full border border-input bg-background sm:w-72 sm:shrink-0">
                    <Input
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setNameSaved(false);
                      }}
                      maxLength={255}
                      className="border-0 bg-transparent focus-visible:ring-0"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={saveName}
                      disabled={saving || !name.trim() || name.trim() === user.name}
                      aria-label={nameSaved ? "Name saved" : "Save name"}
                      title={nameSaved ? "Saved" : "Save name"}
                      className="relative shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Check
                        className={`absolute h-4 w-4 transition-all duration-200 ${nameSaved ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
                      />
                      <Save
                        className={`h-4 w-4 transition-all duration-200 ${nameSaved ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
                      />
                    </Button>
                  </div>
                </section>
              )}

              <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="text-sm font-medium">Sign-in method</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Changing it signs the user out everywhere.
                  </p>
                </div>
                <Select
                  value={authMethod}
                  onValueChange={(value) => void changeAuthMethod(value as LocalAuthMethod)}
                >
                  <SelectTrigger className="w-full sm:w-48" disabled={saving}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="oidc">OIDC</SelectItem>
                    <SelectItem value="password">Email and password</SelectItem>
                    <SelectItem value="email_otp">Email code</SelectItem>
                  </SelectContent>
                </Select>
              </section>

              {authMethod === "password" && (
                <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-medium">Password email</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Sends setup before the first sign-in, otherwise a reset link.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    onClick={sendPasswordLink}
                    disabled={saving || passwordLinkCoolingDown}
                  >
                    <Mail /> Send link
                  </Button>
                </section>
              )}

              <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div>
                  <p className="text-sm font-medium">Active sessions</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Browser sessions currently authorized for this account.
                  </p>
                </div>
                <div className="shrink-0">
                  {sessionsLoading ? (
                    <span className="text-sm text-muted-foreground">Loading sessions…</span>
                  ) : sessions.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No active sessions</span>
                  ) : (
                    <Button
                      variant="link"
                      className="h-auto p-0"
                      onClick={() => setSessionsDialogOpen(true)}
                    >
                      {sessions.length} active session{sessions.length === 1 ? "" : "s"}
                    </Button>
                  )}
                </div>
              </section>

              {canResetMfa && !isOidc && (
                <section className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div>
                    <p className="text-sm font-medium">Multi-factor authentication</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Removes Gateway MFA factors and signs the user out everywhere.
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => void resetMfa()} disabled={saving}>
                    <ShieldAlert /> Reset MFA
                  </Button>
                </section>
              )}
            </PanelShell>

            <PanelShell
              title="Destructive actions"
              description="These actions can revoke access or remove the account."
              bodyClassName="divide-y divide-border"
            >
              <section className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Account status</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {user.isBlocked ? "The account cannot sign in." : "The account can sign in."}
                  </p>
                </div>
                <Button
                  variant={user.isBlocked ? "outline" : "destructive"}
                  onClick={toggleBlock}
                  disabled={saving}
                >
                  {user.isBlocked ? <Unlock /> : <Lock />}
                  {user.isBlocked ? "Unblock user" : "Block user"}
                </Button>
              </section>
              <section className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Delete user</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Revokes access and keeps a restorable audit record.
                  </p>
                </div>
                <Button variant="destructive" onClick={() => void deleteUser()} disabled={saving}>
                  {saving ? <Loader2 className="animate-spin" /> : <Trash2 />}
                  Delete user
                </Button>
              </section>
            </PanelShell>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sessionsDialogOpen} onOpenChange={setSessionsDialogOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Active sessions</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Browser sessions currently authorized for this account.
          </p>
          <div className="border border-border">
            <div className="max-h-[min(25rem,48dvh)] divide-y divide-border overflow-y-auto overscroll-contain">
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {session.userAgent || "Unknown browser"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {session.authMethod.replace("_", " ")} · {session.ipAddress || "Unknown IP"} ·
                      Last active {new Date(session.lastSeenAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => revokeSession(session.id)}
                    disabled={saving}
                  >
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={revokeAllSessions}
              disabled={saving || sessions.length === 0}
            >
              Revoke all
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
