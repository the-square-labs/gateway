import { AnimatePresence, motion } from "framer-motion";
import { Database as DatabaseIcon, DatabaseZap, FolderPlus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtime } from "@/hooks/use-realtime";
import { nodeIconClassNames } from "@/lib/node-appearance";
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
import { ClickHouseConfigField } from "./database-detail/ClickHouseConfigField";
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
  postgres: ["18.4", "18.3", "17.10", "17.8", "16.14", "16.10", "15.18", "15.14", "14.23", "14.19"],
  redis: ["8.10.0", "8.8.1", "8.6.5", "8.4.5", "8.2.8", "7.4.10", "7.2.12", "6.2.20"],
  clickhouse: [
    "26.7.1.1315",
    "26.6.2.81",
    "26.5.6.64",
    "26.4.5.143",
    "26.3.17.56",
    "25.8.28.1",
    "25.3.8.23",
    "24.8.14.39",
    "24.3.18.7",
  ],
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
    tlsEnabled: true,
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
              onChange({
                ...draft,
                type,
                version: catalogVersions(catalog, type)[0]!,
                ...(type === "clickhouse"
                  ? { publishNativeTcp: draft.publishNativeTcp ?? true }
                  : { publishNativeTcp: undefined, publishedNativePort: undefined }),
              });
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
      <PanelShell
        title="Publish TCP port"
        description="Enables direct network connections in addition to secure managed links."
        headerBorder={draft.publishTcp}
        actions={
          <Switch
            checked={draft.publishTcp}
            onChange={(checked) =>
              onChange({
                ...draft,
                publishTcp: checked,
                ...(checked
                  ? {}
                  : {
                      publishedPort: undefined,
                      publishNativeTcp: false,
                      publishedNativePort: undefined,
                    }),
              })
            }
            ariaLabel="Publish TCP port"
          />
        }
      >
        <AnimatePresence initial={false} mode="popLayout">
          {draft.publishTcp && (
            <motion.div key="published-tcp-settings" {...MANAGED_DATABASE_FORM_ANIMATION}>
              <SettingsControlRow
                title="Published TCP port"
                description="Leave empty to let Docker allocate a free port. Gateway does not change host firewalls."
              >
                <Input
                  id="managed-db-published-port"
                  aria-label="Published TCP port"
                  type="number"
                  min="1"
                  max="65535"
                  value={draft.publishedPort ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    set("publishedPort", value === "" ? undefined : Number(value));
                  }}
                  placeholder="Automatic"
                />
              </SettingsControlRow>
              {draft.type === "clickhouse" && (
                <>
                  <SettingsControlRow
                    title="Publish native TCP port"
                    description="Expose the ClickHouse native protocol for native clients."
                  >
                    <Switch
                      checked={draft.publishNativeTcp ?? true}
                      onChange={(checked) =>
                        onChange({
                          ...draft,
                          publishNativeTcp: checked,
                          ...(checked ? {} : { publishedNativePort: undefined }),
                        })
                      }
                      ariaLabel="Publish native TCP port"
                    />
                  </SettingsControlRow>
                  {(draft.publishNativeTcp ?? true) && (
                    <SettingsControlRow
                      title="Native TCP port"
                      description="Leave empty to let Docker allocate a free port."
                    >
                      <Input
                        aria-label="Native TCP port"
                        type="number"
                        min="1"
                        max="65535"
                        value={draft.publishedNativePort ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          set("publishedNativePort", value === "" ? undefined : Number(value));
                        }}
                        placeholder="Automatic"
                      />
                    </SettingsControlRow>
                  )}
                </>
              )}
              <SettingsControlRow
                title="TLS"
                description="Encrypt direct database traffic. Secure managed links always remain encrypted."
              >
                <Switch
                  checked={draft.tlsEnabled ?? true}
                  onChange={(checked) => set("tlsEnabled", checked)}
                  ariaLabel="Enable TLS"
                />
              </SettingsControlRow>
            </motion.div>
          )}
        </AnimatePresence>
      </PanelShell>
      {draft.type === "clickhouse" && (
        <div className="space-y-2">
          <ClickHouseConfigField
            label="Optional ClickHouse XML fragment"
            value={draft.clickhouseConfigXml ?? ""}
            onChange={(value) => set("clickhouseConfigXml", value || undefined)}
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
      const [nodes, catalog] = await Promise.allSettled([
        api.listNodes({ type: "databases", limit: 100 }),
        embedded
          ? Promise.resolve([] as ManagedDatabaseCatalogEntry[])
          : api.listManagedDatabaseCatalog(),
      ]);
      if (nodes.status === "fulfilled") setDatabaseNodes(nodes.value.data);
      if (catalog.status === "fulfilled") setManagedCatalog(catalog.value);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load databases");
    } finally {
      setLoading(false);
    }
  }, [databaseCacheKey, embedded, healthFilter, managedNodeId, search, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(hasScopedAccess("nodes:details") ? "node.changed" : null, () => {
    void api
      .listNodes({ type: "databases", limit: 100 })
      .then((result) => setDatabaseNodes(result.data))
      .catch(() => undefined);
  });

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
  const databaseNodeById = useMemo(
    () => new Map(databaseNodes.map((node) => [node.id, node])),
    [databaseNodes]
  );
  const deployableDatabaseNodes = useMemo(
    () => databaseNodes.filter((node) => node.status === "online" && node.isConnected),
    [databaseNodes]
  );
  const selectedDeployableDatabaseNode = useMemo(
    () => deployableDatabaseNodes.find((node) => node.id === managedDraft.nodeId),
    [deployableDatabaseNodes, managedDraft.nodeId]
  );
  const managedCapacity = useMemo(
    () => managedDatabaseCapacity(selectedDeployableDatabaseNode),
    [selectedDeployableDatabaseNode]
  );
  const canDeployManaged = useMemo(
    () =>
      !!selectedDeployableDatabaseNode &&
      canDeployManagedDatabase(managedDraft, managedVersions, managedCapacity),
    [managedCapacity, managedDraft, managedVersions, selectedDeployableDatabaseNode]
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
          const Icon = row.managed ? DatabaseZap : DatabaseIcon;
          const node = row.managed ? databaseNodeById.get(row.managed.nodeId) : undefined;
          const iconClassNames = nodeIconClassNames(node?.appearanceColor);

          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Icon className={cn("h-5 w-5", iconClassNames.icon)} />
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
        renderCell: (row) => {
          const node = row.managed ? databaseNodeById.get(row.managed.nodeId) : undefined;
          if (node && (node.status !== "online" || !node.isConnected)) {
            return <Badge variant="secondary">Unavailable</Badge>;
          }
          const status = row.managed?.status === "paused" ? "paused" : row.healthStatus;
          return (
            <Badge variant={HEALTH_BADGE[status] ?? "secondary"}>{formatHealthLabel(status)}</Badge>
          );
        },
      },
    ],
    [databaseNodeById]
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
              <ManagedDatabaseCreateForm
                draft={managedDraft}
                nodes={deployableDatabaseNodes}
                catalog={managedCatalog}
                capacity={managedCapacity}
                onChange={setManagedDraft}
              />
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
