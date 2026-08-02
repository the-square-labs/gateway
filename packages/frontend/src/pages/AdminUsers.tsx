import {
  ArchiveRestore,
  Ban,
  FolderPlus,
  Lock,
  Plus,
  ShieldPlus,
  Trash2,
  Unlock,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { UserAdditionalPermissionsDialog } from "@/components/admin/UserAdditionalPermissionsDialog";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { scopeMatches } from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DeletedUser, PermissionGroup, User } from "@/types";

function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }
  return email[0].toUpperCase();
}

function isScopeSubset(requestedScopes: string[], availableScopes: string[]): boolean {
  return requestedScopes.every((scope) => scopeMatches(availableScopes, scope));
}

export function AdminUsers({
  embedded = false,
  createRequest = 0,
  onCreateFolderRef,
}: {
  embedded?: boolean;
  createRequest?: number;
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  const navigate = useNavigate();
  const { user: currentUser, hasAnyScope, hasScope } = useAuthStore();
  const cachedUsers = api.getCached<User[]>("admin:users");
  const cachedGroups = api.getCached<PermissionGroup[]>("admin:groups");
  const [users, setUsers] = useState<User[]>(cachedUsers ?? []);
  const [groups, setGroups] = useState<PermissionGroup[]>(cachedGroups ?? []);
  const [isLoading, setIsLoading] = useState(!cachedUsers);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createGroupId, setCreateGroupId] = useState("");
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const [permissionsUser, setPermissionsUser] = useState<User | null>(null);
  const [deletedUsers, setDeletedUsers] = useState<DeletedUser[]>([]);
  const [deletedUsersOpen, setDeletedUsersOpen] = useState(false);
  const [restoreUser, setRestoreUser] = useState<DeletedUser | null>(null);
  const [restoreGroupId, setRestoreGroupId] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [search, setSearch] = useState("");
  const lastCreateRequest = useRef(createRequest);

  useEffect(() => {
    if (!hasScope("admin:users")) {
      navigate("/");
      return;
    }
  }, [hasScope, navigate]);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api.listUsers();
      api.setCache("admin:users", data || []);
      setUsers(data || []);
    } catch {
      toast.error("Failed to load users");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadDeletedUsers = useCallback(async () => {
    try {
      const data = await api.listDeletedUsers();
      setDeletedUsers(data ?? []);
    } catch {
      toast.error("Failed to load deleted users");
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const canManageDeletedUsers = hasScope("admin:system");

  useEffect(() => {
    if (canManageDeletedUsers) void loadDeletedUsers();
  }, [canManageDeletedUsers, loadDeletedUsers]);

  useEffect(() => {
    api
      .listGroups()
      .then((data) => {
        api.setCache("admin:groups", data);
        setGroups(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (createGroupId || groups.length === 0) return;
    const preferred =
      groups.find((group) => group.name === "viewer") ??
      groups.find((group) => !group.isBuiltin) ??
      groups[0];
    if (preferred) setCreateGroupId(preferred.id);
  }, [createGroupId, groups]);

  useRealtime("user.changed", () => {
    reloadUsers();
  });

  useRealtime("group.changed", () => {
    api
      .listGroups()
      .then((data) => {
        api.setCache("admin:groups", data);
        setGroups(data);
      })
      .catch(() => {});
    reloadUsers();
  });

  const reloadUsers = useCallback(() => {
    api.invalidateCache("req:");
    api.invalidateCache("admin:users");
    return loadUsers();
  }, [loadUsers]);

  const handleGroupChange = async (user: User, groupId: string) => {
    const additionalCount = user.additionalScopes?.length ?? 0;
    if (additionalCount > 0) {
      const proceed = await confirm({
        title: "Change Permission Group",
        description: `${user.name || user.email} will retain ${additionalCount} additional permission${additionalCount === 1 ? "" : "s"}.`,
        confirmLabel: "Change Group",
      });
      if (!proceed) return;
    }
    try {
      await api.updateUserGroup(user.id, groupId);
      toast.success("Group updated");
      reloadUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update group");
    }
  };

  const handleBlockToggle = async (user: User) => {
    const newBlocked = !user.isBlocked;
    try {
      await api.blockUser(user.id, newBlocked);
      toast.success(newBlocked ? "User blocked" : "User unblocked");
      reloadUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update user");
    }
  };

  const handleDelete = async (user: User) => {
    const ok = await confirm({
      title: "Delete User",
      description: `Delete "${user.name || user.email}"? Their access and tokens will be revoked. Only a system administrator can restore them.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteUser(user.id);
      toast.success("User deleted");
      await Promise.all([reloadUsers(), ...(canManageDeletedUsers ? [loadDeletedUsers()] : [])]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete user");
    }
  };

  const openRestore = (user: DeletedUser) => {
    setRestoreUser(user);
    setRestoreGroupId("");
  };

  const handleRestore = async () => {
    if (!restoreUser) return;
    if (!restoreUser.originalGroupExists && !restoreGroupId) {
      toast.error("Select a group to restore this user");
      return;
    }
    setRestoring(true);
    try {
      await api.restoreUser(
        restoreUser.id,
        restoreUser.originalGroupExists ? undefined : restoreGroupId
      );
      toast.success("User restored in blocked state. Unblock them separately to grant access.");
      setRestoreUser(null);
      await Promise.all([loadDeletedUsers(), reloadUsers()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore user");
    } finally {
      setRestoring(false);
    }
  };

  const resetCreateDialog = () => {
    setCreateOpen(false);
    setCreateEmail("");
    setCreateName("");
    const preferred =
      groups.find((group) => group.name === "viewer") ??
      groups.find((group) => !group.isBuiltin) ??
      groups[0];
    setCreateGroupId(preferred?.id ?? "");
  };

  const handleCreateUser = async () => {
    if (!createEmail.trim() || !createGroupId) {
      toast.error("Email and group are required");
      return;
    }

    setCreating(true);
    try {
      await api.createUser({
        email: createEmail.trim(),
        name: createName.trim() || undefined,
        groupId: createGroupId,
      });
      toast.success("User created");
      resetCreateDialog();
      reloadUsers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!embedded || createRequest === 0 || createRequest === lastCreateRequest.current) return;
    lastCreateRequest.current = createRequest;
    setCreateOpen(true);
  }, [createRequest, embedded]);

  const canManageFolders = hasAnyScope("admin:users:folders:manage", "admin:system");
  const hasActiveFilters = search.trim() !== "";
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) =>
      [user.name, user.email, user.groupName].some((value) => value?.toLowerCase().includes(query))
    );
  }, [search, users]);
  const userColumns: ResourceListColumn<User>[] = [
    {
      id: "user",
      label: "User",
      width: "minmax(16rem, 1fr)",
      renderCell: (user) => {
        const isSelf = currentUser?.id === user.id;
        const isSystemUser = user.oidcSubject?.startsWith("system:");
        return (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="h-9 w-9 shrink-0">
              <AvatarImage src={user.avatarUrl ?? undefined} />
              <AvatarFallback className="text-xs">
                {getInitials(user.name, user.email)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                {isSelf && (
                  <Badge variant="secondary" size="inline" className="shrink-0">
                    You
                  </Badge>
                )}
                {isSystemUser && (
                  <Badge variant="outline" size="inline" className="shrink-0">
                    System
                  </Badge>
                )}
                {user.isBlocked && (
                  <Badge variant="destructive" size="inline" className="shrink-0">
                    <Ban className="mr-0.5 h-2.5 w-2.5" />
                    Blocked
                  </Badge>
                )}
                {(user.additionalScopes?.length ?? 0) > 0 && (
                  <Badge variant="outline" size="inline" className="shrink-0">
                    +{user.additionalScopes!.length} additional
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
        );
      },
    },
    {
      id: "group",
      label: "Group",
      width: "14rem",
      renderCell: (user) => {
        const isSelf = currentUser?.id === user.id;
        const isSystemUser = user.oidcSubject?.startsWith("system:");
        const isReadOnly = isSelf || isSystemUser;
        if (isReadOnly) return <Badge variant="secondary">{user.groupName}</Badge>;
        return (
          <div
            className="w-full"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Select value={user.groupId} onValueChange={(v) => handleGroupChange(user, v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      },
    },
    {
      id: "actions",
      label: "Actions",
      width: "8.5rem",
      align: "right",
      renderCell: (user) => {
        const isSelf = currentUser?.id === user.id;
        const isSystemUser = user.oidcSubject?.startsWith("system:");
        const isReadOnly = isSelf || isSystemUser;
        if (isReadOnly) return null;
        const canManagePermissions = isScopeSubset(user.scopes, currentUser?.scopes ?? []);
        return (
          <div
            className="flex items-center justify-end gap-1"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-primary"
              onClick={() => setPermissionsUser(user)}
              title="Additional permissions"
              disabled={!canManagePermissions}
            >
              <ShieldPlus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={`h-8 w-8 shrink-0 text-muted-foreground ${user.isBlocked ? "hover:text-green-600" : "hover:text-orange-600"}`}
              onClick={() => handleBlockToggle(user)}
              title={user.isBlocked ? "Unblock user" : "Block user"}
            >
              {user.isBlocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => handleDelete(user)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  if (isLoading) {
    return <LoadingSpinner />;
  }

  // Group users by their group name for summary
  const groupCounts = new Map<string, number>();
  let blockedCount = 0;
  for (const u of users) {
    if (u.isBlocked) {
      blockedCount++;
    } else {
      groupCounts.set(u.groupName, (groupCounts.get(u.groupName) || 0) + 1);
    }
  }
  const summaryParts = Array.from(groupCounts.entries()).map(
    ([name, count]) => `${count} ${name.toLowerCase()}${count !== 1 ? "s" : ""}`
  );
  if (blockedCount > 0) summaryParts.push(`${blockedCount} blocked`);

  const content = (
    <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
      {!embedded && (
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Users</h1>
              <p className="text-sm text-muted-foreground">
                {users.length} user{users.length !== 1 ? "s" : ""}
                {summaryParts.length > 0 && <> &middot; {summaryParts.join(", ")}</>}
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              ...(canManageFolders && createFolderAction
                ? [
                    {
                      label: "Add Folder",
                      icon: <FolderPlus className="h-4 w-4" />,
                      onClick: createFolderAction,
                    },
                  ]
                : []),
              ...(canManageDeletedUsers
                ? [
                    {
                      label: "Deleted Users",
                      icon: <ArchiveRestore className="h-4 w-4" />,
                      onClick: () => setDeletedUsersOpen(true),
                    },
                  ]
                : []),
              {
                label: "Create User",
                icon: <Plus className="h-4 w-4" />,
                onClick: () => setCreateOpen(true),
              },
            ]}
          >
            {canManageFolders && (
              <Button variant="outline" onClick={() => createFolderAction?.()}>
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Button>
            )}
            {canManageDeletedUsers && (
              <Button variant="outline" onClick={() => setDeletedUsersOpen(true)}>
                <ArchiveRestore className="h-4 w-4" />
                Deleted Users
              </Button>
            )}
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              Create User
            </Button>
          </ResponsiveHeaderActions>
        </div>
      )}

      {embedded && canManageDeletedUsers && (
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setDeletedUsersOpen(true)}>
            <ArchiveRestore className="h-4 w-4" />
            Deleted Users
          </Button>
        </div>
      )}

      <FolderedResourceList<User>
        resourceType="admin-user"
        realtimeChannel="user.changed"
        resources={filteredUsers}
        columns={userColumns}
        search={{
          search,
          onSearchChange: setSearch,
          placeholder: "Search users...",
          hasActiveFilters,
          onReset: () => setSearch(""),
        }}
        loading={false}
        loadingLabel="Loading users..."
        emptyState={
          <EmptyState
            message="No users."
            hasActiveFilters={hasActiveFilters}
            onReset={() => setSearch("")}
          />
        }
        minWidth={720}
        canManageFolders={canManageFolders}
        canReorganizeItem={() => canManageFolders}
        getResourceLabel={(user) => user.name || user.email}
        onRefresh={reloadUsers}
        onCreateFolderRef={(fn) => {
          setCreateFolderAction(() => fn);
          onCreateFolderRef?.(fn);
        }}
      />

      <Dialog open={createOpen} onOpenChange={(open) => (!creating ? setCreateOpen(open) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="create-user-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="create-user-email"
                type="email"
                placeholder="user@example.com"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="create-user-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="create-user-name"
                placeholder="Jane Doe"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Group</label>
              <Select value={createGroupId} onValueChange={setCreateGroupId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select group" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              This creates a placeholder account so you can assign permissions before the user logs
              in for the first time.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetCreateDialog} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateUser}
              disabled={creating || !createEmail || !createGroupId}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <UserAdditionalPermissionsDialog
        open={permissionsUser !== null}
        user={permissionsUser}
        onOpenChange={(open) => {
          if (!open) setPermissionsUser(null);
        }}
        onSaved={(updatedUser) => {
          setUsers((current) =>
            current.map((user) => (user.id === updatedUser.id ? updatedUser : user))
          );
          void reloadUsers();
        }}
      />

      <Dialog open={deletedUsersOpen} onOpenChange={setDeletedUsersOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Deleted Users</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Restoring an account keeps it blocked. Its old sessions and tokens are not restored.
          </p>
          {deletedUsers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No deleted users.</p>
          ) : (
            <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
              {deletedUsers.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{user.name || user.email}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {user.email} · deleted {new Date(user.deletedAt).toLocaleString()}
                    </p>
                    {!user.originalGroupExists && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                        Original group was deleted
                      </p>
                    )}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openRestore(user)}>
                    <ArchiveRestore className="h-4 w-4" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={restoreUser !== null}
        onOpenChange={(open) => {
          if (!restoring && !open) setRestoreUser(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Restore {restoreUser?.name || restoreUser?.email}? The account will remain blocked
              until explicitly unblocked.
            </p>
            {restoreUser && !restoreUser.originalGroupExists && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">New group</label>
                <Select value={restoreGroupId} onValueChange={setRestoreGroupId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select group" />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreUser(null)} disabled={restoring}>
              Cancel
            </Button>
            <Button
              onClick={handleRestore}
              disabled={restoring || (!restoreUser?.originalGroupExists && !restoreGroupId)}
            >
              Restore blocked user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  return embedded ? content : <PageTransition>{content}</PageTransition>;
}
