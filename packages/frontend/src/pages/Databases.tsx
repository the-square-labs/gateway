import { Database as DatabaseIcon, FolderPlus, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { databaseRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import type { DatabaseConnection } from "@/types";
import {
  buildDatabasePayload,
  type DatabaseConnectionDraft,
  DatabaseConnectionForm,
  draftFromConnection,
} from "./database-detail/DatabaseConnectionForm";

const HEALTH_BADGE: Record<string, "success" | "secondary" | "warning" | "destructive"> = {
  online: "success",
  degraded: "warning",
  offline: "destructive",
  unknown: "secondary",
};

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

function formatHealthLabel(status: DatabaseConnection["healthStatus"]): string {
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

export function Databases() {
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess, isLoading: authLoading } = useAuthStore();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "postgres" | "redis">("all");
  const [healthFilter, setHealthFilter] = useState<
    "all" | "online" | "offline" | "degraded" | "unknown"
  >("all");
  const databaseCacheKey = useMemo(
    () => `databases:list:${search}:${typeFilter}:${healthFilter}`,
    [healthFilter, search, typeFilter]
  );
  const [rows, setRows] = useState<DatabaseConnection[]>(
    () =>
      api.getCached<DatabaseConnection[]>("databases:list::all:all") ??
      api.getCached<DatabaseConnection[]>("databases:list") ??
      []
  );
  const [loading, setLoading] = useState(
    () =>
      api.getCached<DatabaseConnection[]>("databases:list::all:all") === undefined &&
      api.getCached<DatabaseConnection[]>("databases:list") === undefined
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DatabaseConnectionDraft>(draftFromConnection(null));
  const [saving, setSaving] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);

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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load databases");
    } finally {
      setLoading(false);
    }
  }, [databaseCacheKey, healthFilter, search, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate = hasScope("databases:create");
  const canManageFolders = hasScope("databases:folders:manage");

  const filtered = useMemo(
    () =>
      rows.filter(
        (row) =>
          hasScopedAccess("databases:view") &&
          (hasScope("databases:view") || hasScope(`databases:view:${row.id}`))
      ),
    [hasScope, hasScopedAccess, rows]
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

  const columns = useMemo<ResourceListColumn<DatabaseConnection>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: "38%",
        renderCell: (row) => (
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-muted">
              <DatabaseIcon className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{row.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {row.host}:{row.port}
                {row.databaseName ? ` · ${row.databaseName}` : ""}
              </p>
            </div>
          </div>
        ),
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
          <Badge variant={HEALTH_BADGE[row.healthStatus] ?? "secondary"}>
            {formatHealthLabel(row.healthStatus)}
          </Badge>
        ),
      },
    ],
    []
  );

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Databases</h1>
              <p className="text-sm text-muted-foreground">
                Saved Postgres and Redis connections managed through Gateway
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
                      label: "Add Database",
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
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" />
                Add Database
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

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
          loadingLabel="Loading database connections..."
          emptyState={
            <EmptyState
              message="No databases. Add a Postgres or Redis connection to manage it through Gateway."
              {...(canCreate
                ? { actionLabel: "Add Database", onAction: () => setCreateOpen(true) }
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Database</DialogTitle>
          </DialogHeader>
          <DatabaseConnectionForm draft={draft} onChange={setDraft} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
