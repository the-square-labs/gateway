import { ArchiveRestore, FolderPlus, Plus, ScrollText, Shield, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlTab } from "@/hooks/use-url-tab";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { AdminGroups } from "./AdminGroups";
import { AdminUsers } from "./AdminUsers";
import { AuditLog } from "./AuditLog";

type AdministrationTab = "users" | "groups" | "audit";

export function Administration() {
  const { hasScope } = useAuthStore();
  const [usersCreateRequest, setUsersCreateRequest] = useState(0);
  const [groupsCreateRequest, setGroupsCreateRequest] = useState(0);
  const [createUserFolderAction, setCreateUserFolderAction] = useState<(() => void) | null>(null);
  const [createGroupFolderAction, setCreateGroupFolderAction] = useState<(() => void) | null>(null);
  const [openDeletedUsersAction, setOpenDeletedUsersAction] = useState<(() => void) | null>(null);
  const [auditHeaderActionsEl, setAuditHeaderActionsEl] = useState<HTMLDivElement | null>(null);
  const canUsers = hasScope("admin:users");
  const canGroups = hasScope("admin:groups");
  const canAudit = hasScope("admin:audit");
  const canManageUserFolders = hasScope("admin:users:folders:manage");
  const canManageGroupFolders = hasScope("admin:groups:folders:manage");
  const canManageDeletedUsers = hasScope("admin:system");

  const availableTabs = useMemo<AdministrationTab[]>(() => {
    const tabs: AdministrationTab[] = [];
    if (canUsers) tabs.push("users");
    if (canGroups) tabs.push("groups");
    if (canAudit) tabs.push("audit");
    return tabs;
  }, [canAudit, canGroups, canUsers]);

  const [activeTab, setActiveTab] = useUrlTab(
    ["users", "groups", "audit"],
    availableTabs[0] ?? "users",
    (tab) => `/administration/${tab}`
  );

  useEffect(() => {
    if (availableTabs.length > 0 && !availableTabs.includes(activeTab as AdministrationTab)) {
      setActiveTab(availableTabs[0]);
    }
  }, [activeTab, availableTabs, setActiveTab]);

  useEffect(() => {
    if (canUsers) {
      api
        .listUsers()
        .then((data) => api.setCache("admin:users", data || []))
        .catch(() => {});
    }
    if (canGroups || canUsers) {
      api
        .listGroups()
        .then((data) => api.setCache("admin:groups", data))
        .catch(() => {});
    }
    if (canGroups) {
      api
        .listNodes({ limit: 100 })
        .then((result) => api.setCache("admin:scope-nodes", result.data ?? []))
        .catch(() => {});
      api
        .listProxyHosts({ limit: 100 })
        .then((result) => api.setCache("admin:scope-proxy-hosts", result.data ?? []))
        .catch(() => {});
      api
        .listDatabases({ limit: 200 })
        .then((result) => api.setCache("admin:scope-databases", result.data ?? []))
        .catch(() => {});
    }
    if (canAudit) {
      api
        .getAuditLog({ page: 1, limit: 100 })
        .then((result) => {
          api.setCache("admin:audit:all:all:all::", result.data || []);
          api.setCache("admin:audit:all:all:all:::total", result.pagination?.total ?? 0);
        })
        .catch(() => {});
    }
  }, [canAudit, canGroups, canUsers]);

  if (availableTabs.length === 0) {
    return <Navigate to="/" replace />;
  }

  const tabMeta: Record<
    AdministrationTab,
    { title: string; subtitle: string; actionLabel?: string; onAction?: () => void }
  > = {
    users: {
      title: "Users",
      subtitle: "Manage system users and their assigned permission groups",
      actionLabel: "Create User",
      onAction: () => setUsersCreateRequest((value) => value + 1),
    },
    groups: {
      title: "Groups",
      subtitle: "Manage permission groups and scoped access rules",
      actionLabel: "Create Group",
      onAction: () => setGroupsCreateRequest((value) => value + 1),
    },
    audit: {
      title: "Audit Log",
      subtitle: "Review administrative actions and system activity",
    },
  };

  const currentTab = (
    availableTabs.includes(activeTab as AdministrationTab) ? activeTab : availableTabs[0]
  ) as AdministrationTab;
  const currentMeta = tabMeta[currentTab];
  const usesFillLayout = currentTab === "audit";

  return (
    <PageTransition>
      <div
        className={
          usesFillLayout
            ? "flex h-full min-h-0 flex-col overflow-hidden p-6"
            : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <LiteModeBackButton />
              <div className="min-w-0">
                <h1 className="text-2xl font-bold">{currentMeta.title}</h1>
                <p className="text-sm text-muted-foreground">{currentMeta.subtitle}</p>
              </div>
            </div>
          </div>
          {currentMeta.actionLabel && currentMeta.onAction ? (
            <ResponsiveHeaderActions
              actions={[
                ...(currentTab === "users" && canManageUserFolders && createUserFolderAction
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: createUserFolderAction,
                      },
                    ]
                  : []),
                ...(currentTab === "users" && canManageDeletedUsers && openDeletedUsersAction
                  ? [
                      {
                        label: "Deleted Users",
                        icon: <ArchiveRestore className="h-4 w-4" />,
                        onClick: openDeletedUsersAction,
                      },
                    ]
                  : []),
                ...(currentTab === "groups" && canManageGroupFolders && createGroupFolderAction
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: createGroupFolderAction,
                      },
                    ]
                  : []),
                {
                  label: currentMeta.actionLabel,
                  icon: <Plus className="h-4 w-4" />,
                  onClick: currentMeta.onAction,
                },
              ]}
            >
              {currentTab === "users" && canManageUserFolders && (
                <Button variant="outline" onClick={() => createUserFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {currentTab === "users" && canManageDeletedUsers && openDeletedUsersAction && (
                <Button variant="outline" onClick={openDeletedUsersAction}>
                  <ArchiveRestore className="h-4 w-4" />
                  Deleted Users
                </Button>
              )}
              {currentTab === "groups" && canManageGroupFolders && (
                <Button variant="outline" onClick={() => createGroupFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              <Button onClick={currentMeta.onAction}>
                <Plus className="h-4 w-4" />
                {currentMeta.actionLabel}
              </Button>
            </ResponsiveHeaderActions>
          ) : currentTab === "audit" ? (
            <div ref={setAuditHeaderActionsEl} className="shrink-0" />
          ) : null}
        </div>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className={`flex flex-col ${usesFillLayout ? "mt-4 min-h-0 flex-1" : ""}`}
        >
          <TabsList>
            {canUsers && (
              <TabsTrigger value="users" className="gap-1.5">
                <Users className="h-3.5 w-3.5" />
                Users
              </TabsTrigger>
            )}
            {canGroups && (
              <TabsTrigger value="groups" className="gap-1.5">
                <Shield className="h-3.5 w-3.5" />
                Groups
              </TabsTrigger>
            )}
            {canAudit && (
              <TabsTrigger value="audit" className="gap-1.5">
                <ScrollText className="h-3.5 w-3.5" />
                Audit Log
              </TabsTrigger>
            )}
          </TabsList>

          {canUsers && (
            <TabsContent value="users" className="mt-4">
              <AdminUsers
                embedded
                createRequest={usersCreateRequest}
                onCreateFolderRef={(fn) => setCreateUserFolderAction(() => fn)}
                onOpenDeletedUsersRef={(fn) => setOpenDeletedUsersAction(() => fn)}
              />
            </TabsContent>
          )}
          {canGroups && (
            <TabsContent value="groups" className="mt-4">
              <AdminGroups
                embedded
                createRequest={groupsCreateRequest}
                onCreateFolderRef={(fn) => setCreateGroupFolderAction(() => fn)}
              />
            </TabsContent>
          )}
          {canAudit && (
            <TabsContent value="audit" className="mt-4 flex min-h-0 flex-1 flex-col">
              <AuditLog embedded headerActionsTarget={auditHeaderActionsEl} />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PageTransition>
  );
}
