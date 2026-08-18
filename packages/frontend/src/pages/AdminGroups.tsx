import {
  EllipsisVertical,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { ScopeList } from "@/components/common/ScopeList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useRealtime } from "@/hooks/use-realtime";
import {
  buildFinalScopes,
  deriveAllowedResourceIdsByScope,
  hasSelectableScopeBase,
  parseScopesForForm,
  requiresResourceSelection,
  scopeMatches,
} from "@/lib/scope-utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useCAStore } from "@/stores/ca";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { DatabaseConnection, LoggingSchema, Node, PermissionGroup, ProxyHost } from "@/types";
import { GROUP_ASSIGNABLE_SCOPES, RESOURCE_SCOPABLE_SCOPES } from "@/types";

function isScopeSubset(requestedScopes: string[], allowedScopes: string[]): boolean {
  return requestedScopes.every((scope) => scopeMatches(allowedScopes, scope));
}

function getGroupEffectiveScopes(group: PermissionGroup): string[] {
  return [...new Set([...group.scopes, ...(group.inheritedScopes ?? [])])];
}

function formatGroupNameInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/g, "");
}

function formatGroupName(value: string): string {
  return formatGroupNameInput(value).replace(/-+$/g, "");
}

function findMissingRequiredResourceSelection(
  baseScopes: string[],
  resources: Record<string, string[]>,
  allowedResourceIdsByScope: Record<string, string[]>,
  initialResourceLimitedScopes: readonly string[]
): string | null {
  for (const scope of baseScopes) {
    if (
      requiresResourceSelection(scope, allowedResourceIdsByScope, initialResourceLimitedScopes) &&
      (resources[scope]?.length ?? 0) === 0
    ) {
      return scope;
    }
  }
  return null;
}

export function AdminGroups({
  embedded = false,
  createRequest = 0,
  onCreateFolderRef,
}: {
  embedded?: boolean;
  createRequest?: number;
  onCreateFolderRef?: (fn: () => void) => void;
}) {
  const navigate = useNavigate();
  const { user, hasAnyScope, hasScope } = useAuthStore();
  const { cas, fetchCAs } = useCAStore();
  const [nodesList, setNodesList] = useState<Node[]>(
    () => api.getCached<Node[]>("admin:scope-nodes") ?? []
  );
  const [proxyHostsList, setProxyHostsList] = useState<ProxyHost[]>(
    () => api.getCached<ProxyHost[]>("admin:scope-proxy-hosts") ?? []
  );
  const [databasesList, setDatabasesList] = useState<DatabaseConnection[]>(
    () => api.getCached<DatabaseConnection[]>("admin:scope-databases") ?? []
  );
  const [loggingSchemasList, setLoggingSchemasList] = useState<LoggingSchema[]>(
    () => api.getCached<LoggingSchema[]>("admin:scope-logging-schemas") ?? []
  );
  const [groups, setGroups] = useState<PermissionGroup[]>(
    () => api.getCached<PermissionGroup[]>("admin:groups") ?? []
  );
  const [isLoading, setIsLoading] = useState(
    () => api.getCached<PermissionGroup[]>("admin:groups") === undefined
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<PermissionGroup | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [formBaseScopes, setFormBaseScopes] = useState<string[]>([]);
  const [formResources, setFormResources] = useState<Record<string, string[]>>({});
  const [formRequireGateway2fa, setFormRequireGateway2fa] = useState(false);
  const [initialResourceLimitedScopes, setInitialResourceLimitedScopes] = useState<string[]>([]);
  const [scopeSearch, setScopeSearch] = useState("");
  const [listSearch, setListSearch] = useState("");
  const [groupDialogMode, setGroupDialogMode] = useState<"edit" | "readonly">("edit");
  const [saving, setSaving] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const lastCreateRequest = useRef(createRequest);
  const userScopes = useMemo(() => user?.scopes ?? [], [user?.scopes]);
  const allowedResourceIdsByScope = useMemo(
    () => deriveAllowedResourceIdsByScope(userScopes),
    [userScopes]
  );
  const assignableScopes = useMemo(
    () =>
      GROUP_ASSIGNABLE_SCOPES.filter((scope) => hasSelectableScopeBase(userScopes, scope.value)),
    [userScopes]
  );
  const canManageGroup = useCallback(
    (group: PermissionGroup) => isScopeSubset(getGroupEffectiveScopes(group), userScopes),
    [userScopes]
  );
  const availableParentGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.id !== editingGroup?.id &&
          !group.parentId &&
          !getGroupEffectiveScopes(group).includes("admin:system") &&
          isScopeSubset(getGroupEffectiveScopes(group), userScopes)
      ),
    [editingGroup?.id, groups, userScopes]
  );

  useEffect(() => {
    if (!hasScope("admin:groups")) {
      navigate("/");
      return;
    }
  }, [hasScope, navigate]);

  const fetchGroups = useCallback(async () => {
    try {
      const data = await api.listGroups();
      api.setCache("admin:groups", data);
      setGroups(data);
    } catch {
      toast.error("Failed to load groups");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
    fetchCAs();
    api
      .listNodes({ limit: 100 })
      .then((r) => {
        api.setCache("admin:scope-nodes", r.data ?? []);
        setNodesList(r.data ?? []);
      })
      .catch(() => {});
    api
      .listProxyHosts({ limit: 100 })
      .then((r) => {
        api.setCache("admin:scope-proxy-hosts", r.data ?? []);
        setProxyHostsList(r.data ?? []);
      })
      .catch(() => {});
    api
      .listDatabases({ limit: 200 })
      .then((r) => {
        api.setCache("admin:scope-databases", r.data ?? []);
        setDatabasesList(r.data ?? []);
      })
      .catch(() => {});
    if (
      scopeMatches(userScopes, "logs:schemas:view") ||
      scopeMatches(userScopes, "logs:manage") ||
      (deriveAllowedResourceIdsByScope(userScopes)["logs:schemas:view"]?.length ?? 0) > 0
    ) {
      api
        .listLoggingSchemas()
        .then((data) => {
          api.setCache("admin:scope-logging-schemas", data);
          setLoggingSchemasList(data);
        })
        .catch(() => {});
    }
  }, [fetchGroups, fetchCAs, userScopes]);

  useRealtime("group.changed", () => {
    fetchGroups();
  });

  useRealtime("user.changed", () => {
    fetchGroups();
  });

  useRealtime("ca.changed", () => {
    fetchCAs();
  });

  useRealtime("node.changed", () => {
    api
      .listNodes({ limit: 100 })
      .then((r) => {
        api.setCache("admin:scope-nodes", r.data ?? []);
        setNodesList(r.data ?? []);
      })
      .catch(() => {});
  });

  useRealtime("proxy.host.changed", () => {
    api
      .listProxyHosts({ limit: 100 })
      .then((r) => {
        api.setCache("admin:scope-proxy-hosts", r.data ?? []);
        setProxyHostsList(r.data ?? []);
      })
      .catch(() => {});
  });

  useRealtime("database.changed", () => {
    api
      .listDatabases({ limit: 200 })
      .then((r) => {
        api.setCache("admin:scope-databases", r.data ?? []);
        setDatabasesList(r.data ?? []);
      })
      .catch(() => {});
  });

  const openCreateDialog = useCallback(() => {
    setEditingGroup(null);
    setGroupDialogMode("edit");
    setFormName("");
    setFormDescription("");
    setFormParentId(null);
    setFormBaseScopes([]);
    setFormResources({});
    setFormRequireGateway2fa(false);
    setInitialResourceLimitedScopes([]);
    setScopeSearch("");
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    if (!embedded || createRequest === 0 || createRequest === lastCreateRequest.current) return;
    lastCreateRequest.current = createRequest;
    openCreateDialog();
  }, [createRequest, embedded, openCreateDialog]);

  const openEditDialog = (group: PermissionGroup) => {
    setEditingGroup(group);
    setGroupDialogMode(group.isBuiltin && !hasScope("admin:system") ? "readonly" : "edit");
    setFormName(group.name);
    setFormDescription(group.description ?? "");
    setFormParentId(group.parentId);
    const { baseScopes, resources } = parseScopesForForm(group.scopes);
    setFormBaseScopes(baseScopes);
    setFormResources(resources);
    setFormRequireGateway2fa(group.requireGateway2fa ?? false);
    setInitialResourceLimitedScopes(Object.keys(resources));
    setScopeSearch("");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (editingGroup?.isBuiltin) {
      setSaving(true);
      try {
        await api.updateGroup(editingGroup.id, { requireGateway2fa: formRequireGateway2fa });
        useDashboardBootstrapStore.getState().invalidate();
        toast.success("MFA policy updated");
        setDialogOpen(false);
        fetchGroups();
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to update MFA policy");
      } finally {
        setSaving(false);
      }
      return;
    }
    const missingResourceScope = findMissingRequiredResourceSelection(
      formBaseScopes,
      formResources,
      allowedResourceIdsByScope,
      initialResourceLimitedScopes
    );
    if (missingResourceScope) {
      toast.error(`Select at least one resource for ${missingResourceScope}`);
      return;
    }

    const finalScopes = buildFinalScopes(formBaseScopes, formResources);
    const normalizedName = formatGroupName(formName);
    setFormName(normalizedName);
    if (!normalizedName || finalScopes.length === 0) {
      toast.error("Name and at least one scope are required");
      return;
    }
    setSaving(true);
    try {
      if (editingGroup) {
        await api.updateGroup(editingGroup.id, {
          name: normalizedName,
          description: formDescription.trim() || null,
          scopes: finalScopes,
          parentId: formParentId,
          requireGateway2fa: formRequireGateway2fa,
        });
        useDashboardBootstrapStore.getState().invalidate();
        toast.success("Group updated");
      } else {
        await api.createGroup({
          name: normalizedName,
          description: formDescription.trim() || undefined,
          scopes: finalScopes,
          parentId: formParentId,
          requireGateway2fa: formRequireGateway2fa,
        });
        toast.success("Group created");
      }
      setDialogOpen(false);
      fetchGroups();
    } catch (err: any) {
      if (!handleLicenseApiError(err, "Permission groups")) {
        toast.error(err?.message ?? "Failed to save group");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (group: PermissionGroup) => {
    const ok = await confirm({
      title: "Delete Group",
      description: `Delete "${group.name}"? ${group.memberCount ? `${group.memberCount} user(s) are assigned — reassign them first.` : "This cannot be undone."}`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteGroup(group.id);
      toast.success("Group deleted");
      fetchGroups();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to delete group");
    }
  };

  const toggleScope = (scope: string) => {
    setFormBaseScopes((prev) => {
      if (prev.includes(scope)) {
        // Removing scope — also clear any resource restrictions
        setFormResources((r) => {
          const next = { ...r };
          delete next[scope];
          return next;
        });
        return prev.filter((s) => s !== scope);
      }
      const allowedResourceIds = allowedResourceIdsByScope[scope];
      if (allowedResourceIds?.length) {
        setFormResources((resources) => ({ ...resources, [scope]: allowedResourceIds }));
      }
      return [...prev, scope];
    });
  };

  const toggleResource = (scope: string, caId: string) => {
    setFormResources((prev) => {
      const current = prev[scope] || [];
      const next = current.includes(caId)
        ? current.filter((id) => id !== caId)
        : [...current, caId];
      return { ...prev, [scope]: next };
    });
  };

  const ownCount = buildFinalScopes(formBaseScopes, formResources).length;
  const groupDialogReadOnly = groupDialogMode === "readonly";
  const securityOnly = Boolean(editingGroup?.isBuiltin);
  const inheritedScopes = formParentId
    ? [
        ...new Set([
          ...(groups.find((g) => g.id === formParentId)?.scopes ?? []),
          ...(groups.find((g) => g.id === formParentId)?.inheritedScopes ?? []),
        ]),
      ]
    : [];
  const inheritedCount = inheritedScopes.length;
  const selectedCount = new Set([
    ...buildFinalScopes(formBaseScopes, formResources),
    ...inheritedScopes,
  ]).size;
  const visibleAssignableScopes = useMemo(() => {
    if (!groupDialogReadOnly) return assignableScopes;
    const selectedBases = new Set([...formBaseScopes, ...inheritedScopes]);
    const assignableValues = new Set(assignableScopes.map((scope) => scope.value));
    const selectedScopes = GROUP_ASSIGNABLE_SCOPES.filter(
      (scope) => selectedBases.has(scope.value) && !assignableValues.has(scope.value)
    );
    return [...assignableScopes, ...selectedScopes];
  }, [assignableScopes, formBaseScopes, groupDialogReadOnly, inheritedScopes]);
  const canManageFolders = hasAnyScope("admin:groups:folders:manage", "admin:system");
  const hasActiveFilters = listSearch.trim() !== "";
  const filteredGroups = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      [group.name, group.description, groups.find((parent) => parent.id === group.parentId)?.name]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query))
    );
  }, [groups, listSearch]);
  const filteredBuiltinGroups = useMemo(
    () => filteredGroups.filter((group) => group.isBuiltin),
    [filteredGroups]
  );
  const filteredCustomGroups = useMemo(
    () => filteredGroups.filter((group) => !group.isBuiltin),
    [filteredGroups]
  );
  const groupColumns: ResourceListColumn<PermissionGroup>[] = [
    {
      id: "group",
      label: "Group",
      width: "minmax(16rem, 1fr)",
      renderCell: (group) => {
        const parent = group.parentId
          ? groups.find((candidate) => candidate.id === group.parentId)
          : null;
        return (
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-muted">
              {group.isBuiltin ? (
                <ShieldCheck className="h-4 w-4 text-primary" />
              ) : (
                <Shield className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-medium">{group.name}</p>
                {group.isBuiltin && (
                  <Badge variant="secondary" size="inline">
                    Built-in
                  </Badge>
                )}
                {group.requireGateway2fa && (
                  <Badge variant="outline" size="inline">
                    MFA required
                  </Badge>
                )}
                {parent && (
                  <Badge variant="outline" size="inline">
                    Inherits {parent.name}
                  </Badge>
                )}
              </div>
              {group.description && (
                <p className="truncate text-xs text-muted-foreground">{group.description}</p>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "members",
      label: "Members",
      width: "8rem",
      renderCell: (group) => (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Users className="h-3.5 w-3.5" />
          {group.memberCount ?? 0}
        </span>
      ),
    },
    {
      id: "scopes",
      label: "Scopes",
      width: "10rem",
      renderCell: (group) => (
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">
            {(() => {
              const inheritedCount = group.inheritedScopes?.length ?? 0;
              const total = group.scopes.length + inheritedCount;
              const prefix =
                inheritedCount > 0 ? `${group.scopes.length}+${inheritedCount}` : total;
              return `${prefix} scope${total !== 1 ? "s" : ""}`;
            })()}
          </Badge>
        </div>
      ),
    },
    {
      id: "actions",
      label: "Actions",
      width: "5.75rem",
      align: "right",
      renderCell: (group) => {
        const canManage = !group.isBuiltin && canManageGroup(group);
        if (group.isBuiltin) return null;
        return (
          <div
            className="flex justify-end"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" disabled={!canManage}>
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(event) => {
                    event.stopPropagation();
                    openEditDialog(group);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDelete(group);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const content = (
    <>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <LiteModeBackButton />
              <div>
                <h1 className="text-2xl font-bold">Permission Groups</h1>
                <p className="text-sm text-muted-foreground">
                  {isLoading
                    ? "Loading permission groups..."
                    : `${groups.length} group${groups.length !== 1 ? "s" : ""} · Manage scoped access control`}
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
                {
                  label: "Create Group",
                  icon: <Plus className="h-4 w-4" />,
                  onClick: openCreateDialog,
                },
              ]}
            >
              {canManageFolders && (
                <Button variant="outline" onClick={() => createFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              <Button onClick={openCreateDialog}>
                <Plus className="h-4 w-4" />
                Create Group
              </Button>
            </ResponsiveHeaderActions>
          </div>
        )}

        <FolderedResourceList<PermissionGroup>
          resourceType="admin-group"
          realtimeChannel="group.changed"
          resources={filteredCustomGroups}
          systemFolders={[
            {
              id: "admin-groups-builtin",
              name: "Builtin",
              items: filteredBuiltinGroups,
            },
          ]}
          columns={groupColumns}
          search={{
            search: listSearch,
            onSearchChange: setListSearch,
            placeholder: "Search groups...",
            hasActiveFilters,
            onReset: () => setListSearch(""),
          }}
          loading={isLoading}
          loadingLabel="Loading permission groups..."
          emptyState={
            <EmptyState
              message="No permission groups found. Create one to get started."
              hasActiveFilters={hasActiveFilters}
              onReset={() => setListSearch("")}
            />
          }
          minWidth={760}
          canManageFolders={canManageFolders}
          canViewItem={(group) => group.isBuiltin || canManageGroup(group)}
          canReorganizeItem={(group) => canManageFolders && !group.isBuiltin}
          getResourceLabel={(group) => group.name}
          onItemClick={(group) => {
            if (group.isBuiltin || canManageGroup(group)) openEditDialog(group);
          }}
          onRefresh={fetchGroups}
          onCreateFolderRef={(fn) => {
            setCreateFolderAction(() => fn);
            onCreateFolderRef?.(fn);
          }}
        />
      </div>

      {/* Create / Edit Group Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editingGroup ? (groupDialogReadOnly ? "View Group" : "Edit Group") : "Create Group"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(formatGroupNameInput(e.target.value))}
                placeholder="e.g. cert-operator"
                disabled={groupDialogReadOnly || securityOnly}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Input
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Optional description"
                disabled={groupDialogReadOnly || securityOnly}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Inherit From</label>
              {editingGroup && groups.some((g) => g.parentId === editingGroup.id) ? (
                <>
                  <Input value="None" disabled />
                  <p className="text-xs text-muted-foreground">
                    This group has child groups — it cannot be nested under another group
                  </p>
                </>
              ) : (
                <>
                  <Select
                    value={formParentId ?? "__none__"}
                    onValueChange={(v) => setFormParentId(v === "__none__" ? null : v)}
                    disabled={groupDialogReadOnly || securityOnly}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {availableParentGroups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          {g.name}
                          {g.isBuiltin ? " (built-in)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Inherited permissions stay inline in their normal categories and cannot be
                    removed here
                  </p>
                </>
              )}
            </div>
            <div className="border border-border">
              <Input
                value={scopeSearch}
                onChange={(e) => setScopeSearch(e.target.value)}
                placeholder="Search scopes..."
                className="border-0 border-b border-border rounded-none h-9 text-sm focus-visible:ring-0"
              />
              <ScopeList
                scopes={visibleAssignableScopes}
                search={scopeSearch}
                selected={formBaseScopes}
                onToggle={toggleScope}
                resources={formResources}
                onToggleResource={toggleResource}
                cas={cas}
                nodes={nodesList}
                proxyHosts={proxyHostsList}
                databases={databasesList}
                loggingSchemas={loggingSchemasList}
                restrictableScopes={RESOURCE_SCOPABLE_SCOPES}
                allowedResourceIds={allowedResourceIdsByScope}
                inheritedScopes={inheritedScopes}
                inheritedFromName={groups.find((g) => g.id === formParentId)?.name}
                readOnly={groupDialogReadOnly || securityOnly}
                viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
              />
              <div className="border-t border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {selectedCount} scope{selectedCount !== 1 ? "s" : ""} selected
                  {inheritedCount > 0 && ` (${ownCount} own + ${inheritedCount} inherited)`}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 rounded border border-border px-3 py-3">
              <div>
                <p className="text-sm font-medium">Require two-factor authentication</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Applies only to Gateway email-based sign-in. OIDC MFA stays managed by the
                  identity provider.
                </p>
              </div>
              <Switch
                checked={formRequireGateway2fa}
                disabled={groupDialogReadOnly}
                onChange={setFormRequireGateway2fa}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {groupDialogReadOnly ? "Close" : "Cancel"}
            </Button>
            {!groupDialogReadOnly && (
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingGroup ? "Save Changes" : "Create Group"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return embedded ? content : <PageTransition>{content}</PageTransition>;
}
