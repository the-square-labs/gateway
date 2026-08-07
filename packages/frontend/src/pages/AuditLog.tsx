import { Download, EllipsisVertical, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
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
  DropdownMenuLabel,
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
import { formatRelativeDate } from "@/lib/utils";
import {
  type AuditExportFormat,
  buildAuditExportFilename,
  downloadTextFile,
  formatAuditExport,
  formatAuditToken,
  getAuditEntryUserKey,
  getAuditEntryUserLabel,
} from "@/pages/audit-log/audit-format";
import { api } from "@/services/api";
import type { AuditLogEntry } from "@/types";

const PAGE_SIZE = 100;
const DIALOG_CLOSE_RESET_MS = 260;
const AUDIT_VIEW_STORAGE_KEY = "gateway:audit-log:view";
const SYSTEM_USER_FILTER = "system";

interface AuditViewConfig {
  excludedActions: string[];
  excludedResourceTypes: string[];
}

interface AuditUserOption {
  id: string;
  label: string;
}

const DEFAULT_AUDIT_VIEW_CONFIG: AuditViewConfig = {
  excludedActions: [],
  excludedResourceTypes: [],
};
const DEFAULT_AUDIT_CACHE_KEY = "admin:audit:all:all:all::";
const AUDIT_ACTION_OPTIONS = [
  "access_list.create",
  "access_list.delete",
  "access_list.update",
  "api_token.create",
  "api_token.rename",
  "api_token.revoke",
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.settings_update",
  "auth.user_claimed",
  "auth.user_profile_sync",
  "auth.user_provisioned",
  "ca.create",
  "ca.delete",
  "ca.export_key",
  "ca.revoke",
  "ca.update",
  "cert.export_key",
  "cert.issue",
  "cert.revoke",
  "created",
  "database.connection.create",
  "database.connection.delete",
  "database.connection.test",
  "database.connection.update",
  "database.clickhouse.query",
  "database.postgres.query",
  "database.postgres.row.delete",
  "database.postgres.row.insert",
  "database.postgres.row.update",
  "database.redis.command.execute",
  "database.redis.key.delete",
  "database.redis.key.expire",
  "database.redis.key.set",
  "docker.container.create",
  "docker.container.duplicate",
  "docker.container.env.update",
  "docker.container.kill",
  "docker.container.live_update",
  "docker.container.recreate",
  "docker.container.remove",
  "docker.container.rename",
  "docker.container.restart",
  "docker.container.start",
  "docker.container.stop",
  "docker.container.update",
  "docker.deployment.create",
  "docker.deployment.delete",
  "docker.deployment.deploy",
  "docker.deployment.kill",
  "docker.deployment.restart",
  "docker.deployment.rollback",
  "docker.deployment.slot.stop",
  "docker.deployment.start",
  "docker.deployment.stop",
  "docker.deployment.switch",
  "docker.deployment.update",
  "docker_container.move_to_folder",
  "docker_container.reorder_in_folder",
  "docker.file.write",
  "docker_folder.create",
  "docker_folder.delete",
  "docker_folder.update",
  "docker.health_check.configure",
  "docker.health_check.test",
  "docker.image.prune",
  "docker.image.pull",
  "docker.image.remove",
  "docker.network.connect",
  "docker.network.create",
  "docker.network.disconnect",
  "docker.network.remove",
  "docker.registry.create",
  "docker.registry.delete",
  "docker.registry.update",
  "docker.secret.create",
  "docker.secret.delete",
  "docker.secret.update",
  "docker.volume.create",
  "docker.volume.remove",
  "docker.webhook.created",
  "docker.webhook.deleted",
  "docker.webhook.regenerated",
  "docker.webhook.triggered",
  "domain.create",
  "domain.delete",
  "domain.update",
  "expired",
  "group.create",
  "group.delete",
  "group.update",
  "nginx_template.clone",
  "nginx_template.create",
  "nginx_template.delete",
  "nginx_template.update",
  "node.cert_deploy",
  "node.config_push",
  "node.create",
  "node.disconnected",
  "node.enroll",
  "node.remove",
  "node.update",
  "notification_rule_created",
  "notification_rule_deleted",
  "notification_rule_updated",
  "notification_webhook_created",
  "notification_webhook_deleted",
  "notification_webhook_updated",
  "proxy_host.create",
  "proxy_host.delete",
  "proxy_host.move_to_folder",
  "proxy_host.update",
  "proxy_host_folder.create",
  "proxy_host_folder.delete",
  "proxy_host_folder.move",
  "proxy_host_folder.update",
  "pulled",
  "renewal_failed",
  "ssl.acme_dns01_start",
  "ssl.acme_dns01_verify",
  "ssl.acme_request",
  "ssl.delete",
  "ssl.link_internal",
  "ssl.renew",
  "ssl.upload",
  "transitioning",
  "updated",
  "user.create",
  "user.delete",
  "user.group_change",
] as const;
const AUDIT_RESOURCE_OPTIONS = [
  "access_list",
  "api-token",
  "ca",
  "certificate",
  "certificate_authority",
  "database",
  "docker-container",
  "docker-deployment",
  "docker-image",
  "docker-health-check",
  "docker-network",
  "docker-registry",
  "docker-secret",
  "docker-volume",
  "docker-webhook",
  "docker_folder",
  "domain",
  "http-route",
  "nginx_template",
  "node",
  "notification_alert_rule",
  "notification_webhook",
  "permission_group",
  "proxy_host",
  "proxy_host_folder",
  "session",
  "settings",
  "ssl_certificate",
  "user",
] as const;

function readAuditViewConfig(): AuditViewConfig {
  if (typeof window === "undefined") return DEFAULT_AUDIT_VIEW_CONFIG;
  try {
    const raw = window.localStorage.getItem(AUDIT_VIEW_STORAGE_KEY);
    if (!raw) return DEFAULT_AUDIT_VIEW_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AuditViewConfig>;
    return {
      excludedActions: Array.isArray(parsed.excludedActions) ? parsed.excludedActions : [],
      excludedResourceTypes: Array.isArray(parsed.excludedResourceTypes)
        ? parsed.excludedResourceTypes
        : [],
    };
  } catch {
    return DEFAULT_AUDIT_VIEW_CONFIG;
  }
}

function writeAuditViewConfig(config: AuditViewConfig) {
  window.localStorage.setItem(AUDIT_VIEW_STORAGE_KEY, JSON.stringify(config));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : uniqueSorted([...values, value]);
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function getAuditUserLabel(entry: AuditLogEntry): string {
  return entry.userName || entry.userEmail || "System";
}

function getAuditUserInitials(entry: AuditLogEntry): string {
  const label = getAuditUserLabel(entry);
  if (label === "System") return "SY";
  return label
    .split(/[\s@._-]+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function getAuditResourceNameFromDetails(details: AuditLogEntry["details"]): string | null {
  if (!details) return null;
  for (const key of [
    "newName",
    "name",
    "displayName",
    "hostname",
    "commonName",
    "cn",
    "domain",
    "containerName",
    "imageRef",
    "key",
  ]) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  for (const key of ["domainNames", "domains"]) {
    const value = details[key];
    if (!Array.isArray(value)) continue;
    const names = value.filter((item): item is string => typeof item === "string" && !!item.trim());
    if (names.length) return names.join(", ");
  }
  return null;
}

function getAuditResourceDisplay(entry: AuditLogEntry): { label: string; title: string } {
  const resourceName = entry.resourceName ?? getAuditResourceNameFromDetails(entry.details);
  const resourceValue = resourceName ?? entry.resourceId;
  const resourceType = formatAuditToken(entry.resourceType);
  const label = resourceValue ? `${resourceType} / ${resourceValue}` : resourceType;
  const title =
    resourceName && entry.resourceId && resourceName !== entry.resourceId
      ? `${label} (${entry.resourceId})`
      : label;
  return { label, title };
}

const columns: DataTableColumn<AuditLogEntry>[] = [
  {
    key: "user",
    header: "User",
    width: "minmax(180px, 1fr)",
    truncate: true,
    render: (entry) => {
      const label = getAuditUserLabel(entry);
      const isSystem = label === "System";
      return (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-[10px]">
              {isSystem ? <Settings className="h-3.5 w-3.5" /> : getAuditUserInitials(entry)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{label}</span>
        </span>
      );
    },
  },
  {
    key: "action",
    header: "Action",
    width: "minmax(180px, 1fr)",
    render: (entry) => (
      <span title={entry.action} className="text-muted-foreground">
        {formatAuditToken(entry.action)}
      </span>
    ),
  },
  {
    key: "resource",
    header: "Resource",
    width: "minmax(260px, 1.6fr)",
    truncate: true,
    render: (entry) => {
      const resource = getAuditResourceDisplay(entry);
      return (
        <span className="text-muted-foreground" title={resource.title}>
          {resource.label}
        </span>
      );
    },
  },
  {
    key: "ip",
    header: "IP Address",
    width: "minmax(160px, 0.75fr)",
    truncate: true,
    render: (entry) => (
      <span
        className="font-mono text-xs text-muted-foreground"
        title={entry.ipAddress ?? undefined}
      >
        {entry.ipAddress || "—"}
      </span>
    ),
  },
  {
    key: "time",
    header: "Time",
    width: "minmax(130px, 0.65fr)",
    align: "right",
    render: (entry) => (
      <span className="text-muted-foreground">{formatRelativeDate(entry.createdAt)}</span>
    ),
  },
];

export function AuditLog({
  embedded = false,
  headerActionsTarget,
}: {
  embedded?: boolean;
  headerActionsTarget?: HTMLElement | null;
}) {
  const initialViewConfig = useMemo(() => readAuditViewConfig(), []);
  const initialAuditCacheKey =
    initialViewConfig.excludedActions.length > 0 ||
    initialViewConfig.excludedResourceTypes.length > 0
      ? `admin:audit:all:all:all:${initialViewConfig.excludedActions.join(",")}:${initialViewConfig.excludedResourceTypes.join(",")}`
      : DEFAULT_AUDIT_CACHE_KEY;
  const [entries, setEntries] = useState<AuditLogEntry[]>(
    () => api.getCached<AuditLogEntry[]>(initialAuditCacheKey) ?? []
  );
  const [selectedEntry, setSelectedEntry] = useState<AuditLogEntry | null>(null);
  const [entryDetailsOpen, setEntryDetailsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(
    () => api.getCached<AuditLogEntry[]>(initialAuditCacheKey) === undefined
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(
    () => api.getCached<number>(`${initialAuditCacheKey}:total`) ?? 0
  );
  const [actionFilter, setActionFilter] = useState("all");
  const [resourceFilter, setResourceFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");
  const [knownUsers, setKnownUsers] = useState<AuditUserOption[]>([]);
  const [viewConfig, setViewConfig] = useState<AuditViewConfig>(initialViewConfig);
  const [draftViewConfig, setDraftViewConfig] = useState<AuditViewConfig>(viewConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<AuditExportFormat>("csv");
  const [exportActions, setExportActions] = useState<string[]>([]);
  const [exportResourceTypes, setExportResourceTypes] = useState<string[]>([]);
  const [exportUserIds, setExportUserIds] = useState<string[]>([]);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exporting, setExporting] = useState(false);

  const pageRef = useRef(0);
  const requestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const configSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingViewConfigRef = useRef<AuditViewConfig | null>(null);
  const selectedEntryResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const actionOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...AUDIT_ACTION_OPTIONS,
          ...viewConfig.excludedActions,
          ...entries.map((entry) => entry.action),
        ])
      ).sort(),
    [entries, viewConfig.excludedActions]
  );
  const resourceOptions = useMemo(
    () =>
      Array.from(
        new Set([
          ...AUDIT_RESOURCE_OPTIONS,
          ...viewConfig.excludedResourceTypes,
          ...entries.map((entry) => entry.resourceType),
        ])
      ).sort(),
    [entries, viewConfig.excludedResourceTypes]
  );
  const userOptions = useMemo(
    () => [...knownUsers].sort((a, b) => a.label.localeCompare(b.label)),
    [knownUsers]
  );
  const hiddenFilterCount =
    viewConfig.excludedActions.length + viewConfig.excludedResourceTypes.length;
  const auditCacheKey = useMemo(
    () =>
      `admin:audit:${actionFilter}:${resourceFilter}:${userFilter}:${viewConfig.excludedActions.join(",")}:${viewConfig.excludedResourceTypes.join(",")}`,
    [actionFilter, resourceFilter, userFilter, viewConfig]
  );

  const rememberUsers = useCallback((items: AuditLogEntry[]) => {
    setKnownUsers((prev) => {
      const next = new Map(prev.map((user) => [user.id, user]));
      for (const entry of items) {
        const id = getAuditEntryUserKey(entry);
        next.set(id, { id, label: getAuditEntryUserLabel(entry) });
      }
      return [...next.values()];
    });
  }, []);

  const fetchPage = useCallback(
    async (resetTo: AuditLogEntry[] | null) => {
      const nextPage = resetTo ? 1 : pageRef.current + 1;
      const requestId = ++requestIdRef.current;
      if (resetTo) {
        const cached = api.getCached<AuditLogEntry[]>(auditCacheKey);
        if (cached) {
          const cachedTotal = api.getCached<number>(`${auditCacheKey}:total`) ?? cached.length;
          pageRef.current = 1;
          setEntries(cached);
          setTotal(cachedTotal);
          setHasMore(cached.length < cachedTotal);
          setIsLoading(false);
        } else {
          pageRef.current = 0;
          setEntries([]);
          setTotal(0);
          setIsLoading(true);
          setHasMore(true);
        }
      } else {
        setLoadingMore(true);
      }
      try {
        const result = await api.getAuditLog({
          page: nextPage,
          limit: PAGE_SIZE,
          action: actionFilter !== "all" ? actionFilter : undefined,
          resourceType: resourceFilter !== "all" ? resourceFilter : undefined,
          userId: userFilter !== "all" ? userFilter : undefined,
          excludedActions: viewConfig.excludedActions,
          excludedResourceTypes: viewConfig.excludedResourceTypes,
        });
        if (requestId !== requestIdRef.current) return; // stale (filters changed mid-flight)
        const fetched: AuditLogEntry[] = result.data || [];
        rememberUsers(fetched);
        const totalPages = result.pagination?.totalPages ?? 1;
        const nextTotal = result.pagination?.total ?? 0;
        setTotal(nextTotal);
        pageRef.current = nextPage;
        setEntries((prev) => {
          const next = resetTo ? fetched : [...prev, ...fetched];
          if (resetTo) {
            api.setCache(auditCacheKey, next);
            api.setCache(`${auditCacheKey}:total`, nextTotal);
          }
          return next;
        });
        setHasMore(nextPage < totalPages);
      } catch {
        /* ignore */
      } finally {
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [actionFilter, auditCacheKey, resourceFilter, userFilter, viewConfig, rememberUsers]
  );

  const openConfigureDialog = () => {
    if (configSaveTimerRef.current) {
      clearTimeout(configSaveTimerRef.current);
      configSaveTimerRef.current = null;
    }
    const pendingConfig = pendingViewConfigRef.current;
    if (pendingConfig) {
      pendingViewConfigRef.current = null;
      setViewConfig(pendingConfig);
      setDraftViewConfig(pendingConfig);
    } else {
      setDraftViewConfig(viewConfig);
    }
    setConfigOpen(true);
  };

  const closeConfigureDialog = () => {
    setConfigOpen(false);
  };

  const handleConfigureOpenChange = (open: boolean) => {
    if (open) {
      setConfigOpen(true);
      return;
    }
    closeConfigureDialog();
  };

  const saveViewConfig = () => {
    const next = {
      excludedActions: uniqueSorted(draftViewConfig.excludedActions),
      excludedResourceTypes: uniqueSorted(draftViewConfig.excludedResourceTypes),
    };
    writeAuditViewConfig(next);
    closeConfigureDialog();
    if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
    pendingViewConfigRef.current = next;
    configSaveTimerRef.current = setTimeout(() => {
      if (pendingViewConfigRef.current) {
        setViewConfig(pendingViewConfigRef.current);
        pendingViewConfigRef.current = null;
      }
      configSaveTimerRef.current = null;
    }, DIALOG_CLOSE_RESET_MS);
  };

  const resetViewConfig = () => {
    setDraftViewConfig(DEFAULT_AUDIT_VIEW_CONFIG);
  };

  const openExportDialog = (format: AuditExportFormat) => {
    setExportFormat(format);
    setExportActions(actionFilter !== "all" ? [actionFilter] : []);
    setExportResourceTypes(resourceFilter !== "all" ? [resourceFilter] : []);
    setExportUserIds(userFilter !== "all" ? [userFilter] : []);
    setExportFrom("");
    setExportTo("");
    setExportOpen(true);
  };

  const closeExportDialog = () => {
    setExportOpen(false);
  };

  const handleExportOpenChange = (open: boolean) => {
    if (open) {
      setExportOpen(true);
      return;
    }
    closeExportDialog();
  };

  const openEntryDetails = (entry: AuditLogEntry) => {
    if (selectedEntryResetTimerRef.current) {
      clearTimeout(selectedEntryResetTimerRef.current);
      selectedEntryResetTimerRef.current = null;
    }
    setSelectedEntry(entry);
    setEntryDetailsOpen(true);
  };

  const closeEntryDetails = () => {
    setEntryDetailsOpen(false);
    if (selectedEntryResetTimerRef.current) clearTimeout(selectedEntryResetTimerRef.current);
    selectedEntryResetTimerRef.current = setTimeout(() => {
      setSelectedEntry(null);
      selectedEntryResetTimerRef.current = null;
    }, DIALOG_CLOSE_RESET_MS);
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const exportedEntries: AuditLogEntry[] = [];
      let page = 1;
      while (true) {
        const result = await api.getAuditLog({
          page,
          limit: PAGE_SIZE,
          actions: exportActions,
          resourceTypes: exportResourceTypes,
          userIds: exportUserIds,
          from: localDateTimeToIso(exportFrom),
          to: localDateTimeToIso(exportTo),
          excludedActions: viewConfig.excludedActions,
          excludedResourceTypes: viewConfig.excludedResourceTypes,
        });
        exportedEntries.push(...(result.data ?? []));
        const totalPages = result.pagination?.totalPages ?? 1;
        if (page >= totalPages) break;
        page += 1;
      }
      const { content, type } = formatAuditExport(exportedEntries, exportFormat);
      downloadTextFile(content, buildAuditExportFilename(exportFormat), type);
      closeExportDialog();
      toast.success(`Exported ${exportedEntries.length} audit log entries`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export audit log");
    } finally {
      setExporting(false);
    }
  };

  // Initial load + reset on filter change
  useEffect(() => {
    pageRef.current = 0;
    fetchPage([]);
  }, [fetchPage]);

  useEffect(() => {
    return () => {
      if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
      if (selectedEntryResetTimerRef.current) clearTimeout(selectedEntryResetTimerRef.current);
    };
  }, []);

  useEffect(() => {
    api
      .getAuditUsers()
      .then((users) => {
        setKnownUsers(
          users.map((user) => ({
            id: user.userId ?? SYSTEM_USER_FILTER,
            label: user.userName || user.userEmail || (user.userId ? user.userId : "System"),
          }))
        );
      })
      .catch(() => {});
  }, []);

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loadingMore && !isLoading) {
          fetchPage(null);
        }
      },
      { root, rootMargin: "400px" }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [fetchPage, hasMore, loadingMore, isLoading]);

  const auditActions = (
    <ResponsiveHeaderActions
      actions={[
        {
          label: "Configure",
          icon: <Settings className="h-4 w-4" />,
          onClick: openConfigureDialog,
        },
        {
          label: "Download CSV",
          icon: <Download className="h-4 w-4" />,
          onClick: () => openExportDialog("csv"),
          separatorBefore: true,
        },
        {
          label: "Download TSV",
          icon: <Download className="h-4 w-4" />,
          onClick: () => openExportDialog("tsv"),
        },
        {
          label: "Download TXT",
          icon: <Download className="h-4 w-4" />,
          onClick: () => openExportDialog("txt"),
        },
        {
          label: "Download HTML",
          icon: <Download className="h-4 w-4" />,
          onClick: () => openExportDialog("html"),
        },
      ]}
    >
      <Button variant="outline" onClick={openConfigureDialog}>
        <Settings className="h-4 w-4" />
        Configure
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Audit log actions">
            <EllipsisVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Download</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openExportDialog("csv")}>
            <Download className="h-4 w-4" />
            CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openExportDialog("tsv")}>
            <Download className="h-4 w-4" />
            TSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openExportDialog("txt")}>
            <Download className="h-4 w-4" />
            TXT
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openExportDialog("html")}>
            <Download className="h-4 w-4" />
            HTML
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ResponsiveHeaderActions>
  );

  const headerActionsPortal =
    embedded && headerActionsTarget ? createPortal(auditActions, headerActionsTarget) : null;

  const content = (
    <>
      {headerActionsPortal}
      <div
        className={
          embedded
            ? "h-full space-y-4 flex flex-col min-h-0"
            : "h-full p-6 space-y-4 flex flex-col min-h-0"
        }
      >
        {!embedded && (
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <LiteModeBackButton />
              <div>
                <h1 className="text-2xl font-bold">Audit Log</h1>
                <p className="text-sm text-muted-foreground">
                  {total} entries
                  {hiddenFilterCount ? ` · ${hiddenFilterCount} hidden by local view` : ""}
                </p>
              </div>
            </div>
            {auditActions}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="w-48">
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actionOptions.map((action) => (
                  <SelectItem key={action} value={action}>
                    {formatAuditToken(action)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-48">
            <Select value={resourceFilter} onValueChange={setResourceFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All resources</SelectItem>
                {resourceOptions.map((resourceType) => (
                  <SelectItem key={resourceType} value={resourceType}>
                    {formatAuditToken(resourceType)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-56">
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All users</SelectItem>
                {userOptions.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <DataTable
            columns={columns}
            data={entries}
            keyFn={(e) => e.id}
            loading={isLoading && entries.length === 0}
            onRowClick={openEntryDetails}
            scrollRef={scrollRef}
            horizontalScroll
            minWidth="1000px"
            emptyMessage="No audit log entries found"
            footer={
              <div ref={sentinelRef} className="py-4 text-center text-xs text-muted-foreground">
                {loadingMore ? "Loading more…" : !hasMore && entries.length > 0 ? "End of log" : ""}
              </div>
            }
          />
        </div>
      </div>

      <Dialog open={configOpen} onOpenChange={handleConfigureOpenChange}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Configure Audit View</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-1 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
            <AuditOptionChecklist
              title="Hidden Actions"
              description="Checked actions are excluded by the backend before pagination."
              options={actionOptions.map((action) => ({ value: action, label: action }))}
              selected={draftViewConfig.excludedActions}
              onToggle={(value) =>
                setDraftViewConfig((draft) => ({
                  ...draft,
                  excludedActions: toggleValue(draft.excludedActions, value),
                }))
              }
              viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
            />
            <AuditOptionChecklist
              title="Hidden Resources"
              description="Checked resources are excluded by the backend before pagination."
              options={resourceOptions.map((resourceType) => ({
                value: resourceType,
                label: resourceType,
              }))}
              selected={draftViewConfig.excludedResourceTypes}
              onToggle={(value) =>
                setDraftViewConfig((draft) => ({
                  ...draft,
                  excludedResourceTypes: toggleValue(draft.excludedResourceTypes, value),
                }))
              }
              viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetViewConfig}>
              Reset
            </Button>
            <Button onClick={saveViewConfig}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={handleExportOpenChange}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Download Audit Log</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 px-1">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">From</label>
                <Input
                  type="datetime-local"
                  value={exportFrom}
                  onChange={(event) => setExportFrom(event.target.value)}
                  className="audit-date-input [&::-webkit-calendar-picker-indicator]:hidden"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">To</label>
                <Input
                  type="datetime-local"
                  value={exportTo}
                  onChange={(event) => setExportTo(event.target.value)}
                  className="audit-date-input [&::-webkit-calendar-picker-indicator]:hidden"
                />
              </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <AuditOptionChecklist
                title="Actions"
                description="Leave empty to export all visible actions."
                options={actionOptions.map((action) => ({ value: action, label: action }))}
                selected={exportActions}
                onToggle={(value) => setExportActions((values) => toggleValue(values, value))}
                emptyMessage="No actions available."
                viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
              />
              <AuditOptionChecklist
                title="Resources"
                description="Leave empty to export all visible resources."
                options={resourceOptions.map((resourceType) => ({
                  value: resourceType,
                  label: resourceType,
                }))}
                selected={exportResourceTypes}
                onToggle={(value) => setExportResourceTypes((values) => toggleValue(values, value))}
                emptyMessage="No resources available."
                viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
              />
              <AuditOptionChecklist
                title="Users"
                description="Leave empty to export all users."
                options={userOptions.map((user) => ({ value: user.id, label: user.label }))}
                selected={exportUserIds}
                onToggle={(value) => setExportUserIds((values) => toggleValue(values, value))}
                emptyMessage="Load audit entries to populate users."
                viewportClassName="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeExportDialog} disabled={exporting}>
              Cancel
            </Button>
            <Button onClick={() => void runExport()} disabled={exporting}>
              {exporting ? "Exporting..." : `Download ${exportFormat.toUpperCase()}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={entryDetailsOpen} onOpenChange={(open) => !open && closeEntryDetails()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Audit Entry Details</DialogTitle>
          </DialogHeader>
          {selectedEntry ? (
            <div className="min-w-0 space-y-4 pr-1">
              <div className="grid gap-3 text-sm sm:grid-cols-6">
                <AuditDetail
                  className="sm:col-span-2"
                  label="Action"
                  value={selectedEntry.action}
                />
                <AuditDetail
                  className="sm:col-span-2"
                  label="Time"
                  value={new Date(selectedEntry.createdAt).toLocaleString()}
                />
                <AuditDetail
                  className="sm:col-span-2"
                  label="Resource Type"
                  value={selectedEntry.resourceType}
                />
                <AuditDetail
                  className="sm:col-span-3"
                  label="Resource ID"
                  value={selectedEntry.resourceId}
                />
                <AuditDetail
                  className="sm:col-span-3"
                  label="User ID"
                  value={selectedEntry.userId}
                />
                <AuditDetail
                  className="sm:col-span-3"
                  label="User"
                  value={selectedEntry.userName || selectedEntry.userEmail || "System"}
                />
                <AuditDetail
                  className="sm:col-span-3"
                  label="IP Address"
                  value={selectedEntry.ipAddress}
                />
                {selectedEntry.userAgent && (
                  <AuditDetail
                    className="sm:col-span-6"
                    label="User Agent"
                    value={selectedEntry.userAgent}
                    wrap
                  />
                )}
              </div>
              <div className="border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-medium">Details</h3>
                </div>
                <pre className="overflow-x-auto p-4 text-xs whitespace-pre-wrap">
                  {JSON.stringify(selectedEntry.details ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );

  return embedded ? content : <PageTransition>{content}</PageTransition>;
}

function AuditDetail({
  label,
  value,
  className = "",
  wrap = false,
}: {
  label: string;
  value?: string | null;
  className?: string;
  wrap?: boolean;
}) {
  const displayValue = value || "-";
  return (
    <div className={`min-w-0 rounded-md border border-border p-3 ${className}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-mono text-xs ${wrap ? "break-all" : "truncate"}`} title={displayValue}>
        {displayValue}
      </p>
    </div>
  );
}

function AuditOptionChecklist({
  title,
  description,
  options,
  selected,
  onToggle,
  emptyMessage = "No options available.",
  viewportClassName,
}: {
  title: string;
  description: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string) => void;
  emptyMessage?: string;
  viewportClassName?: string;
}) {
  return (
    <PanelShell
      title={title}
      description={description}
      className="min-h-0"
      headerClassName="px-3 py-2"
      bodyClassName={viewportClassName}
    >
      <div>
        {options.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          options.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
            >
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => onToggle(option.value)}
                className="form-checkbox"
              />
              <span className="min-w-0 truncate font-mono text-xs" title={option.label}>
                {option.label}
              </span>
            </label>
          ))
        )}
      </div>
    </PanelShell>
  );
}
