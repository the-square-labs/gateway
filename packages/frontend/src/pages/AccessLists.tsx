import { Minus, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useInitialLoading } from "@/hooks/use-initial-loading";
import { useRealtime } from "@/hooks/use-realtime";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { AccessList, IPRule } from "@/types";

interface BasicAuthInput {
  username: string;
  password: string;
}

export function AccessLists() {
  const { hasScope } = useAuthStore();
  const canCreateAccessList = hasScope("acl:create");
  const canEditAccessList = (id: string) => hasScope("acl:edit") || hasScope(`acl:edit:${id}`);
  const canDeleteAccessList = (id: string) =>
    hasScope("acl:delete") || hasScope(`acl:delete:${id}`);
  const cachedAccessLists = api.getCached<{ data: AccessList[] }>("access-lists:list");
  const [accessLists, setAccessLists] = useState<AccessList[]>(cachedAccessLists?.data ?? []);
  const [isLoading, setIsLoading] = useState(!cachedAccessLists);
  const initialLoading = useInitialLoading(isLoading);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AccessList | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ipRules, setIpRules] = useState<IPRule[]>([]);
  const [basicAuthEnabled, setBasicAuthEnabled] = useState(false);
  const [basicAuthUsers, setBasicAuthUsers] = useState<BasicAuthInput[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const loadAccessLists = useCallback(async () => {
    try {
      const res = await api.listAccessLists();
      setAccessLists(res.data || []);
    } catch {
      toast.error("Failed to load access lists");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccessLists();
  }, [loadAccessLists]);

  useRealtime("access-list.changed", () => {
    loadAccessLists();
  });

  const resetForm = () => {
    setName("");
    setDescription("");
    setIpRules([]);
    setBasicAuthEnabled(false);
    setBasicAuthUsers([]);
  };

  const openCreate = () => {
    setEditing(null);
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (al: AccessList) => {
    setEditing(al);
    setName(al.name);
    setDescription(al.description || "");
    setIpRules(al.ipRules || []);
    setBasicAuthEnabled(al.basicAuthEnabled);
    // Don't pre-fill passwords for edit
    setBasicAuthUsers(
      (al.basicAuthUsers || []).map((u) => ({ username: u.username, password: "" }))
    );
    setDialogOpen(true);
  };

  const addIpRule = () => setIpRules((prev) => [...prev, { type: "allow", value: "" }]);
  const updateIpRule = (index: number, field: keyof IPRule, value: string) => {
    setIpRules((prev) =>
      prev.map((rule, candidateIndex) =>
        candidateIndex === index ? { ...rule, [field]: value } : rule
      )
    );
  };
  const removeIpRule = (index: number) => {
    setIpRules((prev) => prev.filter((_, candidateIndex) => candidateIndex !== index));
  };
  const addBasicAuthUser = () => {
    setBasicAuthUsers((prev) => [...prev, { username: "", password: "" }]);
  };
  const updateBasicAuthUser = (index: number, field: keyof BasicAuthInput, value: string) => {
    setBasicAuthUsers((prev) =>
      prev.map((user, candidateIndex) =>
        candidateIndex === index ? { ...user, [field]: value } : user
      )
    );
  };
  const removeBasicAuthUser = (index: number) => {
    setBasicAuthUsers((prev) => prev.filter((_, candidateIndex) => candidateIndex !== index));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }

    setIsSaving(true);
    try {
      const nextBasicAuthUsers = basicAuthEnabled
        ? basicAuthUsers
            .filter((u) => u.username.trim() !== "" && (editing || u.password.trim() !== ""))
            .map((u) => ({ username: u.username.trim(), password: u.password }))
        : undefined;
      const data = {
        name,
        description: description || undefined,
        ipRules: ipRules.filter((r) => r.value.trim() !== ""),
        basicAuthEnabled,
        basicAuthUsers: nextBasicAuthUsers,
      };

      if (editing) {
        await api.updateAccessList(editing.id, data);
        toast.success("Access list updated");
      } else {
        await api.createAccessList(data);
        toast.success("Access list created");
      }
      setDialogOpen(false);
      await loadAccessLists();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save access list");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (al: AccessList) => {
    const ok = await confirm({
      title: "Delete Access List",
      description: `Are you sure you want to delete "${al.name}"? This action cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.deleteAccessList(al.id);
      toast.success("Access list deleted");
      loadAccessLists();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete access list");
    }
  };

  const accessListColumns: SimpleTableColumn<AccessList>[] = [
    {
      id: "name",
      header: "Name",
      render: (al) => <p className="text-sm font-medium">{al.name}</p>,
    },
    {
      id: "description",
      header: "Description",
      render: (al) => (
        <p className="line-clamp-1 text-sm text-muted-foreground">{al.description || "—"}</p>
      ),
    },
    {
      id: "ip-rules",
      header: "IP Rules",
      render: (al) => (
        <Badge variant="secondary" className="gap-1">
          <span>{(al.ipRules || []).length}</span>
          <span>rules</span>
        </Badge>
      ),
    },
    {
      id: "auth-users",
      header: "Auth Users",
      render: (al) => (
        <Badge variant={al.basicAuthEnabled ? "secondary" : "outline"} className="gap-1">
          {al.basicAuthEnabled ? (
            <>
              <span>{(al.basicAuthUsers || []).length}</span>
              <span>users</span>
            </>
          ) : (
            <span>Disabled</span>
          )}
        </Badge>
      ),
    },
    {
      id: "usage",
      header: "Usage",
      render: (al) => (
        <span className="text-sm text-muted-foreground">{al.usageCount ?? 0} hosts</span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      className: "w-12",
      cellClassName: "w-12",
      render: (al) =>
        canEditAccessList(al.id) || canDeleteAccessList(al.id) ? (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEditAccessList(al.id) && (
                  <DropdownMenuItem onClick={() => openEdit(al)}>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                )}
                {canDeleteAccessList(al.id) && (
                  <DropdownMenuItem onClick={() => handleDelete(al)} className="text-destructive">
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null,
    },
  ];

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Access Lists</h1>
              <p className="text-sm text-muted-foreground">
                Manage IP rules and basic authentication
              </p>
            </div>
          </div>
          {canCreateAccessList && (
            <ResponsiveHeaderActions
              actions={[
                {
                  label: "Add Access List",
                  icon: <Plus className="h-4 w-4" />,
                  onClick: openCreate,
                },
              ]}
            >
              <Button onClick={openCreate}>
                <Plus className="h-4 w-4" />
                Add Access List
              </Button>
            </ResponsiveHeaderActions>
          )}
        </div>

        {/* Table */}
        {initialLoading && accessLists.length === 0 ? (
          <Skeleton />
        ) : accessLists.length > 0 ? (
          <div className="border border-border bg-card">
            <SimpleTable
              columns={accessListColumns}
              rows={accessLists}
              getRowKey={(al) => al.id}
              loading={isLoading}
              loadingMessage="Loading access lists"
              onRowClick={(accessList) => {
                if (canEditAccessList(accessList.id)) openEdit(accessList);
              }}
            />
          </div>
        ) : (
          <EmptyState
            message="No access lists."
            {...(canCreateAccessList ? { actionLabel: "Create one", onAction: openCreate } : {})}
          />
        )}

        {/* Create/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Access List" : "Create Access List"}</DialogTitle>
              <DialogDescription>
                {editing
                  ? "Update access list settings"
                  : "Create a new access list with IP rules and optional basic authentication"}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-6">
              {/* Basic info */}
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Office Only"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Description</label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                  />
                </div>
              </div>

              {/* IP Rules */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">IP Rules</h3>
                <div className="overflow-hidden border border-border">
                  <div className="grid grid-cols-[9rem_minmax(0,1fr)_2.25rem] border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <div className="px-3 py-2">Type</div>
                    <div className="border-l border-border px-3 py-2">Address / CIDR</div>
                    <div />
                  </div>
                  <div>
                    {ipRules.map((rule, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-[9rem_minmax(0,1fr)_2.25rem] border-b border-border last:border-b-0"
                      >
                        <Select
                          value={rule.type}
                          onValueChange={(value) =>
                            updateIpRule(index, "type", value as IPRule["type"])
                          }
                        >
                          <SelectTrigger className="h-9 rounded-none border-0 shadow-none focus:ring-1 focus:ring-inset focus:ring-ring focus:ring-offset-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="allow">Allow</SelectItem>
                            <SelectItem value="deny">Deny</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          value={rule.value}
                          onChange={(event) => updateIpRule(index, "value", event.target.value)}
                          className="h-9 rounded-none border-0 border-l border-border shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                          placeholder="192.168.1.0/24 or IP address"
                        />
                        <div className="flex border-l border-border">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 rounded-none"
                            onClick={() => removeIpRule(index)}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] bg-muted/60 dark:bg-muted">
                      <button
                        type="button"
                        className="h-9 min-w-0 cursor-pointer"
                        aria-label="Add IP rule"
                        onClick={addIpRule}
                      />
                      <div className="flex border-l border-border">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 rounded-none"
                          onClick={addIpRule}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Basic Auth */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Switch checked={basicAuthEnabled} onChange={setBasicAuthEnabled} />
                  <span className="text-sm font-semibold">Basic Authentication</span>
                </div>

                {basicAuthEnabled && (
                  <div className="space-y-3">
                    <div className="overflow-hidden border border-border">
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] border-b border-border bg-muted text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <div className="px-3 py-2">Username</div>
                        <div className="border-l border-border px-3 py-2">Password</div>
                        <div />
                      </div>
                      <div>
                        {basicAuthUsers.map((user, index) => (
                          <div
                            key={index}
                            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] border-b border-border last:border-b-0"
                          >
                            <Input
                              placeholder="Username"
                              value={user.username}
                              onChange={(event) =>
                                updateBasicAuthUser(index, "username", event.target.value)
                              }
                              className="h-9 rounded-none border-0 shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            />
                            <Input
                              type="password"
                              placeholder={
                                editing ? "New password (leave blank to keep)" : "Password"
                              }
                              value={user.password}
                              onChange={(event) =>
                                updateBasicAuthUser(index, "password", event.target.value)
                              }
                              className="h-9 rounded-none border-0 border-l border-border shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            />
                            <div className="flex border-l border-border">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-9 w-9 shrink-0 rounded-none"
                                onClick={() => removeBasicAuthUser(index)}
                              >
                                <Minus className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        ))}
                        <div className="grid grid-cols-[minmax(0,1fr)_2.25rem] bg-muted/60 dark:bg-muted">
                          <button
                            type="button"
                            className="h-9 min-w-0 cursor-pointer"
                            aria-label="Add auth user"
                            onClick={addBasicAuthUser}
                          />
                          <div className="flex border-l border-border">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0 rounded-none"
                              onClick={addBasicAuthUser}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter className="shrink-0">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving ? "Saving..." : editing ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageTransition>
  );
}
