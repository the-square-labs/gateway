import { AnimatePresence, motion } from "framer-motion";
import { Database as DatabaseIcon, FolderPlus, Plus, RefreshCw, ServerCog } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { databaseRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type {
  DatabaseConnection,
  DatabaseType,
  ManagedDatabaseCatalogEntry,
  ManagedDatabaseCreateInput,
  Node,
} from "@/types";
import {
  buildDatabasePayload,
  canCreateDatabase,
  type DatabaseConnectionDraft,
  DatabaseConnectionForm,
  draftFromConnection,
} from "./database-detail/DatabaseConnectionForm";
import {
  canDeployManagedDatabase,
  type ManagedDatabaseCapacity,
  managedDatabaseCapacity,
} from "./database-detail/managed-database-capacity";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

const DEFAULT_MANAGED_DATABASE_VERSIONS: Record<DatabaseType, string[]> = {
  postgres: ["17.5", "16.9"],
  redis: ["7.4.2", "7.2.8"],
  clickhouse: ["25.3.2.39", "24.8.14.39"],
};

const MANAGED_DATABASE_FORM_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

function catalogVersions(catalog: ManagedDatabaseCatalogEntry[], type: DatabaseType): string[] {
  return (
    catalog.find((entry) => entry.type === type)?.versions ??
    DEFAULT_MANAGED_DATABASE_VERSIONS[type]
  );
}

function defaultManagedDraft(
  catalog: ManagedDatabaseCatalogEntry[] = []
): ManagedDatabaseCreateInput {
  return {
    name: "",
    type: "postgres",
    version: catalogVersions(catalog, "postgres")[0]!,
    nodeId: "",
    storageSizeGb: 10,
    cpuCores: 1,
    memoryMb: 1024,
    swapMb: 0,
    publishTcp: false,
  };
}

const DATABASE_TAG_COLORS = {
  blue: "bg-blue-500/15 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
  red: "bg-red-500/15 text-red-600 dark:bg-red-500/15 dark:text-red-400",
  green: "bg-emerald-500/15 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  yellow: "bg-warning/15 text-warning-foreground",
  purple: "bg-violet-500/15 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  pink: "bg-pink-500/15 text-pink-600 dark:bg-pink-500/15 dark:text-pink-400",
  orange: "bg-orange-500/15 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
  gray: "bg-zinc-500/15 text-zinc-600 dark:bg-zinc-500/15 dark:text-zinc-300",
} as const;

type DatabaseTagColor = keyof typeof DATABASE_TAG_COLORS;

interface ParsedDatabaseTag {
  raw: string;
  label: string;
  color: DatabaseTagColor;
}

function parseDatabaseTag(raw: string): ParsedDatabaseTag {
  const trimmed = raw.trim();
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const color = trimmed.slice(0, colonIndex).toLowerCase();
    const label = trimmed.slice(colonIndex + 1).trim();
    if (color in DATABASE_TAG_COLORS && label) {
      return { raw, label, color: color as DatabaseTagColor };
    }
  }
  return { raw, label: trimmed, color: "blue" };
}

function estimateTagWidth(tag: ParsedDatabaseTag): number {
  return Math.min(180, Math.max(44, tag.label.length * 7 + 24));
}

function estimateMoreWidth(count: number): number {
  return 44 + String(count).length * 7;
}

function formatLastCheck(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString();
}

function formatHealthLabel(status: DatabaseConnection["healthStatus"] | "paused"): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function DatabaseTagSummary({ tags, type }: { tags: string[]; type: DatabaseConnection["type"] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const typeRef = useRef<HTMLSpanElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [typeWidth, setTypeWidth] = useState<number | null>(null);
  const parsedTags = useMemo(() => tags.map(parseDatabaseTag), [tags]);
  const visibleCount = useMemo(() => {
    if (parsedTags.length <= 2 && containerWidth === null) return parsedTags.length;
    if (containerWidth === null || containerWidth <= 0) return Math.min(2, parsedTags.length);

    const gapWidth = 8;
    const availableWidth = Math.max(0, containerWidth - (typeWidth ?? 0) - gapWidth);
    let usedWidth = 0;
    let count = 0;

    for (let index = 0; index < parsedTags.length; index += 1) {
      const remaining = parsedTags.length - index - 1;
      const tagWidth = estimateTagWidth(parsedTags[index]!);
      const moreWidth = remaining > 0 ? estimateMoreWidth(remaining) + gapWidth : 0;
      const nextWidth = usedWidth + (count > 0 ? gapWidth : 0) + tagWidth;
      if (nextWidth + moreWidth > availableWidth) break;
      usedWidth = nextWidth;
      count += 1;
    }

    return Math.max(1, count);
  }, [containerWidth, parsedTags, typeWidth]);

  useEffect(() => {
    const container = containerRef.current;
    const typeBadge = typeRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(container.getBoundingClientRect().width);
      if (typeBadge) setTypeWidth(typeBadge.getBoundingClientRect().width);
    });
    observer.observe(container);
    if (typeBadge) observer.observe(typeBadge);
    return () => observer.disconnect();
  }, []);

  const visibleTags = parsedTags.slice(0, visibleCount);
  const hiddenTags = parsedTags.slice(visibleCount);

  return (
    <div ref={containerRef} className="flex min-w-0 flex-1 items-center justify-end gap-2">
      <span ref={typeRef} className="inline-flex shrink-0">
        <Badge variant="secondary" className="uppercase">
          {type}
        </Badge>
      </span>
      {visibleTags.map((tag, index) => (
        <Badge
          key={`${tag.raw}:${index}`}
          variant="secondary"
          className={cn("max-w-[180px]", DATABASE_TAG_COLORS[tag.color])}
          title={tag.raw}
        >
          {tag.label}
        </Badge>
      ))}
      {hiddenTags.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="shrink-0">
              +{hiddenTags.length}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="flex flex-wrap gap-1.5">
              {hiddenTags.map((tag, index) => (
                <Badge
                  key={`${tag.raw}:${visibleCount + index}`}
                  variant="secondary"
                  className={cn("max-w-[180px]", DATABASE_TAG_COLORS[tag.color])}
                >
                  {tag.label}
                </Badge>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ManagedDatabaseCreateForm({
  draft,
  nodes,
  catalog,
  capacity,
  onChange,
}: {
  draft: ManagedDatabaseCreateInput;
  nodes: Node[];
  catalog: ManagedDatabaseCatalogEntry[];
  capacity: ManagedDatabaseCapacity;
  onChange: (draft: ManagedDatabaseCreateInput) => void;
}) {
  const set = <K extends keyof ManagedDatabaseCreateInput>(
    key: K,
    value: ManagedDatabaseCreateInput[K]
  ) => onChange({ ...draft, [key]: value });
  const versions = catalogVersions(catalog, draft.type);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Gateway provisions a private database on the selected databases node. The owner credentials
        are shown only once after creation.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-name">
            Name
          </label>
          <Input
            id="managed-db-name"
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Production database"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Engine</label>
          <Select
            value={draft.type}
            onValueChange={(value) => {
              const type = value as DatabaseType;
              onChange({ ...draft, type, version: catalogVersions(catalog, type)[0]! });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="postgres">Postgres</SelectItem>
              <SelectItem value="redis">Redis</SelectItem>
              <SelectItem value="clickhouse">ClickHouse</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-node">
            Databases node
          </label>
          <Select value={draft.nodeId} onValueChange={(value) => set("nodeId", value)}>
            <SelectTrigger id="managed-db-node">
              <SelectValue placeholder="Select node" />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((node) => (
                <SelectItem key={node.id} value={node.id}>
                  {node.displayName || node.hostname}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Curated version</label>
          <Select value={draft.version} onValueChange={(value) => set("version", value)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((version) => (
                <SelectItem key={version} value={version}>
                  {version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-storage">
            Storage (GB)
          </label>
          <Input
            id="managed-db-storage"
            type="number"
            min="1"
            max={capacity.storageSizeGb}
            value={draft.storageSizeGb}
            onChange={(event) => set("storageSizeGb", Number(event.target.value))}
          />
          {capacity.storageSizeGb !== undefined && (
            <p className="text-xs text-muted-foreground">
              Maximum available now: {capacity.storageSizeGb} GB
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-cpu">
            CPU cores
          </label>
          <Input
            id="managed-db-cpu"
            type="number"
            min="0.25"
            step="0.25"
            max={capacity.cpuCores}
            value={draft.cpuCores}
            onChange={(event) => set("cpuCores", Number(event.target.value))}
          />
          {capacity.cpuCores !== undefined && (
            <p className="text-xs text-muted-foreground">
              Maximum available: {capacity.cpuCores} cores
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-memory">
            Memory (MB)
          </label>
          <Input
            id="managed-db-memory"
            type="number"
            min="128"
            step="128"
            max={capacity.memoryMb}
            value={draft.memoryMb}
            onChange={(event) => set("memoryMb", Number(event.target.value))}
          />
          {capacity.memoryMb !== undefined && (
            <p className="text-xs text-muted-foreground">
              Maximum available now: {capacity.memoryMb} MB
            </p>
          )}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-swap">
            Swap (MB)
          </label>
          <Input
            id="managed-db-swap"
            type="number"
            min="0"
            step="128"
            max={capacity.swapMb}
            value={draft.swapMb}
            onChange={(event) => set("swapMb", Number(event.target.value))}
          />
          {capacity.swapMb !== undefined && (
            <p className="text-xs text-muted-foreground">
              Maximum available now: {capacity.swapMb} MB
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 border border-border p-3">
        <div>
          <p className="text-sm font-medium">Publish TCP endpoint</p>
          <p className="text-xs text-muted-foreground">
            Required only for clients outside Gateway. Native engine TLS is configured separately.
          </p>
        </div>
        <Switch
          checked={draft.publishTcp}
          onChange={(checked) =>
            onChange({
              ...draft,
              publishTcp: checked,
              ...(checked ? {} : { publishedPort: undefined }),
            })
          }
        />
      </div>
      {draft.publishTcp && (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-published-port">
            Host TCP port (optional)
          </label>
          <Input
            id="managed-db-published-port"
            type="number"
            min="1"
            max="65535"
            value={draft.publishedPort ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              set("publishedPort", value === "" ? undefined : Number(value));
            }}
            placeholder="Allocate automatically"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to allocate a free port on the database node. Gateway does not change host
            firewalls.
          </p>
        </div>
      )}
      {draft.type === "clickhouse" && (
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="managed-db-clickhouse-xml">
            Optional ClickHouse XML fragment
          </label>
          <Textarea
            id="managed-db-clickhouse-xml"
            value={draft.clickhouseConfigXml ?? ""}
            onChange={(event) => set("clickhouseConfigXml", event.target.value || undefined)}
            placeholder="&lt;clickhouse&gt;…&lt;/clickhouse&gt;"
          />
          <p className="text-xs text-muted-foreground">
            Security, networking and managed data paths cannot be overridden.
          </p>
        </div>
      )}
    </div>
  );
}

export function Databases({
  embedded = false,
  managedNodeId,
}: {
  embedded?: boolean;
  managedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, isLoading: authLoading } = useAuthStore();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "postgres" | "clickhouse" | "redis">("all");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "online" | "offline" | "degraded" | "unknown"
  >("all");
  const databaseCacheKey = useMemo(
    () =>
      managedNodeId
        ? `databases:managed-node:${managedNodeId}:${search}:${typeFilter}:${healthFilter}`
        : `databases:list:${search}:${typeFilter}:${healthFilter}`,
    [healthFilter, managedNodeId, search, typeFilter]
  );
  const [rows, setRows] = useState<DatabaseConnection[]>(() =>
    embedded
      ? []
      : (api.getCached<DatabaseConnection[]>("databases:list::all:all") ??
        api.getCached<DatabaseConnection[]>("databases:list") ??
        [])
  );
  const [loading, setLoading] = useState(
    () =>
      embedded ||
      (api.getCached<DatabaseConnection[]>("databases:list::all:all") === undefined &&
        api.getCached<DatabaseConnection[]>("databases:list") === undefined)
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [managedCreateOpen, setManagedCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DatabaseConnectionDraft>(draftFromConnection(null));
  const [managedDraft, setManagedDraft] = useState<ManagedDatabaseCreateInput>(defaultManagedDraft);
  const [managedCatalog, setManagedCatalog] = useState<ManagedDatabaseCatalogEntry[]>([]);
  const [databaseNodes, setDatabaseNodes] = useState<Node[]>([]);
  const [saving, setSaving] = useState(false);
  const [managedSaving, setManagedSaving] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);

  useEffect(() => {
    if (!(location.state as { createManagedDatabase?: boolean } | null)?.createManagedDatabase) {
      return;
    }
    setManagedCreateOpen(true);
    navigate(location.pathname, { replace: true, state: null });
  }, [location.pathname, location.state, navigate]);

  const load = useCallback(async () => {
    const cachedRows = api.getCached<DatabaseConnection[]>(databaseCacheKey);
    if (cachedRows) {
      setRows(cachedRows);
      setLoading(false);
    } else {
      setRows([]);
      setLoading(true);
    }
    try {
      if (managedNodeId) {
        const managed = await api.listManagedDatabases();
        const data = await Promise.all(
          managed
            .filter(
              (database) => database.nodeId === managedNodeId && database.databaseConnectionId
            )
            .map((database) => api.getDatabase(database.databaseConnectionId))
        );
        const filteredBySearch = data.filter(
          (database) =>
            (!search || database.name.toLowerCase().includes(search.toLowerCase())) &&
            (typeFilter === "all" || database.type === typeFilter) &&
            (healthFilter === "all" || database.healthStatus === healthFilter)
        );
        api.setCache(databaseCacheKey, filteredBySearch);
        setRows(filteredBySearch);
      } else {
        const result = await api.listDatabases({
          limit: 200,
          search: search || undefined,
          type: typeFilter === "all" ? undefined : typeFilter,
          healthStatus: healthFilter === "all" ? undefined : healthFilter,
        });
        api.setCache(databaseCacheKey, result.data);
        if (search === "" && typeFilter === "all" && healthFilter === "all") {
          api.setCache("databases:list", result.data);
        }
        setRows(result.data);
      }
      if (!embedded) {
        const [nodes, catalog] = await Promise.allSettled([
          api.listNodes({ type: "databases", status: "online", limit: 100 }),
          api.listManagedDatabaseCatalog(),
        ]);
        if (nodes.status === "fulfilled") setDatabaseNodes(nodes.value.data);
        if (catalog.status === "fulfilled") setManagedCatalog(catalog.value);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load databases");
    } finally {
      setLoading(false);
    }
  }, [databaseCacheKey, embedded, healthFilter, managedNodeId, search, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate = !embedded && hasScope("databases:create");
  const canManageFolders = !embedded && hasScope("databases:folders:manage");

  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          hasScopedAccess("databases:view") &&
          (hasScope("databases:view") || hasScope(`databases:view:${row.id}`))
      ),
    [hasScope, hasScopedAccess, rows]
  );

  const managedVersions = useMemo(
    () => catalogVersions(managedCatalog, managedDraft.type),
    [managedCatalog, managedDraft.type]
  );
  const managedCapacity = useMemo(
    () => managedDatabaseCapacity(databaseNodes.find((node) => node.id === managedDraft.nodeId)),
    [databaseNodes, managedDraft.nodeId]
  );
  const canDeployManaged = useMemo(
    () => canDeployManagedDatabase(managedDraft, managedVersions, managedCapacity),
    [managedCapacity, managedDraft, managedVersions]
  );

  const save = async () => {
    setSaving(true);
    try {
      const created = await api.createDatabase(buildDatabasePayload(draft));
      toast.success("Database connection created");
      setCreateOpen(false);
      setDraft(draftFromConnection(null));
      navigate(databaseRoute(created.slug, "overview"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create database connection");
    } finally {
      setSaving(false);
    }
  };

  const saveManaged = async () => {
    if (!canDeployManaged) {
      toast.error("Complete the managed database settings with valid resource limits");
      return;
    }
    setManagedSaving(true);
    try {
      const created = await api.createManagedDatabase(managedDraft);
      toast.success("Managed database provisioning started");
      setManagedCreateOpen(false);
      setManagedDraft(defaultManagedDraft(managedCatalog));
      const database = await api.getDatabase(created.databaseConnectionId);
      navigate(databaseRoute(database.slug, "overview"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create managed database");
    } finally {
      setManagedSaving(false);
    }
  };

  const columns = useMemo<ResourceListColumn<DatabaseConnection>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: "38%",
        renderCell: (row) => {
          const Icon = row.managed ? ServerCog : DatabaseIcon;

          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-muted">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.host}:{row.port}
                  {row.databaseName ? ` · ${row.databaseName}` : ""}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "tags",
        label: "Tags",
        width: "34%",
        align: "right",
        renderCell: (row) => <DatabaseTagSummary tags={row.tags} type={row.type} />,
      },
      {
        id: "lastCheck",
        label: "Last Check",
        width: "14%",
        align: "center",
        renderCell: (row) => (
          <Badge variant="outline">{formatLastCheck(row.lastHealthCheckAt)}</Badge>
        ),
      },
      {
        id: "health",
        label: "Health",
        width: "14%",
        align: "center",
        renderCell: (row) => (
          <Badge
            variant={
              HEALTH_BADGE[row.managed?.status === "paused" ? "paused" : row.healthStatus] ??
              "secondary"
            }
          >
            {formatHealthLabel(row.managed?.status === "paused" ? "paused" : row.healthStatus)}
          </Badge>
        ),
      },
    ],
    []
  );

  return (
    <PageTransition>
      <div className={embedded ? "space-y-4" : "h-full overflow-y-auto p-6 space-y-4"}>
        {!embedded && (
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <LiteModeBackButton />
              <div>
                <h1 className="text-2xl font-bold">Databases</h1>
                <p className="text-sm text-muted-foreground">
                  Saved PostgreSQL, ClickHouse, and Redis connections managed through Gateway
                </p>
              </div>
            </div>
            <ResponsiveHeaderActions
              actions={[
                {
                  label: "Refresh",
                  icon: <RefreshCw className="h-4 w-4" />,
                  onClick: () => void load(),
                },
                ...(canManageFolders && createFolderAction
                  ? [
                      {
                        label: "Add Folder",
                        icon: <FolderPlus className="h-4 w-4" />,
                        onClick: createFolderAction,
                      },
                    ]
                  : []),
                ...(canCreate
                  ? [
                      {
                        label: "Deploy managed database",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => setManagedCreateOpen(true),
                      },
                      {
                        label: "Connect existing database",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => setCreateOpen(true),
                      },
                    ]
                  : []),
              ]}
            >
              <Button variant="outline" size="icon" onClick={() => void load()} title="Refresh">
                <RefreshCw className="h-4 w-4" />
              </Button>
              {canManageFolders && (
                <Button variant="outline" onClick={() => createFolderAction?.()}>
                  <FolderPlus className="h-4 w-4" />
                  Add Folder
                </Button>
              )}
              {canCreate && (
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Connect existing
                </Button>
              )}
              {canCreate && (
                <Button onClick={() => setManagedCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Deploy database
                </Button>
              )}
            </ResponsiveHeaderActions>
          </div>
        )}

        <FolderedResourceList<DatabaseConnection>
          resourceType="database"
          realtimeChannel="database.folder.changed"
          resources={filtered}
          columns={columns}
          search={{
            placeholder: "Search databases...",
            search,
            onSearchChange: setSearch,
            onSearchSubmit: () => void load(),
            hasActiveFilters: search !== "" || typeFilter !== "all" || healthFilter !== "all",
            onReset: () => {
              setSearch("");
              setTypeFilter("all");
              setHealthFilter("all");
            },
            filters: (
              <>
                <Select
                  value={typeFilter}
                  onValueChange={(value) => setTypeFilter(value as typeof typeFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="postgres">Postgres</SelectItem>
                    <SelectItem value="clickhouse">ClickHouse</SelectItem>
                    <SelectItem value="redis">Redis</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={healthFilter}
                  onValueChange={(value) => setHealthFilter(value as typeof healthFilter)}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Health" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All health states</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                    <SelectItem value="degraded">Degraded</SelectItem>
                    <SelectItem value="offline">Offline</SelectItem>
                    <SelectItem value="unknown">Unknown</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ),
          }}
          loading={loading || authLoading}
          loadingLabel="Loading databases..."
          emptyState={
            <EmptyState
              message="No databases yet. Connect an existing database or deploy a managed instance."
              {...(canCreate
                ? { actionLabel: "Connect existing database", onAction: () => setCreateOpen(true) }
                : {})}
              hasActiveFilters={search !== "" || typeFilter !== "all" || healthFilter !== "all"}
              onReset={() => {
                setSearch("");
                setTypeFilter("all");
                setHealthFilter("all");
              }}
            />
          }
          minWidth={920}
          canManageFolders={canManageFolders}
          canViewItem={(row) => hasScope("databases:view") || hasScope(`databases:view:${row.id}`)}
          canReorganizeItem={() => canManageFolders}
          getResourceLabel={(row) => row.name}
          onItemClick={(row) => navigate(databaseRoute(row.slug, "overview"))}
          onRefresh={() => load()}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />
      </div>

      {!embedded && (
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Add Database</DialogTitle>
            </DialogHeader>
            <AnimatedHeight>
              <DatabaseConnectionForm draft={draft} onChange={setDraft} />
            </AnimatedHeight>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving || !canCreateDatabase(draft)}>
                {saving ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {!embedded && (
        <Dialog open={managedCreateOpen} onOpenChange={setManagedCreateOpen}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Deploy managed database</DialogTitle>
            </DialogHeader>
            <AnimatedHeight>
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${managedDraft.type}:${managedDraft.publishTcp ? "tcp" : "private"}`}
                  {...MANAGED_DATABASE_FORM_ANIMATION}
                >
                  <ManagedDatabaseCreateForm
                    draft={managedDraft}
                    nodes={databaseNodes}
                    catalog={managedCatalog}
                    capacity={managedCapacity}
                    onChange={setManagedDraft}
                  />
                </motion.div>
              </AnimatePresence>
            </AnimatedHeight>
            <DialogFooter>
              <Button variant="outline" onClick={() => setManagedCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => void saveManaged()}
                disabled={managedSaving || !canDeployManaged}
              >
                {managedSaving ? "Deploying..." : "Deploy database"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </PageTransition>
  );
}
